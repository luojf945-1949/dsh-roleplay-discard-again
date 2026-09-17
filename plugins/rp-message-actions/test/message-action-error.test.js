import assert from 'node:assert/strict'
import test from 'node:test'
import {
  actionError,
  messageActionError,
  messageActionValue,
} from '../src/client-state.js'

/**
 * 缺口 A（`docs/known-limitations.md` LIM-1）的用户可见面：
 * 「当前版本不支持改写助手回复」必须走一个设计过的失败码与文案，
 * 而不是把 Harness 的原文或通用兜底文案丢给用户。
 *
 * 这里用 `node --test` 覆盖文案映射：客户端 vitest 用例（`test:client`）在本机
 * 受限环境跑不起来（需要 worker 子进程），这条路径必须另有真实覆盖。
 */
test('assistant replacement unavailability maps to designed product copy', () => {
  const copy = messageActionError({ code: 'ASSISTANT_REPLACE_UNAVAILABLE' })
  assert.equal(
    copy,
    '当前版本还不支持改写已经生成的回复，编辑、删除和重新生成暂时无法完成；应用更新后可以恢复。',
  )
  // 文案不得泄漏实现术语，也不能退回通用兜底。
  assert.doesNotMatch(copy, /Harness|Session|surface|replace|assistant\/message/i)
  assert.notEqual(copy, '暂时无法完成这次更改，请稍后再试。')
  assert.match(copy, /编辑、删除和重新生成/)
  assert.match(copy, /应用更新后可以恢复/)
})

test('the client resolves the failure code through the nested RPC envelope', () => {
  const envelope = {
    ok: true,
    value: {
      ok: false,
      error: {
        code: 'ASSISTANT_REPLACE_UNAVAILABLE',
        message: 'The Harness baseline rejects assistant/message replacement.',
      },
    },
  }
  let reason
  assert.throws(
    () => messageActionValue(envelope),
    error => { reason = error; return true },
  )
  assert.equal(reason.code, 'ASSISTANT_REPLACE_UNAVAILABLE')
  assert.equal(messageActionError(reason), '当前版本还不支持改写已经生成的回复，编辑、删除和重新生成暂时无法完成；应用更新后可以恢复。')
})

test('unknown codes still fall back to the generic copy', () => {
  assert.equal(messageActionError(actionError('SOMETHING_NEW')), '暂时无法完成这次更改，请稍后再试。')
  assert.equal(messageActionError(undefined), '暂时无法完成这次更改，请稍后再试。')
})
