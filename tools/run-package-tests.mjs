#!/usr/bin/env node
/**
 * 在每个 workspace 包各自的进程里运行它的 Node 测试，并汇总结果。
 *
 * 为什么需要它：根 `pnpm -r run test` 依赖 pnpm，而 `pnpm run <script>` 会先做一次
 * 依赖状态检查；在依赖树不完整或受限环境里该检查会失败，导致"一条命令跑全部测试"
 * 跑不起来。本脚本直接读 `pnpm-workspace.yaml` 枚举包，绕开 pnpm 的脚本层。
 *
 * 子进程输出以文件描述符捕获（需要读取 TAP 计数，而受限环境拒绝管道 stdio）。
 * 每个包一个进程意味着包之间天然隔离：某个包遗留的悬挂异步不会污染其他包。
 *
 * 成败判定用 TAP 的 `# fail` 计数而不是退出码：进程内隔离（`--experimental-test-isolation=none`）
 * 下，真实 Agent Loop 用例会被父级取消，退出码随之非零，但 `# fail` 仍是 0。只有
 * `# fail > 0`、或完全没有 TAP 计数（加载失败／spawn 失败）才算失败。
 *
 * 取消不再掩盖失败：进程内隔离会把「被父级取消的用例」之后的同批次用例一并取消，
 * 于是同批次后续的真实失败不会出现在计数里。因此
 *
 *   - 根级测试始终逐文件执行；
 *   - 任何目标一旦出现取消，就用同一批测试文件逐文件复核，并用复核结果替换该目标的计数。
 *
 * 跳过也必须登记：运行时跳过数会与 `docs/known-limitations.md` 的测试跳过登记表
 * 逐范围比对（静态一侧见 `tools/check-test-skips.mjs`），任何未登记的跳过都会让本命令失败。
 *
 * 用法：
 *   node tools/run-package-tests.mjs                        # 全部包
 *   node tools/run-package-tests.mjs rp-core rp-standard    # 只跑指定包
 *   node tools/run-package-tests.mjs --no-isolation-flags   # 不追加额外 node 参数
 */

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import { expectedRuntimeSkips, loadKnownLimitations } from './lib/known-limitations.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const wanted = new Set(process.argv.slice(2).filter(arg => !arg.startsWith('--')))
const useIsolationFlags = !process.argv.includes('--no-isolation-flags')

/**
 * `--experimental-test-isolation=none` 让测试运行器在当前进程内执行测试文件，
 * 因而不再需要为每个文件托管子进程。受限环境下子进程托管会被拒绝，所以本环境
 * 必须带上它；具备真实 `spawn` 能力时可用 `--no-isolation-flags` 去掉。
 */
const NODE_FLAGS = useIsolationFlags ? ['--experimental-test-isolation=none'] : []

/**
 * 根级（不属于任何包）的 Node 测试，对应根 `package.json` 的 `test:compat`、`test:dev`。
 *
 * 与包测试放在同一个进程 orchestration 里跑，使 `pnpm test:local` 真正"一条命令跑全部"。
 */
const ROOT_TEST_SCRIPTS = ['test:compat', 'test:dev']

/**
 * 从根清单的脚本里提取要传给 `node --test` 的文件列表。
 *
 * @returns {string[]} 测试文件路径（相对仓库根）。
 */
function rootTestFiles() {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  const files = []
  for (const name of ROOT_TEST_SCRIPTS) {
    const script = manifest.scripts?.[name]
    if (typeof script !== 'string') continue
    const match = /^node --test\s+(.*)$/.exec(script.trim())
    if (match === null) continue
    files.push(...match[1].trim().split(/\s+/))
  }
  return files
}

