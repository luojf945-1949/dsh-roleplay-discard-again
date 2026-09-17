/**
 * The Harness Agent inbox, reduced to the operations this suite needs.
 *
 * A reroll has to survive a process that stops between durably splicing its
 * replay messages and the Agent actually consuming them. Recovering that case
 * means reading the queued messages, taking one back, and re-delivering it
 * through a public delivery entry point.
 *
 * The inbox is owned by the Harness agent loop, and its queue vectors are the
 * most drift-prone surface this suite touches. Everything version-sensitive
 * about it lives here so a Harness upgrade has exactly one file to reconcile.
 *
 * @see {@link https://github.com/deepseek-ai/deepseek-harness} `packages/core/agent-loop`
 */

/**
 * The inbox vectors a queued message can occupy.
 *
 * `NEXT_TURN` messages wait for the next real turn boundary; `NEXT_STEP`
 * messages are consumed by the current turn. A message in neither vector has
 * already been delivered.
 */
const NEXT_TURN = 'nextTurn'
const NEXT_STEP = 'nextStep'

/**
 * Read the inbox of a Harness Agent.
 *
 * Returns `undefined` when the Agent does not expose an inbox, which is the
 * signal to skip inbox-aware recovery rather than to fail: older or narrower
 * agents simply have nothing queued.
 *
 * The returned queues are the **live** inbox vectors, not copies. A recovery
 * path removes a message and then re-delivers it, so it has to observe the
 * queue as it actually stands rather than as it stood when it was read.
 *
 * @param {{ inbox?: unknown }} agent Harness Agent to inspect.
 * @returns {{
 *   turn: unknown[],
 *   step: unknown[],
 *   has: (id: string) => boolean,
 *   remove: (id: string) => boolean,
 * } | undefined} Inbox accessors, or undefined when the Agent has no inbox.
 */
export function readAgentInbox(agent) {
  if (agent === null || typeof agent !== 'object') return undefined
  const inbox = agent.inbox
  if (inbox === null || typeof inbox !== 'object') return undefined
  if (typeof inbox.remove !== 'function') return undefined

  const live = vector => {
    const queued = inbox[vector]
    return Array.isArray(queued) ? queued : []
  }

  return {
    get turn() { return live(NEXT_TURN) },
    get step() { return live(NEXT_STEP) },
    has(id) {
      return [NEXT_TURN, NEXT_STEP].some(vector => live(vector).some(message => messageId(message) === id))
    },
    remove: id => inbox.remove(id) === true,
  }
}

/**
 * Read a message identifier without assuming the message shape.
 *
 * @param {unknown} message Queued message.
 * @returns {string | undefined} The identifier when the message carries one.
 */
function messageId(message) {
  if (message === null || typeof message !== 'object') return undefined
  const id = /** @type {{ id?: unknown }} */ (message).id
  return typeof id === 'string' ? id : undefined
}

/**
 * Take back the newest queued message that belongs to `ids` and re-deliver it.
 *
 * The return value distinguishes the three outcomes a caller has to report:
 * nothing of ours was queued, the inbox refused the removal, or the wake was
 * issued. Re-delivery prefers `followup` because a next-turn message is woken
 * by the normal turn boundary; a next-step message is woken in place with
 * `steer`. Moving the tail of a queue to that same queue's tail is
 * order-neutral, so this cannot reorder unrelated pending work.
 *
 * Removing without re-delivering would silently strand the message, so a
 * refused wake is never treated as success.
 *
 * @param {{ followup?: unknown, steer?: unknown }} agent Harness Agent to wake.
 * @param {{ turn: unknown[], step: unknown[], remove: (id: string) => boolean }} inbox Inbox accessors.
 * @param {Set<string>} ids Identifiers that belong to this recovery.
 * @returns {'none' | 'unavailable' | 'woken'} What happened.
 */
export function rearmInboxTail(agent, inbox, ids) {
  if (ids === undefined || ids.size === 0) return 'none'

  const queuedTurn = inbox.turn.filter(message => ids.has(messageId(message)))
  const queuedStep = inbox.step.filter(message => ids.has(messageId(message)))
  if (queuedTurn.length === 0 && queuedStep.length === 0) return 'none'

  const preferTurn = queuedTurn.length > 0
  const candidate = preferTurn ? queuedTurn.at(-1) : queuedStep.at(-1)
  const id = messageId(candidate)
  if (id === undefined) return 'unavailable'

  const deliver = preferTurn ? agent.followup : agent.steer
  if (typeof deliver !== 'function') return 'unavailable'
  if (!inbox.remove(id)) return 'unavailable'

  deliver.call(agent, candidate)
  return 'woken'
}

/**
 * Deliver messages to a Harness Agent.
 *
 * `inject` appends silently to the queue, while `followup` and `steer` also
 * wake the agent. The distinction matters for a multi-message replay: only the
 * final message should wake the agent, or the batch is split across turns.
 */
export const delivery = {
  /**
   * Queue a message without waking the agent.
   *
   * @param {{ inject?: unknown }} agent Harness Agent to queue into.
   * @param {unknown} message Message to queue.
   * @returns {boolean} Whether the message was accepted.
   */
  inject(agent, message) {
    if (typeof agent?.inject !== 'function') return false
    agent.inject(message)
    return true
  },

  /**
   * Queue a message and wake the agent at the next turn boundary.
   *
   * @param {{ followup?: unknown }} agent Harness Agent to wake.
   * @param {unknown} message Message to deliver.
   * @returns {boolean} Whether the message was accepted.
   */
  followup(agent, message) {
    if (typeof agent?.followup !== 'function') return false
    agent.followup(message)
    return true
  },

  /**
   * Queue a message and wake the agent inside the current turn.
   *
   * @param {{ steer?: unknown }} agent Harness Agent to wake.
   * @param {unknown} message Message to deliver.
   * @returns {boolean} Whether the message was accepted.
   */
  steer(agent, message) {
    if (typeof agent?.steer !== 'function') return false
    agent.steer(message)
    return true
  },
}
