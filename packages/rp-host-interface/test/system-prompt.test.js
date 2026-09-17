import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HARNESS_IDENTITY_SLOT,
  registerPromptSection,
  ROLEPLAY_IDENTITY_SECTION,
} from '../src/system-prompt.js'

/**
 * Build a stand-in Harness prompt service that records registrations.
 *
 * @param {Record<string, number>} [slots] Ordering slots the service resolves.
 * @returns {any} Stub context plus its registration log.
 */
function stubContext(slots = { HARNESS_IDENTITY: 100 }) {
  const registered = []
  return {
    registered,
    systemPrompt: {
      getSectionOrder(name) {
        if (!(name in slots)) throw new Error(`unknown slot ${name}`)
        return slots[name]
      },
      section(section) {
        registered.push(section)
      },
    },
  }
}

test('registerPromptSection reports false when the prompt service is absent', () => {
  assert.equal(registerPromptSection({}, { name: 'x', slot: 'S', text: () => '' }), false)
  assert.equal(registerPromptSection({ systemPrompt: {} }, { name: 'x', slot: 'S', text: () => '' }), false)
})

test('registerPromptSection resolves the ordering slot from the service', () => {
  const ctx = stubContext({ HARNESS_IDENTITY: 42 })
  assert.equal(registerPromptSection(ctx, {
    name: ROLEPLAY_IDENTITY_SECTION,
    slot: HARNESS_IDENTITY_SLOT,
    text: () => 'identity',
  }), true)
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].order, 42, 'the numeric slot must come from the Harness, not from this suite')
  assert.equal(ctx.registered[0].name, 'harness:identity')
})

test('registerPromptSection keeps the text provider lazy', () => {
  const ctx = stubContext()
  let calls = 0
  registerPromptSection(ctx, {
    name: ROLEPLAY_IDENTITY_SECTION,
    slot: HARNESS_IDENTITY_SLOT,
    text: () => { calls += 1; return 'identity' },
  })
  assert.equal(calls, 0, 'registering must not evaluate the text')
  assert.equal(ctx.registered[0].text(), 'identity')
  assert.equal(calls, 1)
})

test('registerPromptSection rejects an unusable section definition loudly', () => {
  const ctx = stubContext()
  assert.throws(() => registerPromptSection(ctx, { name: '', slot: 'S', text: () => '' }), /non-empty string/)
  assert.throws(() => registerPromptSection(ctx, { name: 'x', slot: '', text: () => '' }), /ordering slot/)
  assert.throws(() => registerPromptSection(ctx, { name: 'x', slot: 'S', text: 'not a function' }), /text provider/)
  assert.equal(ctx.registered.length, 0, 'a rejected section must not be half-registered')
})

test('registerPromptSection surfaces an unknown slot instead of guessing an order', () => {
  const ctx = stubContext({})
  assert.throws(() => registerPromptSection(ctx, {
    name: ROLEPLAY_IDENTITY_SECTION,
    slot: HARNESS_IDENTITY_SLOT,
    text: () => '',
  }), /unknown slot/)
})
