// 缺口 A 的证据工具：`assistant/message` 的 surface replace 在 DSH 0.1.5-rc.1 上不可用。
//
// 这不是「还没试过」的猜测，而是对**全部合法写入形状**的穷举结论。DSH 的会话边界契约
// 有两条互相矛盾的规则（见 `@deepseek-ai/dsh-session/lib/types/surface.js`）：
//
//   1. `planSurfaceEvent` → `assertProvenance(event, range.shadowedSeqs)`：
//      replace 必须列出每个被遮蔽的 surface 节点，而列出的唯一渠道是 `sourceEventSeqs`。
//   2. `assertProvenance` 开头：`assistant/message` 只要出现 `sourceEventSeqs`
//      （连空数组也算）就直接抛错——它自带来源流，不允许引用顶层来源事件。
//
// 于是「用一个助手节点遮蔽一段 surface」无解：带字段抛 1，不带字段抛 2。
// 换载体也不行：本脚本对四种 surface 事件类型逐个实测，并记录替换后模型的可见历史，
// 结论是**没有任何载体能同时做到「遮蔽助手节点」与「从模型历史投影为 null」**。
//
// 运行：node tools/repro-assistant-replace-unsupported.mjs
// 退出码 0 = 缺口与 docs/known-limitations.md 的登记一致（契约未变）；
// 退出码 1 = Harness 契约已变，缺口可能已经关闭——此时应删掉条件跳过、
//            更新 docs/known-limitations.md，并重新评估这条已知限制。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const requireFromPlugin = createRequire(new URL('../plugins/rp-core/package.json', import.meta.url))
const load = (name) => import(pathToFileURL(requireFromPlugin.resolve(name)).href)
const { Session, SessionId, isSurfaceEligibleType } = await load('@deepseek-ai/dsh-session')
const { createAssistantMessage, createSystemMessage, createUserMessage } = await load('@deepseek-ai/dsh-llm')

/** 用 `ok` / `error` 记录一次写入尝试的结果，不用异常中断穷举。 */
const attempt = (fn) => {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const assistantMessage = () => createAssistantMessage({
  content: [{ type: 'text', text: 'body' }],
  source: { provider: 'mock', model: 'mock' },
})
const userMessage = (id, content) => ({
  id, role: 'user', content, source: { kind: 'user' },
})

/** 一个 user + 一个 assistant surface 节点的 Session：seq 0 用户、seq 1 助手。 */
function seed() {
  const session = Session.create(SessionId(`repro-${Math.random().toString(36).slice(2)}`))
  session.append('user/message', userMessage('u1', [{ type: 'text', text: 'q' }]), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [], message: assistantMessage(),
  }, { surfaceOp: 'append' })
  return session
}

/** 把一次写入尝试的投影结果压成一行可读证据。 */
function project(session) {
  const messages = session.deriveMessages()
  return {
    roles: messages.map(message => message.role),
    texts: messages.map(message => (Array.isArray(message.content)
      ? message.content.filter(block => block?.type === 'text').map(block => block.text).join('')
      : '')),
  }
}

const rows = []
let unexpected = 0

/** 跑一次「用 carrier 遮蔽 seq 1 的助手节点」，记录结果并登记进表格。 */
function probe(label, carrier, { withSources = true, data, sessions = undefined, summary = true } = {}) {
  const session = sessions ?? seed()
  const result = attempt(() => session.append(carrier, typeof data === 'function' ? data(session) : data, {
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
    ...withSources ? { sourceEventSeqs: [1] } : {},
  }))
  const accepted = result.ok
  const projection = accepted ? project(session) : undefined
  const node = accepted ? session.eventAt(session.surface.nodes[1]) : undefined
  const row = {
    label,
    carrier,
    withSources,
    accepted,
    detail: accepted ? undefined : result.error,
    nodeType: node?.type,
    projectsToNull: projection === undefined ? undefined : projection.roles.length === 1,
    projection,
    summary,
  }
  rows.push(row)
  return { session, result }
}

console.log('目标：用一次 surface replace 遮蔽 seq=1 的 assistant/message 节点\n')

console.log('[1] 禁用的写入形状：assistant/message 作载体')
probe('assistant/message + sourceEventSeqs: [1]', 'assistant/message', {
  data: () => ({ turn: 1, step: 1, stream: [], message: assistantMessage() }),
})
probe('assistant/message 不带 sourceEventSeqs', 'assistant/message', {
  withSources: false,
  data: () => ({ turn: 1, step: 1, stream: [], message: assistantMessage() }),
})

console.log('[2] 其余合法载体：能遮蔽，但不能产出「投影为 null 的助手节点」')
probe('user/message（纯文本）+ sourceEventSeqs', 'user/message', {
  data: () => userMessage('u2', [{ type: 'text', text: 'replaced' }]),
})
probe('user/message（空内容）+ sourceEventSeqs', 'user/message', {
  data: () => userMessage('u3', []),
})
probe('system/message（空内容）+ sourceEventSeqs', 'system/message', {
  // system/message 的 data 带 turn/step 档案字段；空内容才会投影为 null。
  data: () => ({ turn: 1, step: 1, message: createSystemMessage('', 'rp-repro') }),
})
probe('tool/result + sourceEventSeqs（遮蔽助手节点）', 'tool/result', {
  data: () => ({
    turn: 1, step: 1,
    message: {
      role: 'tool', id: 't1',
      content: [{ type: 'tool-result', callId: 'c1', content: [{ type: 'text', text: 'x' }], isError: false }],
    },
  }),
})

