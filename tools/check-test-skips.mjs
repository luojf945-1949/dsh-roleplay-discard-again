#!/usr/bin/env node
/**
 * 静态门禁：仓库里不允许存在没有书面理由的测试跳过。
 *
 * 做两件事：
 *
 * 1. **扫描**工作区里所有测试文件，找出三种「会让用例不执行」的写法：
 *    - `{ ...<名字>Skip }` —— 测试选项里展开一个探测模块的跳过选项；
 *    - 测试选项里的 `skip:` 字面量 —— 跳过理由的实际出处；
 *    - `test.skip(` / `t.skip(` 之类的直接跳过调用。
 * 2. **比对** `docs/known-limitations.md` 的测试跳过登记表：每个热点必须落在登记行里，
 *    每行的计数必须与源码一致，且引用的 LIM 条目必须写清「原因 / 受影响的用户能力 /
 *    自动恢复条件」。
 *
 * 运行时一侧由 `tools/run-package-tests.mjs` 用 TAP 的 `# skipped` 计数复核，
 * 两者合起来保证「汇总里的每个 skipped 都能在文档里找到对应条目」。
 *
 * 只读，不写任何文件。
 *
 * 用法：
 *   node tools/check-test-skips.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LIMITATIONS_DOC,
  loadKnownLimitations,
} from './lib/known-limitations.mjs'

const modulePath = fileURLToPath(import.meta.url)
const projectRoot = resolve(dirname(modulePath), '..')

/** 不进入扫描的目录：依赖、构建产物、版本库与登记范围之外的本地目录。 */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.npm-package', '.dsh-dev', '.pnpm-store'])

/** 会跳过用例的写法。`id` 只用于报告，判定不区分写法。 */
const SKIP_PATTERNS = [
  { id: 'probe-spread', pattern: /\.\.\.\s*[A-Za-z_$][\w$]*Skip\b/g },
  { id: 'skip-option', pattern: /[{,]\s*skip:\s*['"`]/g },
  { id: 'skip-call', pattern: /\b(?:test|it|describe|suite|t)\.skip\s*\(/g },
]

/** 只扫描测试文件：`*.test.*` / `*.spec.*`，以及 `test/` 目录下的脚本。 */
function isTestFile(path) {
  const normalized = path.replaceAll('\\', '/')
  if (/\/(?:test|tests|__tests__)\//.test(normalized)) return true
  return /\.(?:test|spec)\.[cm]?jsx?$/.test(normalized)
}

/**
 * 扫描仓库里的跳过热点。
 *
 * @param {string} root 仓库根目录。
 * @returns {Map<string, { id: string, line: number }[]>} 文件（POSIX 相对路径）到热点的映射。
 */
export function scanSkipSites(root = projectRoot) {
  const sites = new Map()
  const inspect = (directory, entry) => {
    const path = join(directory, entry.name)
    if (!isTestFile(path)) return
    const text = readFileSync(path, 'utf8')
    const found = []
    for (const { id, pattern } of SKIP_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        found.push({ id, line: text.slice(0, match.index).split('\n').length })
      }
    }
    if (found.length === 0) return
    found.sort((left, right) => left.line - right.line)
    sites.set(relative(root, path).replaceAll('\\', '/'), found)
  }
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        visit(join(directory, entry.name))
        continue
      }
      if (entry.isFile()) inspect(directory, entry)
    }
  }
  // 工作区分组 + 版本库根目录下的工具与脚本测试，全部进入扫描范围。
  for (const group of ['packages', 'plugins', 'tools', 'scripts']) {
    try {
      visit(join(root, group))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile()) inspect(root, entry)
  }
  return sites
}

/**
 * 比对源码热点与登记表，返回全部问题。
 *
 * @param {Map<string, { id: string, line: number }[]>} sites 源码热点。
 * @param {{ limitations: Map<string, object>, skipRows: object[], problems: string[] }} registry 登记文档。
 * @returns {string[]} 问题列表（空数组表示通过）。
 */
export function findSkipRegistryProblems(sites, registry) {
  const problems = [...registry.problems]
  const declared = new Map(registry.skipRows.map(row => [row.path, row]))

  for (const [path, found] of sites) {
    const row = declared.get(path)
    if (row === undefined) {
      const locations = found.map(site => `第 ${site.line} 行（${site.id}）`).join('、')
      problems.push(`${path}: 有 ${found.length} 处跳过热点未登记（${locations}），请在 ${LIMITATIONS_DOC} 的测试跳过登记表中登记`)
      continue
    }
    if (row.sites !== found.length) {
      problems.push(`${path}: 登记表声明 ${row.sites} 处源码热点，实际扫描到 ${found.length} 处`)
    }
  }

  for (const row of registry.skipRows) {
    if (!sites.has(row.path)) {
      problems.push(`${row.path}: 登记表第 ${row.line} 行声明了跳过热点，但源码里已找不到（登记已过期）`)
    }
    if (row.runtime > 0 && row.sites === 0) {
      problems.push(`${row.path}: 声明了运行时跳过 ${row.runtime} 个，但源码热点数为 0`)
    }
  }
  return problems
}

/** 门禁入口；返回是否通过，便于测试直接调用。 */
export function runTestSkipCheck(root = projectRoot) {
  const registry = loadKnownLimitations(root)
  const sites = scanSkipSites(root)
  const problems = findSkipRegistryProblems(sites, registry)

  const siteCount = [...sites.values()].reduce((sum, found) => sum + found.length, 0)
  const runtimeCount = registry.skipRows.reduce((sum, row) => sum + row.runtime, 0)

  if (problems.length > 0) {
    process.stderr.write(`测试跳过登记门禁失败：\n- ${problems.join('\n- ')}\n`)
    return false
  }
  process.stdout.write(
    `测试跳过登记门禁通过：${sites.size} 个文件、${siteCount} 处源码热点，`
    + `全部登记在 ${LIMITATIONS_DOC} 的 ${registry.skipRows.length} 行记录里，`
    + `运行时跳过合计 ${runtimeCount} 个用例。\n`,
  )
  return true
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath) {
  if (!runTestSkipCheck()) process.exitCode = 1
}