/** 按 `pnpm-workspace.yaml` 的 glob 枚举包目录。 */
function collectPackages() {
  const workspace = parseYaml(readFileSync(join(projectRoot, 'pnpm-workspace.yaml'), 'utf8'))
  const packages = []
  for (const pattern of workspace.packages ?? []) {
    const [parent, child] = String(pattern).split('/')
    if (child !== '*') continue
    let entries
    try {
      entries = readdirSync(join(projectRoot, parent), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) packages.push({ name: entry.name, directory: join(projectRoot, parent, entry.name) })
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 读取包清单，解析出其中的 Node 测试命令。
 *
 * 脚本可能是复合命令，例如 `pnpm run test:node && vitest run …` 或
 * `node --test … && vitest run …`。这里只取 `node --test` 那一段：客户端测试
 * 需要 vitest 的 worker 进程，在受限环境里起不来（`spawn EPERM`），属于环境边界。
 *
 * @param {string} packageDirectory 包目录。
 * @returns {string | undefined} 传给 `node --test` 的参数（可能为空字符串），无 Node 测试时 undefined。
 */
function testArguments(packageDirectory) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  const candidates = [manifest.scripts?.['test:node'], manifest.scripts?.test]
  for (const script of candidates) {
    if (typeof script !== 'string') continue
    for (const segment of script.split('&&')) {
      const match = /^node --test(?:\s+(.*))?$/.exec(segment.trim())
      if (match === null) continue
      return (match[1] ?? '').trim()
    }
  }
  return undefined
}

/**
 * 从 TAP 输出汇总 `# key value` 计数。
 *
 * @param {string} output 子进程输出。
 * @returns {{ tests: number, pass: number, fail: number, cancelled: number, skipped: number }}
 */
function parseTotals(output) {
  const totals = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0 }
  for (const match of output.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)) {
    totals[match[1]] = Number(match[2])
  }
  return totals
}

const selected = collectPackages().filter(entry => wanted.size === 0 || wanted.has(entry.name))

process.stdout.write(
  `运行 ${selected.length} 个包的 Node 测试${useIsolationFlags ? '（进程内隔离）' : ''}。\n`,
)
if (useIsolationFlags) {
  process.stdout.write(
    '注意：进程内隔离下，真实 Agent Loop 用例可能被父级取消而报非零退出码，'
    + '因此本脚本以 TAP 的 `# fail` 计数判定成败，而非退出码。\n',
  )
}
process.stdout.write('\n')

/**
 * 在指定目录里跑一组 Node 测试并解析结果。
 *
 * 以文件描述符而非管道捕获输出：受限环境会拒绝管道 stdio（`spawn EPERM`），而文件
 * 句柄放行。因此输出先落到临时文件，再读回来解析 TAP 计数。
 *
 * 成败以 TAP 的 `# fail` 判定而不是退出码：进程内隔离下被父级取消的用例会把退出码
 * 置为非零，但 `# fail` 仍是 0。只有 `# fail > 0`、或完全没有 TAP 计数（加载失败／
 * spawn 失败）才算失败。
 *
 * @param {{ name: string, directory: string, args: string[] }} target 运行目标。
 * @returns {object} 含 totals、error、succeeded、output 的结果记录。
 */
function runTarget(target) {
  const logPath = join(tmpdir(), `dsh-node-tests-${target.name.replaceAll(/[^\w.-]/g, '_')}-${process.pid}.log`)
  const fd = openSync(logPath, 'w')
  let result
  try {
    result = spawnSync(
      process.execPath,
      ['--test', ...NODE_FLAGS, ...target.args],
      { cwd: target.directory, stdio: ['ignore', fd, fd] },
    )
  } finally {
    closeSync(fd)
  }

  let output = ''
  try {
    output = readFileSync(logPath, 'utf8')
  } catch {
    output = ''
  }
  rmSync(logPath, { force: true })

  const totals = parseTotals(output)
  const succeeded = result.error === undefined && totals.fail === 0 && totals.tests > 0
  return { name: target.name, totals, status: result.status, error: result.error, succeeded, output }
}

/** 打印一行结果摘要。 */
function report(record) {
  process.stdout.write(
    `${record.succeeded ? 'ok  ' : 'FAIL'}  ${record.name.padEnd(24)} `
    + `tests ${record.totals.tests}, pass ${record.totals.pass}, fail ${record.totals.fail}`
    + `, skipped ${record.totals.skipped}`
    + `${record.totals.cancelled > 0 ? `, cancelled ${record.totals.cancelled}` : ''}`
    + `${record.perFileRecheck ? '（已逐文件复核）' : ''}\n`,
  )
}

