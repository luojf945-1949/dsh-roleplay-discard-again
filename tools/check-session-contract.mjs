#!/usr/bin/env node
/**
 * 针对 DSH 0.1.5-rc.1 的会话边界契约门禁。
 *
 * 这里锁住三条**只有真实 Session 能验证**的规则——它们都曾在本仓库里被写错，
 * 而且都不会在 append 时暴露，只会在回放、分支或截断时炸：
 *
 * 1. `assistant/message` 不得携带 `sourceEventSeqs`（连空数组也不行）。
 * 2. `assistant/message` 的数据必须带 `stream` 数组；append 时不校验，
 *    但 Session.create 回放与 fork 会校验，缺失会让整段日志无法重建。
 * 3. `assistant/message` 无法做 surface replace —— DSH 的两条规则互斥：
 *    replace 必须列出被遮蔽节点，而 assistant/message 一列就抛错。
 *    这是当前基线的已知缺口，由 `--allow-assistant-replace-gap` 显式接受。
 *
 * 只读：只调用 Session API，不写任何文件。
 *
 * 用法：
 *   node tools/check-session-contract.mjs
 *   node tools/check-session-contract.mjs --allow-assistant-replace-gap
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const requireFromPlugin = createRequire(new URL('../plugins/rp-core/package.json', import.meta.url))
const load = (name) => import(pathToFileURL(requireFromPlugin.resolve(name)).href)
const { Session, SessionId } = await load('@deepseek-ai/dsh-session')
const { createAssistantMessage } = await load('@deepseek-ai/dsh-llm')

const allowReplaceGap = process.argv.slice(2).includes('--allow-assistant-replace-gap')

const assistantMessage = () => createAssistantMessage({
  content: [{ type: 'text', text: 'body' }],
  source: { provider: 'mock', model: 'mock' },
})
const userMessage = id => ({
  id, role: 'user', content: [{ type: 'text', text: 'q' }], source: { kind: 'user' },
})

let nextId = 0
const freshId = tag => SessionId(`contract-${tag}-${nextId += 1}`)

/** 一个带 user + assistant surface 节点的 Session；`extra` 用于切换 stream 字段。 */
function seeded(extra = {}) {
  const session = Session.create(freshId('seed'))
  session.append('user/message', userMessage('u1'), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1, message: assistantMessage(), ...extra,
  }, { surfaceOp: 'append' })
  return session
}

const capture = fn => {
  try { return { ok: true, value: fn() } } catch (error) { return { ok: false, error: error.message } }
}

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    process.stdout.write(`  PASS  ${label}\n`)
  } else {
    process.stdout.write(`  FAIL  ${label}\n        ${detail}\n`)
    failures.push(label)
  }
}

process.stdout.write('1) assistant/message 不得携带 sourceEventSeqs\n')
{
  const withEmpty = capture(() => seeded().append('assistant/message', {
    turn: 1, step: 1, stream: [], message: assistantMessage(),
  }, { surfaceOp: 'append', sourceEventSeqs: [] }))
  check('空数组被拒绝', !withEmpty.ok, 'Harness 接受了空 sourceEventSeqs，规则已变化')

  const without = capture(() => seeded().append('assistant/message', {
    turn: 1, step: 1, stream: [], message: assistantMessage(),
  }, { surfaceOp: 'append' }))
  check('省略该字段被接受', without.ok, `省略后仍抛错：${without.error}`)
}

process.stdout.write('2) assistant/message 必须带 stream 才能回放\n')
{
  const missing = seeded()
  const replayMissing = capture(() => Session.create(freshId('r1'), structuredClone(missing.snapshotEvents())))
  check('缺 stream 时回放失败（回归哨兵）', !replayMissing.ok,
    '缺 stream 竟然可以回放，规则已变化，本门禁需要更新')

  const present = seeded({ stream: [] })
  const replayPresent = capture(() => Session.create(freshId('r2'), structuredClone(present.snapshotEvents())))
  check('带 stream: [] 时回放成功', replayPresent.ok,
    `带 stream 仍抛错：${replayPresent.error}`)
}

process.stdout.write('3) assistant/message 的 surface replace\n')
{
  const withSources = capture(() => seeded({ stream: [] }).append('assistant/message', {
    turn: 1, step: 1, stream: [], message: assistantMessage(),
  }, {
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
    sourceEventSeqs: [1],
  }))
  const withoutSources = capture(() => seeded({ stream: [] }).append('assistant/message', {
    turn: 1, step: 1, stream: [], message: assistantMessage(),
  }, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }))

  const userReplace = capture(() => seeded({ stream: [] }).append('user/message', userMessage('u2'), {
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
    sourceEventSeqs: [0],
  }))
  check('user/message 的 replace 可用', userReplace.ok,
    `user/message replace 抛错：${userReplace.error}`)

  const gapPresent = !withSources.ok && !withoutSources.ok
  if (gapPresent) {
    if (allowReplaceGap) {
      process.stdout.write('  KNOWN assistant/message 的 replace 无解（已按参数放行）\n')
      process.stdout.write(`        带 sourceEventSeqs -> ${withSources.error}\n`)
      process.stdout.write(`        不带              -> ${withoutSources.error}\n`)
    } else {
      check('assistant/message 的 replace 应可用', false,
        'assistant/message 的 surface replace 仍然无解；确认后可用 --allow-assistant-replace-gap 放行')
    }
  } else {
    check('assistant/message 的 replace 已可用（缺口已修复）', true)
  }
}

process.stdout.write(failures.length === 0
  ? '\n会话边界契约门禁通过。\n'
  : `\n会话边界契约门禁失败：${failures.join('；')}\n`)
process.exitCode = failures.length === 0 ? 0 : 1
