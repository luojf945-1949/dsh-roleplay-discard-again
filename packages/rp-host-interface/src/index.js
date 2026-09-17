/**
 * The single Harness-facing adapter for the dsh-roleplay suite.
 *
 * Roleplay plugins must not reach into DeepSeek Harness internals directly.
 * Scattered `@deepseek-ai/*` imports mean a Harness upgrade turns into a
 * repository-wide hunt, and the surface that actually breaks is usually small
 * and easy to miss. Everything the suite needs from the Harness is therefore
 * funnelled through this package:
 *
 * - `inbox` and `delivery` — the Agent queue and its wake semantics.
 * - `registerPromptSection` — prompt section registration and ordering slots.
 * - the re-exports below — Harness building blocks the suite extends or
 *   constructs (LLM message factories and errors, compaction primitives, tool
 *   declaration helpers, and the remote-service base class).
 *
 * This package is the only place in the suite that may name a Harness module
 * directly; `tools/adopt-host-interface.mjs` enforces that for `dsh-*` imports,
 * and `tools/adapt-harness.mjs` moves the pinned version everywhere at once.
 */

export { delivery, readAgentInbox, rearmInboxTail } from './inbox.js'
export {
  HARNESS_IDENTITY_SLOT,
  registerPromptSection,
  ROLEPLAY_IDENTITY_SECTION,
} from './system-prompt.js'
export { DS_ROLEPLAY_HARNESS, HARNESS_VERSIONS_ARE_EXACT } from './version.js'

// Harness LLM surface: building transcript messages and classifying failures.
export {
  BlockAssembler,
  createAssistantMessage,
  createMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  HarnessError,
  LlmError,
} from '@deepseek-ai/dsh-llm'

// Harness compaction surface: the engine the RP summarizer extends, plus the
// tool-pairing and checkpoint checks that decide whether a transcript is safe
// to compact and whether a stored summary is a usable checkpoint.
//
// The Harness ships `BasicCompactionEngine` as a default export; consumers
// import it by name, so it is re-exported once under the name they use.
export { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
export {
  CompactionEngine,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'

// Harness tool surface: declaring tools and validating the JSON Schema values
// that cross the model boundary.
export {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  defineTool,
  ToolArgsError,
  validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools'

// The Harness remote-service base class and `@Remote` decorator are
// deliberately NOT re-exported here. They are inputs to the
// `dsh-typert-generator` build tool, which resolves them by static package
// reference and cannot follow a re-export; `rp-remote` therefore imports
// `@deepseek-ai/dsh-typert-protocol` directly, as a recorded exception.
