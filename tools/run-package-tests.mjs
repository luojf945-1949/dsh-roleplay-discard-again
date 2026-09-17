#!/usr/bin/env node
/**
 * 在每个 workspace 包各自的进程里运行它的 Node 测试，并汇总结果。
 *
 * 为什么需要它：根 `pnpm -r run test` 依赖 pnpm，而 `pnpm run <script>` 会先做一次
 * 依赖状态检查；在依赖树不完整或受限环境里该检查会失败，导致"一条命令跑全部测试"
 * 跑不起来。本脚本直接读 `pnpm-workspace.yaml` 枚举包，绕开 pnpm 的脚本层。
 *
 * 子进程输出以管道捕获（需要读取 TAP 计数）。

 * 每个包一个进程意味着包之间天然隔离：某个包遗留的悬挂异步不会污染其他包。
 *
 * 成败判定用 TAP 的 `# fail` 计数而不是退出码：进程内隔离（`--experimental-test-isolation=none`）
 * 下，真实 Agent Loop 用例会被父级取消，退出码随之非零，但 `# fail` 仍是 0。只有
 * `# fail > 0`、或完全没有 TAP 计数（加载失败／spawn 失败）才算失败。
 *
 * 用法：
 *   node tools/run-package-tests.mjs                        # 全部包
 *   node tools/run-package-tests.mjs rp-core rp-standard    # 只跑指定包
 *   node tools/run-package-tests.mjs --no-isolation-flags   # 不追加额外 node 参数
 */

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parse as parseYaml } from 'yaml'

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
const results = []

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
    + `${record.totals.cancelled > 0 ? `, cancelled ${record.totals.cancelled}` : ''}\n`,
  )
}

// 根级测试（不属于任何包的 tools/scripts 用例）先跑，`pnpm test:local` 才算"一条命令跑全部"。
const rootFiles = rootTestFiles()
if (rootFiles.length > 0) {
  process.stdout.write('--- 根级测试 ---\n')
  const record = runTarget({ name: 'root', directory: projectRoot, args: rootFiles })
  results.push(record)
  report(record)
}

for (const entry of selected) {
  const args = testArguments(entry.directory)
  if (args === undefined) continue
  process.stdout.write(`--- ${entry.name} ---\n`)
  const record = runTarget({
    name: entry.name,
    directory: entry.directory,
    args: args === '' ? [] : args.split(/\s+/),
  })
  results.push(record)
  report(record)
}

const failed = results.filter(entry => !entry.succeeded)
const totalTests = results.reduce((sum, entry) => sum + entry.totals.tests, 0)
const totalPass = results.reduce((sum, entry) => sum + entry.totals.pass, 0)
const totalSkipped = results.reduce((sum, entry) => sum + entry.totals.skipped, 0)

process.stdout.write(
  `\n===== 汇总 =====\n运行 ${results.length} 个包，测试 ${totalTests} 个，`
  + `通过 ${totalPass}，跳过 ${totalSkipped}，失败包 ${failed.length} 个。\n`,
)

for (const entry of failed) {
  process.stderr.write(`\n===== ${entry.name} =====\n`)
  process.stderr.write(entry.error === undefined
    ? `${entry.output.trimEnd()}\n`
    : `spawn failed: ${entry.error.code ?? entry.error.message}\n`)
}

if (failed.length > 0) process.exitCode = 1
