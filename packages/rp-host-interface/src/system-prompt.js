/**
 * Harness system-prompt sections, as used by the Roleplay suite.
 *
 * The suite contributes Roleplay context by registering named sections on the
 * Harness prompt assembly rather than by editing a prompt string. Registering a
 * section takes an explicit ordering slot, and the names and ordering slots for
 * Harness-owned sections belong to the Harness, not to this suite; they are
 * resolved through the prompt service so a Harness release that renumbers its
 * slots does not silently relocate Roleplay context.
 *
 * @see {@link https://github.com/deepseek-ai/deepseek-harness} `packages/core/system-prompt`
 */

/**
 * The Harness ordering slot that Roleplay identity text must sit beside.
 *
 * Naming the slot symbolically keeps this suite from hard-coding a numeric
 * order that a Harness release can renumber.
 */
export const HARNESS_IDENTITY_SLOT = 'HARNESS_IDENTITY'

/**
 * The section name this suite registers its own identity text under.
 *
 * Harness section names are namespaced by owner so two plugins cannot collide;
 * the suite owns everything under `harness:` here and `rp/` elsewhere.
 */
export const ROLEPLAY_IDENTITY_SECTION = 'harness:identity'

/**
 * Register a lazily-evaluated text section on the Harness prompt service.
 *
 * `text` stays a function so identity text is produced per assembly instead of
 * being frozen at plugin load, which is what lets a session that changes its
 * Roleplay identity mid-conversation pick the change up on the next turn.
 *
 * @param {{ systemPrompt?: unknown }} ctx Harness context.
 * @param {{
 *   name: string,
 *   text: () => string,
 *   slot: string,
 * }} section Section to register.
 * @returns {boolean} Whether the section was registered.
 */
export function registerPromptSection(ctx, section) {
  const service = ctx?.systemPrompt
  if (service === null || typeof service !== 'object') return false
  if (typeof service.section !== 'function' || typeof service.getSectionOrder !== 'function') return false

  const { name, text, slot } = section
  if (typeof name !== 'string' || name.length === 0) throw new Error('rp-host-interface: section name must be a non-empty string')
  if (typeof slot !== 'string' || slot.length === 0) throw new Error(`rp-host-interface: section ${name} needs an ordering slot`)
  if (typeof text !== 'function') throw new Error(`rp-host-interface: section ${name} needs a text provider`)

  service.section({
    name,
    order: service.getSectionOrder(slot),
    text,
  })
  return true
}
