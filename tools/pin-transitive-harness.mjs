#!/usr/bin/env node
/**
 * 让 Harness 基线的精确锁定覆盖到传递依赖。
 *
 * `tools/adapt-harness.mjs` 只改写仓库里显式写出的 DSH 声明，并把传递依赖交给
 * `pnpm install` 解析；但 DSH 的预发布版本之间是**互相兼容的 peer 范围**（例如
 * `^0.1.5-rc.1`），所以只要 registry 上出现了更新的预发布版本（`0.1.5-rc.2`），
 * 解析就会把一部分 DSH 包拉到新版本，形成混版依赖图，`pnpm peers check` 随即失败。
 *
 * 本工具从已解析的 lockfile 中取出全部 DSH 包名，在 `pnpm-workspace.yaml` 里写入
 * 一组把每个包都钉到基线版本的 `overrides`，让传递依赖无法漂移。
 *
 * 用法：
 *   node tools/pin-transitive-harness.mjs <version>          # 写入 overrides
 *   node tools/pin-transitive-harness.mjs <version> --check  # 只检查，漂移时退出 1
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const lockfilePath = join(projectRoot, 'pnpm-lock.yaml')
const workspacePath = join(projectRoot, 'pnpm-workspace.yaml')

const OVERRIDES_HEADER = [
  '# DSH 预发布版本之间的 peer 范围会互相兼容，若不在 lockfile 层统一钉住，',
  '# `pnpm install` 会把一部分 DSH 包解析到更新的预发布版本并造成混版依赖图。',
  '# 由 `node tools/pin-transitive-harness.mjs <version>` 生成，请勿手改。',
  'overrides:',
].join('\n')

/**
 * 从一行 lockfile 键中取出包名。
 *
 * lockfile 的键形如 `'@deepseek-ai/dsh-agent@0.1.5-rc.1(peer...)':`，其中版本后面
 * 会跟一长串 peer 解析后缀。这里只取包名本身：剥掉引号，再从**包名与版本之间的
 * 第一个 `@`** 处截断，绝不把版本或 peer 后缀带进 overrides。
 *
 * @param {string} line lockfile 中的一行。
 * @returns {string | undefined} 包名，无法识别时返回 undefined。
 */
function packageNameFromKey(line) {
  const match = /^ {2}('?)(.+?)\1:\s*$/.exec(line)
  if (match === null) return undefined
  const key = match[2]
  const at = key.indexOf('@', 1)
  if (at === -1) return undefined
  const name = key.slice(0, at)
  return /^@deepseek-ai\/dsh(?:-[a-z0-9-]+)?$/.test(name) ? name : undefined
}

/**
 * 从 lockfile 的 packages 段取出全部 DSH 包名。
 *
 * @param {string} source lockfile 内容。
 * @returns {string[]} 去重并排序后的包名。
 */
function collectDshPackageNames(source) {
  const names = new Set()
  for (const line of source.split('\n')) {
    const name = packageNameFromKey(line)
    if (name !== undefined) names.add(name)
  }
  return [...names].sort()
}

/**
 * 渲染 overrides 段。
 *
 * @param {string[]} names 包名。
 * @param {string} version 基线版本。
 * @returns {string} YAML 文本。
 */
function renderOverrides(names, version) {
  const lines = names.map(name => `  '${name}': ${version}`)
  return `${OVERRIDES_HEADER}\n${lines.join('\n')}\n`
}

/** 探测 lockfile 中出现的非基线 DSH 版本。 */
function findDriftedVersions(source, version) {
  const drifted = new Map()
  const pattern = /'?@deepseek-ai\/(dsh(?:-[a-z0-9-]+)?)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g
  for (const match of source.matchAll(pattern)) {
    const found = match[2]
    if (found === version) continue
    const name = `@deepseek-ai/${match[1]}`
    if (!drifted.has(name)) drifted.set(name, new Set())
    drifted.get(name).add(found)
  }
  return drifted
}

const [requestedVersion, ...flags] = process.argv.slice(2)
const checkOnly = flags.includes('--check')

if (requestedVersion === undefined || !/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(requestedVersion)) {
  process.stderr.write('usage: node tools/pin-transitive-harness.mjs <version> [--check]\n')
  process.exitCode = 2
} else if (!existsSync(lockfilePath)) {
  process.stderr.write('pnpm-lock.yaml 不存在；先运行 pnpm install。\n')
  process.exitCode = 1
} else {
  const lockfile = readFileSync(lockfilePath, 'utf8')
  const names = collectDshPackageNames(lockfile)
  const drifted = findDriftedVersions(lockfile, requestedVersion)

  if (names.length === 0) {
    process.stderr.write('pnpm-lock.yaml 中没有解析出任何 DSH 包；lockfile 可能不完整。\n')
    process.exitCode = 1
  } else if (checkOnly) {
    if (drifted.size > 0) {
      const detail = [...drifted].map(([name, versions]) => `${name} -> ${[...versions].join(', ')}`).join('\n- ')
      process.stderr.write(`DSH 传递依赖漂移（基线 ${requestedVersion}）：\n- ${detail}\n`)
      process.exitCode = 1
    } else {
      process.stdout.write(`DSH 传递依赖全部为 ${requestedVersion}（${names.length} 个包）。\n`)
    }
  } else {
    const source = readFileSync(workspacePath, 'utf8')
    const block = renderOverrides(names, requestedVersion)
    const withoutExisting = source.replace(/\n# DSH 预发布版本之间的 peer 范围[\s\S]*?^overrides:\n(?: {2}'\S+': \S+\n)*/m, '\n')
    const anchor = 'linkWorkspacePackages: true'
    if (!withoutExisting.includes(anchor)) {
      process.stderr.write(`pnpm-workspace.yaml 中找不到锚点 ${JSON.stringify(anchor)}。\n`)
      process.exitCode = 1
    } else {
      const next = withoutExisting.replace(anchor, `${block}\n${anchor}`)
      writeFileSync(workspacePath, next)
      process.stdout.write(
        `已把 ${names.length} 个 DSH 包钉到 ${requestedVersion}。\n`
        + 'Next: pnpm install --no-frozen-lockfile，然后 pnpm run check:compat。\n',
      )
    }
  }
}
