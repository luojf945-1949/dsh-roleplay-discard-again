/**
 * Type declarations for the Agent inbox adapter.
 *
 * The queues are described structurally rather than by importing Harness
 * message types: the adapter only ever reads an `id` off a queued message, and
 * keeping the surface structural means this file does not have to track the
 * Harness message type's internal shape.
 */

/** A queued item, as far as the adapter is concerned. */
export interface QueuedMessage {
  readonly id: string
}

/** The subset of a Harness Agent the inbox adapter reads and wakes. */
export interface InboxAgent {
  readonly inbox?: {
    readonly nextTurn?: readonly QueuedMessage[]
    readonly nextStep?: readonly QueuedMessage[]
    remove(id: string): boolean
  }
  inject?(message: unknown): void
  followup?(message: unknown): void
  steer?(message: unknown): void
}

/** Live accessors over an Agent's queued messages. */
export interface AgentInbox {
  /** Messages waiting for the next turn boundary. */
  readonly turn: readonly QueuedMessage[]
  /** Messages the current turn will still consume. */
  readonly step: readonly QueuedMessage[]
  /** Whether a message with this identifier is queued in either vector. */
  has(id: string): boolean
  /** Remove a queued message by identifier. */
  remove(id: string): boolean
}

/** Outcome of an inbox re-arm attempt. */
export type RearmOutcome = 'none' | 'unavailable' | 'woken'

/**
 * Read the inbox of a Harness Agent.
 *
 * @param agent Harness Agent to inspect.
 * @returns Live inbox accessors, or `undefined` when the Agent has no inbox.
 */
export function readAgentInbox(agent: InboxAgent | null | undefined): AgentInbox | undefined

/**
 * Take back the newest queued message that belongs to `ids` and re-deliver it.
 *
 * @param agent Harness Agent to wake.
 * @param inbox Inbox accessors from {@link readAgentInbox}.
 * @param ids Identifiers that belong to this recovery.
 * @returns What happened; `'woken'` means the message was removed and re-delivered.
 */
export function rearmInboxTail(agent: InboxAgent, inbox: AgentInbox, ids: ReadonlySet<string>): RearmOutcome

/** Delivery entry points, matching the Harness Agent's own wording. */
export declare const delivery: {
  /** Queue a message without waking the agent. */
  inject(agent: InboxAgent, message: unknown): boolean
  /** Queue a message and wake the agent at the next turn boundary. */
  followup(agent: InboxAgent, message: unknown): boolean
  /** Queue a message and wake the agent inside the current turn. */
  steer(agent: InboxAgent, message: unknown): boolean
}
