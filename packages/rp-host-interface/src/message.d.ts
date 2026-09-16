/**
 * Type declarations for the Harness LLM message subpath.
 *
 * The Harness splits its message vocabulary between the package root and a
 * `/message` subpath; this entry point mirrors that split so callers do not
 * have to know which half a symbol lives in.
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