/** Node 默认发现的测试文件模式：`node --test` 不带路径时使用（`?(c|m)js` 即 js/cjs/mjs）。 */
const DEFAULT_TEST_PATTERNS = [
  /\.test\.[cm]?js$/,
  /-test\.[cm]?js$/,
  /_test\.[cm]?js$/,
  /(?:^|\/)test-[^/]*\.[cm]?js$/,
  /(?:^|\/)test\.[cm]?js$/,
  /(?:^|\/)test\/.*\.[cm]?js$/,
]

/** 一次性实现 Node 的默认测试文件发现，用于逐文件复核不带路径的目标。 */
function discoverTestFiles(directory) {
  const files = []
  const visit = (dir, relativeDir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        visit(join(dir, entry.name), relativePath)
        continue
      }
      if (DEFAULT_TEST_PATTERNS.some(pattern => pattern.test(relativePath))) files.push(relativePath)
    }
  }
  visit(directory, '')
  return files.sort()
}

/** 把一个测试参数展开成具体文件列表；无法展开的模式会让调用方报错。 */
function expandTestFiles(directory, args) {
  if (args.length === 0) return discoverTestFiles(directory)
  const files = []
  for (const arg of args) {
    if (!arg.includes('*') && !arg.includes('?')) {
      files.push(arg)
      continue
    }
    const separator = arg.lastIndexOf('/')
    const dir = separator === -1 ? '.' : arg.slice(0, separator)
    const pattern = separator === -1 ? arg : arg.slice(separator + 1)
    const matcher = new RegExp(`^${pattern.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]')}$`)
    const matched = readdirSync(join(directory, dir), { withFileTypes: true })
      .filter(entry => entry.isFile() && matcher.test(entry.name))
      .map(entry => (dir === '.' ? entry.name : `${dir}/${entry.name}`))
      .sort()
    if (matched.length === 0) throw new Error(`${directory}: 测试参数「${arg}」没有匹配到任何文件`)
    files.push(...matched)
  }
  return files
}

/** 合并多个逐文件结果。 */
function aggregateRecords(name, records) {
  const totals = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0 }
  for (const record of records) {
    for (const key of Object.keys(totals)) totals[key] += record.totals[key]
  }
  const error = records.find(record => record.error !== undefined)?.error
  const outputs = records.filter(record => !record.succeeded).map(record => record.output).join('\n')
  return {
    name,
    totals,
    status: records.every(record => record.status === 0) ? 0 : 1,
    error,
    // 逐文件复核后，成败只看每个文件自己的 `# fail`。
    succeeded: error === undefined && totals.fail === 0 && totals.tests > 0,
    output: outputs,
  }
}

/**
 * 运行一个目标；出现取消时逐文件复核，避免「取消掩盖同批次后续失败」。
 *
 * @param {{ name: string, directory: string, args: string[], perFile?: boolean }} target 运行目标。
 * @returns {object} 结果记录（可能带 `perFileRecheck`）。
 */
function runScope(target) {
  const files = expandTestFiles(target.directory, target.args)
  // 没有任何测试文件时交给 node 自己的发现逻辑，保持与裸 `node --test` 一致。
  if (files.length === 0) return runTarget(target)
  if (target.perFile === true || files.length === 1) {
    const records = files.map(file => runTarget({ ...target, args: [file] }))
    const aggregated = aggregateRecords(target.name, records)
    return target.perFile === true ? { ...aggregated, perFileRecheck: true } : aggregated
  }
  const batch = runTarget(target)
  if (batch.totals.cancelled === 0) return batch
  const records = files.map(file => runTarget({ ...target, args: [file] }))
  return { ...aggregateRecords(target.name, records), perFileRecheck: true }
}

/** 一个目标对应的登记范围键（`plugins/<名>`、`packages/<名>`、`root`）。 */
function scopeOfTarget(target) {
  if (target.scope !== undefined) return target.scope
  for (const group of ['plugins', 'packages']) {
    if (target.directory.startsWith(`${join(projectRoot, group)}${sep}`)) return `${group}/${target.name}`
  }
  return 'root'
}

