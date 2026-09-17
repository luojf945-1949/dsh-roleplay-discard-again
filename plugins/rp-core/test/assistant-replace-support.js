/**
 * 运行时探测：当前 DSH 基线是否支持 `assistant/message` 的 surface replace。
 *
 * DSH `0.1.5-rc.1` 的两条规则互斥——replace 必须携带 `sourceEventSeqs` 并列出每个
 * 被遮蔽的 surface 节点，而 `assistant/message` 一旦携带该字段就在写入时抛错。
 * 因此依赖替换助手节点的操作无法完成。
 *
 * 在模块加载期同步探测一次，再用结果决定是否跳过依赖该能力的用例。跳过是**条件式**
 * 的：上游放宽契约后探测转为 true，用例自动恢复执行，不会留下被遗忘的僵尸测试。
 * `tools/check-session-contract.mjs` 独立盯住同一件事并在缺口修复时报警。
 *
 * 与 rp-message-actions、rp-session、rp-conversation-summary、rp-standard 测试目录
 * 下的同名文件内容相同：仓库规定插件之间不得通过相对路径读取彼此的内部文件，这段
 * 探测又不足以抽成独立包，因此各自保留一份。
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
  const session = Session.create(SessionId(`rp-core-assistant-replace-probe-${counter}`))
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
        + '见 tools/repro-assistant-replace-unsupported.mjs 与 tools/check-session-contract.mjs',
    }
