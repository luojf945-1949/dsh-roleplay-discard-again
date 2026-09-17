#!/usr/bin/env node
/**
 * 给测试夹具里的 `assistant/message` 事件补上必填的 `stream: []`。
 *
 * `stream` 是 DSH `assistant/message` 数据类型的必填字段。`Session.append` 不会
 * 校验它，所以夹具能建起来；但只要用例回放 snapshot 或 fork，`Session.create`
 * 就会以 `seed assistant/message at index N has invalid settlement fields` 失败——
 * 夹具本身非法，失败原因与产品代码无关，会掩盖真正的问题。
 *
 * 处理测试目录里所有显式构造 `assistant/message` 数据对象的位置：insert 到对象体
 * 的第一个顶层字段之前，因此不依赖 `turn` / `step` 的书写顺序。已经带 `stream`
 * 的对象不动，可反复运行。
 *
 * 用法：
 *   node tools/fix-test-assistant-stream.mjs          # 重写
 *   node tools/fix-test-assistant-stream.mjs --check  # 只报告，漂移时退出 1
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')

/** 数据对象的两种开头：直接 append，或 `{ type, data }` 信封。 */
const OPENERS = [
  /\.append\(\s*'assistant\/message'\s*,\s*\{/g,
  /type:\s*'assistant\/message'\s*,\s*\n\s*data:\s*\{/g,
]

/** 排除：该文件正由另一条工作线在途修改，交给它自己收口，避免互相覆盖。 */
const EXCLUDED = new Set(['plugins/rp-core/test/conversation.test.js'])

/** 收集每个插件的 test/ 目录下的测试与契约文件。 */
function collectTestFiles() {
  const files = []
  const pluginsRoot = join(projectRoot, 'plugins')
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const testDir = join(pluginsRoot, entry.name, 'test')
    let names
    try {
      names = readdirSync(testDir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!/\.(test|contract)\.js$/.test(name)) continue
      const path = join(testDir, name)
      if (EXCLUDED.has(relative(projectRoot, path).replaceAll('\\', '/'))) continue
      files.push(path)
    }
  }
  return files.sort()
}

/**
 * 找出需要插入 `stream: []` 的位置。
 *
 * @param {string} source 文件内容。
 * @returns {Array<{ insertAt: number, text: string }>} 插入计划（按位置升序）。
 */
function planInsertions(source) {
  const plans = []
  for (const pattern of OPENERS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(source)) !== null) {
      const bodyStart = match.index + match[0].length
      const body = source.slice(bodyStart, bodyStart + 600)
      // 定位首个顶层字段。插入点就在它之前，因此「首个字段是不是 stream」
      // 等价于「已经补过」——不要用 `^` 锚定行首：body 从 `{` 之后开始，
      // 起点位于缩进之内，行首锚点会漏判而重复插入。
      const firstField = /(\n[ \t]*)(\S)/.exec(body)
      if (firstField === null) continue
      const fieldName = /^([A-Za-z_$][\w$]*)/.exec(body.slice(firstField.index + firstField[1].length))
      if (fieldName !== null && fieldName[1] === 'stream') continue
      const indent = firstField[1].slice(1)
      const insertAt = bodyStart + firstField.index + firstField[1].length
      plans.push({ insertAt, text: `stream: [],\n${indent}` })
    }
  }
  return plans.sort((a, b) => a.insertAt - b.insertAt)
}

const checkOnly = process.argv.slice(2).includes('--check')
let total = 0
const touched = []

for (const path of collectTestFiles()) {
  const source = readFileSync(path, 'utf8')
  const plans = planInsertions(source)
  if (plans.length === 0) continue
  const label = relative(projectRoot, path).replaceAll('\\', '/')
  total += plans.length
  touched.push(`${label}: ${plans.length}`)
  if (checkOnly) continue

  let next = source
  for (const plan of [...plans].sort((a, b) => b.insertAt - a.insertAt)) {
    next = `${next.slice(0, plan.insertAt)}${plan.text}${next.slice(plan.insertAt)}`
  }
  writeFileSync(path, next)
}

if (checkOnly) {
  if (total === 0) {
    process.stdout.write('测试夹具的 assistant/message 均已带 stream。\n')
  } else {
    for (const line of touched) process.stderr.write(`${line}\n`)
    process.exitCode = 1
  }
} else {
  process.stdout.write(total === 0
    ? 'Nothing to fix.\n'
    : `已为 ${total} 处测试夹具的 assistant/message 补上 stream: []：\n${touched.join('\n')}\n`)
}
