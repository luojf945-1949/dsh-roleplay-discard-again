import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  LIMITATIONS_DOC,
  expectedRuntimeSkips,
  loadKnownLimitations,
  parseKnownLimitations,
  skipScopeOf,
} from './lib/known-limitations.mjs'
import { findSkipRegistryProblems, scanSkipSites } from './check-test-skips.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SAMPLE = `# 已知限制

## LIM-1 · 示例限制

- 状态：known
- 原因：某个上游契约冲突。
- 受影响的用户能力：编辑与删除。
- 自动恢复条件：上游放宽后自动恢复。

## 测试跳过登记表

| 跳过来源 | 关联条目 | 源码热点数 | 运行时跳过数 | 备注 |
| --- | --- | --- | --- | --- |
| plugins/demo/test/support.js | LIM-1 | 1 | 0 | 探测模块，本文件不跳过用例 |
| plugins/demo/test/demo.test.js | LIM-1 | 2 | 3 | 其中一个注解位于循环内 |
`

test('parses limitation fields and skip rows from the registry document', () => {
  const parsed = parseKnownLimitations(SAMPLE)
  assert.deepEqual([...parsed.limitations.keys()], ['LIM-1'])
  const limitation = parsed.limitations.get('LIM-1')
  assert.equal(limitation.status, 'known')
  assert.equal(limitation.reason, '某个上游契约冲突。')
  assert.equal(limitation.capabilities, '编辑与删除。')
  assert.equal(limitation.recovery, '上游放宽后自动恢复。')
  assert.deepEqual(parsed.skipRows.map(row => [row.path, row.sites, row.runtime]), [
    ['plugins/demo/test/support.js', 1, 0],
    ['plugins/demo/test/demo.test.js', 2, 3],
  ])
  assert.deepEqual(parsed.problems, [])
})

test('reports missing fields, missing notes and unknown limitation references', () => {
  const broken = parseKnownLimitations(`## LIM-1 · 缺字段

- 状态：known
- 原因：只有原因。

## 测试跳过登记表

| 跳过来源 | 关联条目 | 源码热点数 | 运行时跳过数 | 备注 |
| --- | --- | --- | --- | --- |
| plugins/demo/test/support.js | LIM-1 | 2 | 1 | — |
| plugins/demo/test/support.js | LIM-9 | 1 | 0 | — |
`)
  assert.ok(broken.problems.some(problem => problem.includes('受影响的用户能力')))
  assert.ok(broken.problems.some(problem => problem.includes('自动恢复条件')))
  assert.ok(broken.problems.some(problem => problem.includes('必须在备注里写明原因')))
  const withReferenceCheck = parseKnownLimitations(`## LIM-1 · x

- 状态：known
- 原因：y。
- 受影响的用户能力：z。
- 自动恢复条件：w。

## 测试跳过登记表

| 跳过来源 | 关联条目 | 源码热点数 | 运行时跳过数 | 备注 |
| --- | --- | --- | --- | --- |
| plugins/demo/test/support.js | LIM-9 | 1 | 0 | — |
`)
  assert.ok(withReferenceCheck.problems.some(problem => problem.includes('不存在的条目 LIM-9')))
})

test('flags unregistered sites, count drift and stale rows', () => {
  const registry = parseKnownLimitations(SAMPLE)
  const sites = new Map([
    ['plugins/demo/test/support.js', [{ id: 'skip-option', line: 3 }]],
    ['plugins/demo/test/demo.test.js', [{ id: 'probe-spread', line: 5 }, { id: 'probe-spread', line: 9 }]],
    ['plugins/other/test/extra.test.js', [{ id: 'probe-spread', line: 1 }]],
  ])
  const problems = findSkipRegistryProblems(sites, registry)
  assert.ok(problems.some(problem => problem.includes('plugins/other/test/extra.test.js') && problem.includes('未登记')))

  const drifted = findSkipRegistryProblems(new Map([
    ['plugins/demo/test/support.js', [{ id: 'skip-option', line: 3 }]],
    ['plugins/demo/test/demo.test.js', [{ id: 'probe-spread', line: 5 }]],
  ]), registry)
  assert.ok(drifted.some(problem => problem.includes('声明 2 处源码热点，实际扫描到 1 处')))

  const stale = findSkipRegistryProblems(new Map([
    ['plugins/demo/test/support.js', [{ id: 'skip-option', line: 3 }]],
  ]), registry)
  assert.ok(stale.some(problem => problem.includes('登记已过期')))
})

test('maps skip sources to their run scope', () => {
  assert.equal(skipScopeOf('plugins/rp-core/test/runtime.test.js'), 'plugins/rp-core')
  assert.equal(skipScopeOf('packages/rp-ui/test/index.test.js'), 'packages/rp-ui')
  assert.equal(skipScopeOf('tools/check-test-skips.test.mjs'), 'root')
  assert.equal(expectedRuntimeSkips([
    { path: 'plugins/rp-core/test/a.test.js', runtime: 2 },
    { path: 'plugins/rp-source/test/b.test.js', runtime: 5 },
    { path: 'plugins/rp-core/test/c.test.js', runtime: 1 },
  ], 'plugins/rp-core'), 3)
})

test('the checked-in registry covers every skip site in the repository', () => {
  const registry = loadKnownLimitations(projectRoot)
  assert.deepEqual(registry.problems, [])
  const problems = findSkipRegistryProblems(scanSkipSites(projectRoot), registry)
  assert.deepEqual(problems, [])
  const runtime = registry.skipRows.reduce((sum, row) => sum + row.runtime, 0)
  assert.ok(runtime > 0)
  assert.match(readFileSync(resolve(projectRoot, LIMITATIONS_DOC), 'utf8'), /ASSISTANT_REPLACE_UNAVAILABLE|LIM-1/)
})