console.log('  —— 载体穷举结果 ——')
for (const row of rows) {
  const verdict = row.accepted
    ? `接受；节点类型 ${row.nodeType}；模型历史 => [${row.projection.roles.join(', ')}]`
      + `${row.projectsToNull ? '（投影为 null）' : '（可见消息）'}`
    : `抛错: ${row.detail}`
  console.log(`  · ${row.label}\n      ${verdict}`)
}

console.log('\n[3] 链式替换也不能收敛回助手节点')
{
  // 先用合法载体 user/message 遮蔽助手节点，再试图把该节点换回助手节点：仍然被同一
  // 条规则拦住。也就是说「先换成合法载体、再换成助手」这条路不通。
  const { session, result } = probe('user/message 作第一阶段载体', 'user/message', {
    data: () => userMessage('u4', [{ type: 'text', text: 'stage one' }]),
    summary: false,
  })
  const staged = session.surface.nodes.at(-1)
  const second = attempt(() => session.append('assistant/message', {
    turn: 1, step: 1, stream: [], message: assistantMessage(),
  }, {
    surfaceOp: { op: 'replace', startSeq: staged, endSeq: staged },
    sourceEventSeqs: [staged],
  }))
  console.log(`  第一阶段：${result.ok ? '接受' : `抛错 ${result.error}`}；`
    + `第二阶段（把 ${staged} 换成助手节点）：${second.ok ? '接受' : `抛错 ${second.error}`}`)
  if (second.ok) unexpected += 1
}

console.log('\n[4] 契约断言（契约变化即报警，而不是静默放行）')
const assistantWithSources = rows[0]
const assistantWithoutSources = rows[1]
const userCarrier = rows[2]
const emptyUserCarrier = rows[3]
const systemCarrier = rows[4]
const toolCarrier = rows[5]

const problems = []
if (assistantWithSources.accepted) {
  problems.push('assistant/message + sourceEventSeqs 已被接受：缺口已关闭，应删除条件跳过并重评 docs/known-limitations.md 的 LIM-1')
}
if (assistantWithoutSources.accepted) {
  problems.push('assistant/message 的 replace 不再要求列出被遮蔽节点：契约已变，请重评 LIM-1')
}
if (!userCarrier.accepted) problems.push('user/message 的 replace 不再可用：载体穷举结论需要重算')
if (!emptyUserCarrier.accepted) problems.push('空内容 user/message 的 replace 不再可用：载体穷举结论需要重算')
if (!systemCarrier.accepted) problems.push('system/message 的 replace 不再可用：载体穷举结论需要重算')
if (userCarrier.accepted && userCarrier.projectsToNull) {
  problems.push('user/message 载体现在投影为 null：可能已有新的 null 投影载体，请重评 LIM-1')
}
if (emptyUserCarrier.accepted && emptyUserCarrier.projectsToNull) {
  problems.push('空内容 user/message 载体现在投影为 null：可能已有新的 null 投影载体，请重评 LIM-1')
}
if (!toolCarrier.accepted && !/tool\/result surface replacement must target a current tool\/result/.test(toolCarrier.detail ?? '')) {
  problems.push(`tool/result 载体的拒绝理由意外变化：${String(toolCarrier.detail)}`)
}
if (!systemCarrier.projectsToNull) {
  problems.push('system/message 的空内容载体不再投影为 null：载体穷举结论需要重算')
}
if (unexpected > 0) problems.push('链式替换意外成功：载体约束已变化')

console.log('  两个禁用形状都抛错：'
  + `${!assistantWithSources.accepted && !assistantWithoutSources.accepted ? '是' : '否'}`)
console.log('  四种载体里能遮蔽助手节点的：'
  + `${rows.filter(row => row.summary).filter(row => row.accepted).length} 种形状`
  + `（${rows.filter(row => row.summary && row.accepted).map(row => row.label).join('；') || '无'}）`)
console.log('  其中从模型历史投影为 null 的：'
  + `${rows.filter(row => row.summary && row.accepted && row.projectsToNull).length} 种`
  + `（${rows.filter(row => row.summary && row.accepted && row.projectsToNull).map(row => row.nodeType).join('、') || '无'}）`)

console.log('\n结论：')
console.log('  assistant/message 的 surface replace 在 DSH 0.1.5-rc.1 上无解（两条规则互斥）；')
console.log('  合法载体里唯一投影为 null 的是空内容 system/message，但它的节点类型是系统提示节点，')
console.log('  而消息操作的产品载体契约要求节点本身是 assistant/message'
  + '（见 docs/rp-architecture.md 与各插件的 carrier 消费点）；')
console.log('  且 @deepseek-ai/dsh-session/invariant 要求 system/message 命中当前打开的 turn/step'
  + '（lib/types/invariant.js:106-109，dsh-sdk-minimal 组合会加载该伴随插件），')
console.log('  而消息操作按设计发生在会话空闲时——该载体不可用。受影响能力见 docs/known-limitations.md LIM-1。')

if (problems.length > 0) {
  console.error(`\n证据与登记不一致：\n- ${problems.join('\n- ')}\n`)
  process.exitCode = 1
}
