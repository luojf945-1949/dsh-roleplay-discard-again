// 用本地 DSH 0.1.5-rc.1 实例逐个核验 rp-host-interface 声明的 Harness 符号。
// 直接按本地 dsh CLI 的解析上下文导入，避免被仓库 node_modules 的解析结果掩盖问题。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const localDshRoot = 'C:/Users/luojf945/AppData/Roaming/nvm/v22.19.0/node_modules/@deepseek-ai/dsh'
const requireFromLocalDsh = createRequire(`${localDshRoot}/lib/bin.js`)

const expectations = {
  '@deepseek-ai/dsh-llm': [
    'createAssistantMessage', 'createMessage', 'createSystemMessage',
    'createToolResultMessage', 'createUserMessage', 'HarnessError', 'LlmError',
  ],
  '@deepseek-ai/dsh-compaction-basic': ['BasicCompactionEngine'],
  '@deepseek-ai/dsh-compaction': [
    'CompactionEngine', 'isCompactCheckpointSource',
    'toolPairingBalancedAfter', 'toolPairingBalancedBefore',
  ],
  '@deepseek-ai/dsh-tools': [
    'assertObjectJsonSchema', 'assertSupportedJsonSchema', 'defineTool',
    'ToolArgsError', 'validateJsonSchemaValue',
  ],
  '@deepseek-ai/dsh-typert-protocol': ['Remote', 'TypertRemoteService'],
}

let failures = 0
for (const [pkg, symbols] of Object.entries(expectations)) {
  let mod
  try {
    mod = await import(pathToFileURL(requireFromLocalDsh.resolve(pkg)).href)
  } catch (error) {
    console.log(`FAIL  ${pkg} 无法导入: ${error.message}`)
    failures += symbols.length
    continue
  }
  const missing = symbols.filter((s) => mod[s] === undefined)
  const names = new Set(Object.keys(mod))
  if (missing.length === 0) {
    console.log(`OK    ${pkg}  (${symbols.length} 个符号全部存在)`)
  } else {
    failures += missing.length
    console.log(`FAIL  ${pkg}  缺失: ${missing.join(', ')}`)
    console.log(`      该包实际导出(前60): ${[...names].slice(0, 60).join(', ')}`)
  }
}

// 单独确认 BasicCompactionEngine 是 default export 这一点注释是否属实
try {
  const m = await import(pathToFileURL(requireFromLocalDsh.resolve('@deepseek-ai/dsh-compaction-basic')).href)
  console.log(`INFO  dsh-compaction-basic default=${typeof m.default} named=${typeof m.BasicCompactionEngine}`)
} catch { /* 上一轮已报告 */ }

console.log(failures === 0 ? '\nRESULT: 适配层符号与本地 DSH 完全对齐' : `\nRESULT: ${failures} 个符号不匹配`)
process.exitCode = failures === 0 ? 0 : 1
