import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'

import {
  discoverWorkspacePackages,
  isSupportedNodeVersion,
  parseArguments,
  projectRoot,
  resolveDevelopmentPaths,
  shouldRestartForPath,
  withDefaultWebArguments,
} from './dev.mjs'

test('开发参数与 Web 参数分离', () => {
  assert.deepEqual(
    parseArguments(['--no-watch', '--skip-build', '--', '--port', '3090']),
    {
      build: false,
      dshArgs: ['--port', '3090'],
      dumpConfig: false,
      help: false,
      watch: false,
    },
  )
  assert.equal(parseArguments(['--dump-config']).dumpConfig, true)
})

test('Web 调试默认只监听本机，并允许覆盖端口和地址', () => {
  assert.deepEqual(withDefaultWebArguments([]), [
    '--port',
    '3080',
    '--host',
    '127.0.0.1',
    '--no-open',
  ])
  assert.deepEqual(
    withDefaultWebArguments(['--host=0.0.0.0', '--port', '3090']),
    ['--host=0.0.0.0', '--port', '3090', '--no-open'],
  )
})

test('Node.js 版本边界与 package.json 一致', () => {
  assert.equal(isSupportedNodeVersion('22.18.9'), false)
  assert.equal(isSupportedNodeVersion('22.19.0'), true)
  assert.equal(isSupportedNodeVersion('23.9.0'), false)
  assert.equal(isSupportedNodeVersion('24.0.0'), true)
})

test('默认开发产物写入 Git 忽略目录，并使用专用覆盖变量', () => {
  assert.deepEqual(resolveDevelopmentPaths({}), {
    dataDirectory: join(projectRoot, '.dsh-dev', 'data'),
    dshHome: join(projectRoot, '.dsh-dev', 'harness'),
  })
  assert.deepEqual(resolveDevelopmentPaths({
    DSH_ROLEPLAY_DEV_DATA_DIR: 'tmp/data',
    DSH_ROLEPLAY_DEV_HOME: 'tmp/harness',
  }), {
    dataDirectory: join(projectRoot, 'tmp', 'data'),
    dshHome: join(projectRoot, 'tmp', 'harness'),
  })
})

test('只监听会影响运行结果的源码与配置', () => {
  assert.equal(shouldRestartForPath('src/index.js'), true)
  assert.equal(shouldRestartForPath('cordis.patch.yml'), true)
  assert.equal(shouldRestartForPath('scripts/generate-styles.mjs'), true)
  assert.equal(shouldRestartForPath('src/client-styles.generated.js'), false)
  assert.equal(shouldRestartForPath('dist/client.js'), false)
  assert.equal(shouldRestartForPath('test/index.test.js'), false)
  assert.equal(shouldRestartForPath('README.md'), false)
})

test('发现整套插件和共享基础 package', () => {
  const packages = discoverWorkspacePackages()
  const names = packages.map(workspacePackage => workspacePackage.name)
  assert.equal(new Set(names).size, names.length)
  // 期望集合来自工作区声明与目录本身，而不是硬编码数量：适配层新增
  // `packages/rp-host-interface` 后，写死的 25 静默过期，而该用例当时正被父级取消
  // 掩盖（`node --test --experimental-test-isolation=none scripts/dev.test.mjs` 可见）。
  // 现在断言「发现的集合 == 工作区声明的集合」，新增或删除 workspace package 都会自动跟随，
  // 同时仍能挡住漏发现、重复名、清单与目录不一致这几类真实回归。
  const declared = []
  for (const group of declaredWorkspaceGroups()) {
    for (const entry of readdirSync(join(projectRoot, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifestPath = join(projectRoot, group, entry.name, 'package.json')
      if (!existsSync(manifestPath)) continue
      declared.push(JSON.parse(readFileSync(manifestPath, 'utf8')).name)
    }
  }
  assert.deepEqual(names, [...declared].sort())
  assert.ok(names.length > 0)
  assert.ok(names.includes('dsh-roleplay-rp-compact-access-mode'))
  assert.ok(names.includes('dsh-roleplay-rp-conversation-summary'))
  assert.ok(names.includes('dsh-roleplay-rp-feature-manager'))
  assert.ok(names.includes('dsh-roleplay-rp-host-interface'))
  assert.ok(names.includes('dsh-roleplay-rp-quick-replies'))
  assert.ok(names.includes('dsh-roleplay-rp-reply-options'))
  assert.ok(names.includes('dsh-roleplay-rp-remote'))
  assert.ok(names.includes('dsh-roleplay-rp-state-display'))
  assert.ok(names.includes('dsh-roleplay-rp-ui'))
})

/** `pnpm-workspace.yaml` 声明的 `group/*` 工作区分组，按声明顺序返回。 */
function declaredWorkspaceGroups() {
  const workspace = parseYaml(readFileSync(join(projectRoot, 'pnpm-workspace.yaml'), 'utf8'))
  const groups = []
  for (const pattern of workspace.packages ?? []) {
    const [group, child] = String(pattern).split('/')
    if (child === '*' && !groups.includes(group)) groups.push(group)
  }
  return groups
}
