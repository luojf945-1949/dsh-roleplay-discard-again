/**
 * Harness LLM message construction, re-exported for the transcript builder.
 *
 * The Harness splits its message vocabulary across the package root and a
 * `/message` subpath. Routing both through this adapter keeps that layout an
 * implementation detail of one package: a future Harness release that merges
 * or renames the subpath is reconciled here, not in every caller.
 *
 * @see {@link https://github.com/deepseek-ai/deepseek-harness} `packages/core/llm`
 */

export {
  boundContextSummary,
  CONTEXT_SUMMARY_MAX_CHARS,
  createAssistantMessage,
  createMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  freezeMessage,
} from '@deepseek-ai/dsh-llm/message'