const registry = loadKnownLimitations(projectRoot)
const skipProblems = [...registry.problems]
const skipChecked = new Set()

/** 校验一个目标的运行时跳过数是否与登记表一致。 */
function checkSkippedAgainstRegistry(target, record) {
  const scope = scopeOfTarget(target)
  skipChecked.add(scope)
  const expected = expectedRuntimeSkips(registry.skipRows, scope)
  if (record.totals.skipped !== expected) {
    skipProblems.push(
      `${record.name}: 运行时跳过 ${record.totals.skipped} 个用例，登记表声明 ${expected} 个`
      + '（见 docs/known-limitations.md 的测试跳过登记表）',
    )
  }
}

/** 跑一组目标并逐条报告。 */
function runTargets(targets) {
  const records = []
  for (const target of targets) {
    process.stdout.write(`--- ${target.label ?? target.name} ---\n`)
    const record = runScope(target)
    records.push({ target, record })
    report(record)
    checkSkippedAgainstRegistry(target, record)
  }
  return records
}

// 根级测试（不属于任何包的 tools/scripts 用例）先跑，`pnpm test:local` 才算"一条命令跑全部"。
// 逐文件执行：一个需要真实子进程的用例被取消时，同批次后续用例会被一并取消，真实失败就消失了。
const rootFiles = rootTestFiles()
const rootRecords = rootFiles.length === 0
  ? []
  : runTargets(rootFiles.map(file => ({
      name: 'root',
      label: `根级测试 · ${file}`,
      scope: 'root',
      directory: projectRoot,
      args: [file],
    })))

const packageRecords = runTargets(collectPackages()
  .filter(entry => wanted.size === 0 || wanted.has(entry.name))
  .flatMap(entry => {
    const args = testArguments(entry.directory)
    if (args === undefined) return []
    return [{
      name: entry.name,
      label: entry.name,
      directory: entry.directory,
      args: args === '' ? [] : args.split(/\s+/),
    }]
  }))

const records = [...rootRecords, ...packageRecords].map(entry => entry.record)
const failed = records.filter(entry => !entry.succeeded)
const totalTests = records.reduce((sum, entry) => sum + entry.totals.tests, 0)
const totalPass = records.reduce((sum, entry) => sum + entry.totals.pass, 0)
const totalSkipped = records.reduce((sum, entry) => sum + entry.totals.skipped, 0)
const totalCancelled = records.reduce((sum, entry) => sum + entry.totals.cancelled, 0)

process.stdout.write(
  `\n===== 汇总 =====\n运行 ${records.length} 个包，测试 ${totalTests} 个，`
  + `通过 ${totalPass}，跳过 ${totalSkipped}`
  + `${totalCancelled > 0 ? `，被父级取消 ${totalCancelled}` : ''}，失败包 ${failed.length} 个。\n`,
)
if (totalSkipped > 0 && skipProblems.length === 0) {
  process.stdout.write(
    `跳过用例已与 docs/known-limitations.md 的测试跳过登记表逐范围比对一致`
    + `（${skipChecked.size} 个运行范围；静态复核：node tools/check-test-skips.mjs）。\n`,
  )
}
if (totalCancelled > 0) {
  process.stdout.write(
    '被父级取消的用例由本机进程内隔离导致（默认每文件隔离在本机报 spawn EPERM）；'
    + '出现取消的目标已逐文件复核，取消之后的失败不会被掩盖。\n',
  )
}

for (const entry of failed) {
  process.stderr.write(`\n===== ${entry.name} =====\n`)
  process.stderr.write(entry.error === undefined
    ? `${entry.output.trimEnd()}\n`
    : `spawn failed: ${entry.error.code ?? entry.error.message}\n`)
}

if (skipProblems.length > 0) {
  process.stderr.write(`\n===== 跳过登记 =====\n- ${skipProblems.join('\n- ')}\n`)
}

if (failed.length > 0 || skipProblems.length > 0) process.exitCode = 1
