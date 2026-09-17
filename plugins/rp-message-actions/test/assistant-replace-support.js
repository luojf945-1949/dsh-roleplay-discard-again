/**
 * 运行时探测：当前 DSH 基线是否支持 `assistant/message` 的 surface replace。
 *
 * DSH `0.1.5-rc.1` 的两条规则互斥——replace 必须携带 `sourceEventSeqs` 并列出
 * 每个被遮蔽的 surface 节点，而 `assistant/message` 一旦携带该字段就在写入时抛错
 * （类型注释也只说 system／user／tool 可引用来源）。因此助手消息无法被替换：
 * 编辑助手消息、以及任何需要遮蔽助手节点的删除／重新生成都会失败。
 *
 * 这里在模块加载期做一次同步探测，然后用探测结果决定是否跳过依赖该能力的用例。
 * 这样处理的原因：跳过是**条件式**的，不是永久标注。上游一旦放宽该契约，探测
 * 转为 true，这些用例会自动恢复执行——不会留下被遗忘的僵尸测试。
 * `tools/check-session-contract.mjs` 会独立盯住同一件事并在缺口修复时报警。
 *
 * 只在测试中使用；产品代码不应依赖探测结果，而应在失败时如实报错。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const requireFromPlugin = createRequire(new URL('../package.json', import.meta.url))
const load = name => import(pathToFileURL(requireFromPlugin.resolve(name)).href)

const { Session, SessionId } = await load('@deepseek-ai/dsh-session')
const { createAssistantMessage } = await load('@deepseek-ai/dsh-llm')

let counter = 0
const assistant = text => createAssistantMessage({
  content: [{ type: 'text', text }],
  source: { provider: 'mock', model: 'mock' },
})

/** @returns {boolean} 当前基线能否替换一个助手 surface 节点。 */
function detectsAssistantReplaceSupport() {
  counter += 1
  const session = Session.create(SessionId(`assistant-replace-probe-${counter}`))
  session.append('user/message', {
    id: 'probe-user', role: 'user', content: [{ type: 'text', text: 'q' }], source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [], message: assistant('first'),
  }, { surfaceOp: 'append' })
  try {
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [], message: assistant('second'),
    }, {
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
      sourceEventSeqs: [1],
    })
    return true
  } catch {
    return false
  }
}

export const supportsAssistantReplace = detectsAssistantReplaceSupport()

/** 跳过选项：缺口存在时给出理由，修复后返回空对象以恢复执行。 */
export const assistantReplaceSkip = supportsAssistantReplace
  ? {}
  : {
      skip: '依赖 assistant/message 的 surface replace，DSH 0.1.5-rc.1 的会话边界契约'
        + '要求 replace 列出被遮蔽节点、又禁止 assistant/message 携带 sourceEventSeqs，两者互斥；'
        + '见 tools/repro-assistant-replace-unsupported.mjs',
    }
