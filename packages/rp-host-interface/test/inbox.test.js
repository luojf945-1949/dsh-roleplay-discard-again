import assert from 'node:assert/strict'
import test from 'node:test'

import { delivery, readAgentInbox, rearmInboxTail } from '../src/inbox.js'

/**
 * Build a stand-in Harness Agent with an inbox and a wake log.
 *
 * The adapter reads the inbox through plain property access and calls the
 * delivery entry points by name, so a stub faithful to that shape is enough to
 * pin the adapter's own behaviour without booting a Harness.
 *
 * @param {{ nextTurn?: Array<{ id: string }>, nextStep?: Array<{ id: string }> }} [queued] Initial queues.
 * @returns {any} Stub agent plus its wake log.
 */
function stubAgent(queued = {}) {
  const turn = [...(queued.nextTurn ?? [])]
  const step = [...(queued.nextStep ?? [])]
  const woken = []
  return {
    woken,
    inbox: {
      get nextTurn() { return turn },
      get nextStep() { return step },
      remove(id) {
        for (const queue of [turn, step]) {
          const at = queue.findIndex(message => message.id === id)
          if (at >= 0) {
            queue.splice(at, 1)
            return true
          }
        }
        return false
      },
    },
    inject(message) { woken.push(['inject', message.id]) },
    followup(message) { woken.push(['followup', message.id]) },
    steer(message) { woken.push(['steer', message.id]) },
  }
}

test('readAgentInbox reports no inbox for agents that do not expose one', () => {
  assert.equal(readAgentInbox(undefined), undefined)
  assert.equal(readAgentInbox(null), undefined)
  assert.equal(readAgentInbox({}), undefined)
  assert.equal(readAgentInbox({ inbox: {} }), undefined, 'an inbox without remove() is not usable')
})

test('readAgentInbox snapshots both queues and finds queued ids', () => {
  const agent = stubAgent({ nextTurn: [{ id: 'a' }], nextStep: [{ id: 'b' }] })
  const inbox = readAgentInbox(agent)
  assert.ok(inbox)
  assert.deepEqual(inbox.turn.map(m => m.id), ['a'])
  assert.deepEqual(inbox.step.map(m => m.id), ['b'])
  assert.equal(inbox.has('a'), true)
  assert.equal(inbox.has('b'), true)
  assert.equal(inbox.has('missing'), false)
})

test('readAgentInbox reflects the queue as it stands, not as it stood', () => {
  const agent = stubAgent({ nextTurn: [{ id: 'a' }] })
  const inbox = readAgentInbox(agent)
  assert.deepEqual(inbox.turn.map(m => m.id), ['a'])
  agent.inbox.nextTurn.push({ id: 'b' })
  assert.deepEqual(inbox.turn.map(m => m.id), ['a', 'b'], 'a stale snapshot would hide newly queued work')
  agent.inbox.remove('a')
  assert.deepEqual(inbox.turn.map(m => m.id), ['b'])
})

test('readAgentInbox tolerates a missing queue vector', () => {
  const agent = { inbox: { remove: () => false } }
  const inbox = readAgentInbox(agent)
  assert.ok(inbox)
  assert.deepEqual(inbox.turn, [])
  assert.deepEqual(inbox.step, [])
  assert.equal(inbox.has('anything'), false)
})

test('rearmInboxTail ignores ids that are not queued', () => {
  const agent = stubAgent({ nextTurn: [{ id: 'a' }] })
  const inbox = readAgentInbox(agent)
  assert.equal(rearmInboxTail(agent, inbox, new Set(['zzz'])), 'none')
  assert.deepEqual(agent.woken, [], 'an unqueued id must not wake the agent')
})

test('rearmInboxTail treats an empty id set as nothing to do', () => {
  const agent = stubAgent({ nextTurn: [{ id: 'a' }] })
  const inbox = readAgentInbox(agent)
  assert.equal(rearmInboxTail(agent, inbox, new Set()), 'none')
  assert.deepEqual(agent.woken, [])
})

test('rearmInboxTail re-delivers a next-turn message with followup', () => {
  const agent = stubAgent({ nextTurn: [{ id: 'a' }, { id: 'b' }] })
  const inbox = readAgentInbox(agent)
  assert.equal(rearmInboxTail(agent, inbox, new Set(['a', 'b'])), 'woken')
  assert.deepEqual(agent.woken, [['followup', 'b']], 'only the queue tail is re-delivered')
  assert.deepEqual(inbox.turn.map(m => m.id), ['a'], 'the tail was removed before waking')
})

test('rearmInboxTail re-delivers a next-step message with steer', () => {
  const agent = stubAgent({ nextStep: [{ id: 'a' }, { id: 'b' }] })
  const inbox = readAgentInbox(agent)
  assert.equal(rearmInboxTail(agent, inbox, new Set(['a', 'b'])), 'woken')
  assert.deepEqual(agent.woken, [['steer', 'b']])
  assert.deepEqual(inbox.step.map(m => m.id), ['a'])
})

test('rearmInboxTail prefers the next-turn queue when both hold our messages', () => {
  const agent = stubAgent({ nextTurn: [{ id: 't1' }], nextStep: [{ id: 's1' }] })
  const inbox = readAgentInbox(agent)
  assert.equal(rearmInboxTail(agent, inbox, new Set(['t1', 's1'])), 'woken')
  assert.deepEqual(agent.woken, [['followup', 't1']], 'a turn boundary is the normal wake for a replay batch')
})

test('rearmInboxTail leaves unrelated queued work untouched', () => {
  const agent = stubAgent({ nextTurn: [{ id: 'other' }, { id: 'mine' }] })
  const inbox = readAgentInbox(agent)
  assert.equal(rearmInboxTail(agent, inbox, new Set(['mine'])), 'woken')
  assert.deepEqual(agent.woken, [['followup', 'mine']])
  assert.deepEqual(inbox.turn.map(m => m.id), ['other'])
})

test('rearmInboxTail reports unavailable when the agent cannot be woken', () => {
  const agent = stubAgent({ nextTurn: [{ id: 'a' }] })
  const inbox = readAgentInbox(agent)
  delete agent.followup
  assert.equal(rearmInboxTail(agent, inbox, new Set(['a'])), 'unavailable')
  assert.deepEqual(inbox.turn.map(m => m.id), ['a'], 'a refused wake must not consume the message')
})

test('rearmInboxTail reports unavailable when the inbox refuses removal', () => {
  const agent = stubAgent({ nextTurn: [{ id: 'a' }] })
  const inbox = readAgentInbox(agent)
  inbox.remove = () => false
  assert.equal(rearmInboxTail(agent, inbox, new Set(['a'])), 'unavailable')
  assert.deepEqual(agent.woken, [])
})

test('delivery reports refusal instead of throwing when an entry point is absent', () => {
  assert.equal(delivery.inject({}, { id: 'a' }), false)
  assert.equal(delivery.followup({}, { id: 'a' }), false)
  assert.equal(delivery.steer({}, { id: 'a' }), false)
})

test('delivery routes each entry point to its agent method', () => {
  const agent = stubAgent()
  assert.equal(delivery.inject(agent, { id: 'a' }), true)
  assert.equal(delivery.followup(agent, { id: 'b' }), true)
  assert.equal(delivery.steer(agent, { id: 'c' }), true)
  assert.deepEqual(agent.woken, [['inject', 'a'], ['followup', 'b'], ['steer', 'c']])
})
