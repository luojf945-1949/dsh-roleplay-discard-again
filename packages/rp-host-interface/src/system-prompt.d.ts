/**
 * Type declarations for the system-prompt adapter.
 */

/** The Harness ordering slot Roleplay identity text sits beside. */
export declare const HARNESS_IDENTITY_SLOT = 'HARNESS_IDENTITY'

/** The section name this suite registers its own identity text under. */
export declare const ROLEPLAY_IDENTITY_SECTION = 'harness:identity'

/** The subset of the Harness prompt service this adapter uses. */
export interface PromptServiceContext {
  readonly systemPrompt?: {
    section(section: { name: string, order: unknown, text: () => string }): void
    getSectionOrder(slot: string): unknown
  }
}

/** A section this suite wants registered on the Harness prompt assembly. */
export interface PromptSectionRequest {
  /** Section name; must be owned by this suite. */
  readonly name: string
  /** Harness ordering slot to resolve an order from. */
  readonly slot: string
  /** Produces the section text at each assembly. */
  readonly text: () => string
}

/**
 * Register a lazily-evaluated text section on the Harness prompt service.
 *
 * @param ctx Harness context.
 * @param section Section to register.
 * @returns Whether the section was registered.
 * @throws When the section definition is unusable or the slot is unknown.
 */
export function registerPromptSection(ctx: PromptServiceContext, section: PromptSectionRequest): boolean
