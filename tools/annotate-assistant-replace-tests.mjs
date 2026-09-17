#!/usr/bin/env node
/**
 * 为依赖 `assistant/message` surface replace 的用例插入条件跳过选项。
 *
 * 当前 DSH 基线上该能力不可用（见 `tools/repro-assistant-replace-unsupported.mjs`），
 * 因此这些用例无法通过。跳过是**条件式**的：`assistant-replace-support.js` 在模块
 * 加载期探测能力，上游放宽契约后探测转为 true，用例自动恢复执行——不会留下被遗忘
 * 的僵尸测试。`tools/check-session-contract.mjs` 独立盯住同一件事并在缺口修复时报警。
 *
 * 本脚本一次性改写声明，避免手工编辑十几处出错；可反复运行（幂等）。
 *
 * 用法：
 *   node tools/mark-assistant-replace-tests.mjs          # 重写
 *   node tools/mark-assistant-replace-tests.mjs --check  # 只检查，漂移时退出 1
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const OPTION = '{ ...assistantReplaceSkip }'
const IMPORT_LINE = "import { assistantReplaceSkip } from './assistant-replace-support.js'"

const PLAN = [
  {
    file: 'plugins/rp-message-actions/test/agent-loop-integration.test.js',
    names: [
      'real Agent Loop regenerates in place and accepts new input after assistant deletion',
      'real Agent Loop exposes and rerolls its durable interrupted assistant message',
      'real resumed Agent Loop rerolls a committed Roleplay turn without retaining its tool history',
      'real Agent Loop accepts new input after deleting an earlier reply and its full suffix',
      'real Agent Loop starts from the remaining history after deleting a user-message suffix',
      'Roleplay pre-step context survives consecutive rerolls in the same Agent',
      'real Agent Loop replays every user message from one turn in order during reroll',
      'resumed Agent Loop re-arms a fully persisted reroll inbox exactly once after the wake crash window',
    ],
  },
]

/**
 * 定位用例声明中「用例名之后」的插入点。
 *
 * 只在声明处插入选项，不动用例体；已带选项时返回 'annotated' 表示无需改动。
 *
 * @param {string} source 文件内容。
 * @param {string} name 用例名（与声明逐字一致）。
 * @returns {{ insertAt: number } | 'annotated' | undefined} 插入点或状态。
 */
function locateInsertion(source, name) {
  for (const quote of ["'", '`']) {
    const head = `test(${quote}${name}${quote},`
    const at = source.indexOf(head)
    if (at === -1) continue
    const after = source.slice(at + head.length)
    // 选项直接跟在用例名之后，因此「是否已标注」看紧随其后的内容即可。
    if (after.trimStart().startsWith(OPTION)) return 'annotated'
    return { insertAt: at + head.length }
  }
  return undefined
}

const checkOnly = process.argv.slice(2).includes('--check')
const pending = []
const problems = []

for (const entry of PLAN) {
  const path = join(projectRoot, entry.file)
  const original = readFileSync(path, 'utf8')
  let next = original
  let applied = 0

  for (const name of entry.names) {
    const found = locateInsertion(next, name)
    if (found === undefined) {
      problems.push(`${entry.file}: 未匹配到用例「${name}」`)
      continue
    }
    if (found === 'annotated') continue
    next = `${next.slice(0, found.insertAt)} ${OPTION},${next.slice(found.insertAt)}`
    applied += 1
  }

  if (applied > 0 && !next.includes(IMPORT_LINE)) {
    // 插到最后一个 import 语句之后，保证 ESM 导入位于模块顶部区域。
    const imports = [...next.matchAll(/^import[\s\S]*?from\s+'[^']+'\n/gm)]
    const last = imports.at(-1)
    const at = last === undefined ? 0 : last.index + last[0].length
    next = `${next.slice(0, at)}${IMPORT_LINE}\n${next.slice(at)}`
  }

  if (next !== original) pending.push({ file: entry.file, applied, next, path })
}

if (problems.length > 0) {
  for (const line of problems) process.stderr.write(`${line}\n`)
  process.exitCode = 1
} else if (checkOnly) {
  if (pending.length === 0) {
    process.stdout.write('所有目标用例均已带条件跳过选项。\n')
  } else {
    for (const entry of pending) process.stderr.write(`${entry.file}: 待标注 ${entry.applied}\n`)
    process.exitCode = 1
  }
} else {
  for (const entry of pending) {
    writeFileSync(entry.path, entry.next)
    process.stdout.write(`${entry.file}: 已标注 ${entry.applied} 个用例\n`)
  }
  if (pending.length === 0) process.stdout.write('Nothing to annotate.\n')
}
