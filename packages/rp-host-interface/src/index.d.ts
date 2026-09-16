/**
 * The single Harness-facing adapter for the dsh-roleplay suite.
 *
 * Plugins import Harness capabilities from here rather than from
 * `@deepseek-ai/dsh-*` directly, so a Harness upgrade is reconciled in one
 * package. The Harness re-exports below keep the upstream types, so consumers
 * still see real Harness types rather than an approximation.
 */

export { delivery, readAgentInbox, rearmInboxTail } from './inbox.js'
export type { AgentInbox, InboxAgent, QueuedMessage, RearmOutcome } from './inbox.js'
export {
  HARNESS_IDENTITY_SLOT,
  registerPromptSection,
  ROLEPLAY_IDENTITY_SECTION,
} from './system-prompt.js'
export type { PromptSectionRequest, PromptServiceContext } from './system-prompt.js'
export { DS_ROLEPLAY_HARNESS, HARNESS_VERSIONS_ARE_EXACT } from './version.js'

// Harness LLM surface: building transcript messages and classifying failures.
export {
  createAssistantMessage,
  createMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  HarnessError,
  LlmError,
} from '@deepseek-ai/dsh-llm'

// Harness compaction surface: the engine the RP summarizer extends, plus the
// tool-pairing and checkpoint checks that guard compaction.
export { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
export {
  CompactionEngine,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'

// Harness tool surface: declaring tools and validating JSON Schema values.
export {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  defineTool,
  ToolArgsError,
  validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools'

// The Harness remote-service base class is deliberately NOT re-exported here:
// it is an input to the `dsh-typert-generator` build tool, which resolves it by
// static package reference. See `src/index.js` for the full rationale.
