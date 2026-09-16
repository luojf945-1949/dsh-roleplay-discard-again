// 最小复现：assistant/message 无法做 surface replace。
//
// DSH 0.1.5-rc.1 的两条规则互相矛盾：
//   1. replace 必须携带 sourceEventSeqs，且必须列出每个被遮蔽的 surface 节点
//      （assertProvenance 末尾的 missing 检查）。
//   2. assistant/message 一旦携带 sourceEventSeqs 就直接抛错
//      （assertProvenance 开头，类型注释也只说 system/user/tool 可引用来源）。
//
// 于是 assistant/message 的 replace 无解：带字段抛 A，不带字段抛 B。
// 对照：user/message 的 replace 正常工作。
//
// 运行：node tools/repro-assistant-replace-unsupported.mjs
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const requireFromPlugin = createRequire(new URL('../plugins/rp-core/package.json', import.meta.url))
const load = (name) => import(pathToFileURL(requireFromPlugin.resolve(name)).href)
const { Session, SessionId } = await load('@deepseek-ai/dsh-session')
const { createAssistantMessage } = await load('@deepseek-ai/dsh-llm')

const assistantMessage = () => createAssistantMessage({
  content: [{ type: 'text', text: 'body' }],
  source: { provider: 'mock', model: 'mock' },
})
const userMessage = (id) => ({
  id, role: 'user', content: [{ type: 'text', text: 'q' }], source: { kind: 'user' },
})

/** 建一个有一个 user + 一个 assistant surface 节点的 Session。 */
function seed() {
  const session = Session.create(SessionId(`repro-${Math.random().toString(36).slice(2)}`))
  session.append('user/message', userMessage('u1'), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [], message: assistantMessage(),
  }, { surfaceOp: 'append' })
  return session
}

const attempt = (label, fn) => {
  try {
    fn()
    console.log(`  ${label}\n    -> 接受`)
    return 'accepted'
  } catch (error) {
    console.log(`  ${label}\n    -> 抛错: ${error.message}`)
    return 'threw'
  }
}

const replaceBody = { turn: 1, step: 1, stream: [], message: assistantMessage() }

console.log('目标：把 seq=1 的 assistant/message 换成新节点\n')

console.log('[1] assistant/message + replace + sourceEventSeqs: [1]')
const a = attempt('带 sourceEventSeqs（类型契约要求这样）', () => {
  seed().append('assistant/message', structuredClone(replaceBody), {
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
    sourceEventSeqs: [1],
  })
})

console.log('\n[2] assistant/message + replace，不带 sourceEventSeqs')
const b = attempt('不带 sourceEventSeqs', () => {
  seed().append('assistant/message', structuredClone(replaceBody), {
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
  })
})

console.log('\n[3] 对照：user/message + replace + sourceEventSeqs: [0]')
const c = attempt('user/message 的 replace', () => {
  seed().append('user/message', userMessage('u2'), {
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
    sourceEventSeqs: [0],
  })
})

console.log('\n结论：')
if (a === 'threw' && b === 'threw' && c === 'accepted') {
  console.log('  assistant/message 的 surface replace 在 DSH 0.1.5-rc.1 上无解（两条规则互斥）；')
  console.log('  user/message 的 replace 正常。受影响的只有「替换助手消息」这一类操作。')
} else {
  console.log(`  与预期不符：a=${a} b=${b} c=${c}，需重新分析。`)
}
