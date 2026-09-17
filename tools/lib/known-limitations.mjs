/**
 * `docs/known-limitations.md` 的结构化读取器。
 *
 * 这个模块是「没有任何静默跳过」这条交付要求的机器可读来源：已知限制条目本身
 * （原因 / 受影响的用户能力 / 自动恢复条件）与测试跳过登记表都写在同一份人读文档里，
 * 由这里解析成结构化数据，供 `tools/check-test-skips.mjs`（静态校验）与
 * `tools/run-package-tests.mjs`（运行时校验）共同使用。
 *
 * 只解析约定好的结构，不做模糊匹配：结构被破坏时返回 problems 而不是猜一个结果。
 *
 * @module tools/lib/known-limitations
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 登记文档相对仓库根的路径。 */
export const LIMITATIONS_DOC = 'docs/known-limitations.md'

/** 每个 LIM 条目必须具备的字段（人读文档里的 `- 字段：值` 行）。 */
export const REQUIRED_LIMITATION_FIELDS = ['状态', '原因', '受影响的用户能力', '自动恢复条件']

const LIMITATION_HEADING = /^##\s+(LIM-\d+)\s*·\s*(.+?)\s*$/
const SECTION_HEADING = /^##\s+(.+?)\s*$/
const SKIP_TABLE_HEADING = /^##\s+测试跳过登记表\s*$/
const FIELD_LINE = /^-\s*([^：:]+?)\s*[：:]\s*(.*)$/
const TABLE_ROW = /^\|(.*)\|\s*$/

/**
 * 解析登记文档正文。
 *
 * @param {string} text `docs/known-limitations.md` 的内容。
 * @returns {{ limitations: Map<string, object>, skipRows: object[], problems: string[] }}
 */
export function parseKnownLimitations(text) {
  const limitations = new Map()
  const skipRows = []
  const problems = []
  const lines = text.split(/\r?\n/)

  let current
  let inSkipTable = false
  let tableHeaderSeen = false

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    const limitationHeading = LIMITATION_HEADING.exec(line)
    if (limitationHeading !== null) {
      const [, id, title] = limitationHeading
      if (limitations.has(id)) problems.push(`${LIMITATIONS_DOC}:${lineNumber}: LIM 条目 ${id} 重复`)
      current = { id, title: title.trim(), line: lineNumber, fields: {} }
      limitations.set(id, current)
      inSkipTable = false
      tableHeaderSeen = false
      continue
    }
    const sectionHeading = SECTION_HEADING.exec(line)
    if (sectionHeading !== null) {
      current = undefined
      inSkipTable = SKIP_TABLE_HEADING.test(line)
      tableHeaderSeen = false
      continue
    }
    if (inSkipTable) {
      const row = TABLE_ROW.exec(line)
      if (row === null) continue
      const cells = row[1].split('|').map(cell => cell.trim())
      if (cells.every(cell => /^-*$/.test(cell) || cell === '')) continue
      if (!tableHeaderSeen) {
        tableHeaderSeen = true
        continue
      }
      const parsed = parseSkipRow(cells, lineNumber, problems)
      if (parsed !== undefined) skipRows.push(parsed)
      continue
    }
    if (current === undefined) continue
    const field = FIELD_LINE.exec(line)
    if (field === null) continue
    const [, name, value] = field
    if (current.fields[name] !== undefined) {
      problems.push(`${LIMITATIONS_DOC}:${lineNumber}: ${current.id} 的字段「${name}」重复`)
    }
    current.fields[name] = value.trim()
  }

  for (const limitation of limitations.values()) {
    for (const field of REQUIRED_LIMITATION_FIELDS) {
      const value = limitation.fields[field]
      if (value === undefined || value.length === 0) {
        problems.push(`${LIMITATIONS_DOC}:${limitation.line}: ${limitation.id} 缺少字段「${field}」`)
      }
    }
    limitation.status = limitation.fields['状态'] ?? ''
    limitation.reason = limitation.fields['原因'] ?? ''
    limitation.capabilities = limitation.fields['受影响的用户能力'] ?? ''
    limitation.recovery = limitation.fields['自动恢复条件'] ?? ''
  }

  if (skipRows.length === 0) {
    problems.push(`${LIMITATIONS_DOC}: 未解析到任何测试跳过登记行（缺少「${SKIP_TABLE_HEADING.source}」表或表为空）`)
  }
  for (const row of skipRows) {
    if (!limitations.has(row.limitationId)) {
      problems.push(`${LIMITATIONS_DOC}:${row.line}: 登记行引用了不存在的条目 ${row.limitationId}`)
    }
  }

  return { limitations, skipRows, problems }
}

/** 解析一行登记表；列数不符时登记问题并返回 undefined。 */
function parseSkipRow(cells, lineNumber, problems) {
  if (cells.length !== 5) {
    problems.push(`${LIMITATIONS_DOC}:${lineNumber}: 登记表每行需要 5 列（跳过来源 | 关联条目 | 源码热点数 | 运行时跳过数 | 备注），实际 ${cells.length} 列`)
    return undefined
  }
  const [path, limitationId, sites, runtime, note] = cells
  const row = { path, limitationId, sites: Number(sites), runtime: Number(runtime), note, line: lineNumber }
  if (!Number.isSafeInteger(row.sites) || row.sites < 0) {
    problems.push(`${LIMITATIONS_DOC}:${lineNumber}: 源码热点数必须是自然数，实际「${sites}」`)
  }
  if (!Number.isSafeInteger(row.runtime) || row.runtime < 0) {
    problems.push(`${LIMITATIONS_DOC}:${lineNumber}: 运行时跳过数必须是自然数，实际「${runtime}」`)
  }
  if (path.length === 0) problems.push(`${LIMITATIONS_DOC}:${lineNumber}: 缺少跳过来源路径`)
  if (row.sites !== row.runtime && (note === '' || note === '—')) {
    problems.push(`${LIMITATIONS_DOC}:${lineNumber}: ${path} 的两个计数不同（${sites} / ${runtime}），必须在备注里写明原因`)
  }
  return row
}

/**
 * 读取并解析仓库根的登记文档。
 *
 * @param {string} projectRoot 仓库根目录。
 * @returns {{ limitations: Map<string, object>, skipRows: object[], problems: string[] }}
 */
export function loadKnownLimitations(projectRoot) {
  let text
  try {
    text = readFileSync(join(projectRoot, LIMITATIONS_DOC), 'utf8')
  } catch (error) {
    return {
      limitations: new Map(),
      skipRows: [],
      problems: [`${LIMITATIONS_DOC}: 无法读取（${error instanceof Error ? error.message : String(error)}）`],
    }
  }
  return parseKnownLimitations(text)
}

/**
 * 登记行所属的运行范围：`plugins/<名>`、`packages/<名>`，其余归 `root`。
 *
 * @param {string} path 仓库根相对路径（POSIX 分隔符）。
 * @returns {string} 范围键。
 */
export function skipScopeOf(path) {
  const [group, name, ...rest] = path.split('/')
  if (rest.length > 0 && (group === 'plugins' || group === 'packages')) return `${group}/${name}`
  return 'root'
}

/**
 * 某个运行范围声明的运行时跳过总数。
 *
 * @param {object[]} skipRows 登记行。
 * @param {string} scope 范围键（见 {@link skipScopeOf}）。
 * @returns {number} 期望的运行时跳过用例数。
 */
export function expectedRuntimeSkips(skipRows, scope) {
  return skipRows
    .filter(row => skipScopeOf(row.path) === scope)
    .reduce((sum, row) => sum + row.runtime, 0)
}
