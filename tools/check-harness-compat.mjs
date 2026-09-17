#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const modulePath = fileURLToPath(import.meta.url)
const projectRoot = resolve(dirname(modulePath), '..')

if (process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath) {
  runCompatibilityCheck()
}

function runCompatibilityCheck() {
  const packagesRoot = join(projectRoot, 'packages')
  const pluginsRoot = join(projectRoot, 'plugins')
  const rootManifest = readManifest(join(projectRoot, 'package.json'))
  const managerManifestPath = join(pluginsRoot, 'rp-feature-manager', 'package.json')
  const managerManifest = readManifest(managerManifestPath)
  const suiteVersion = managerManifest.dsh?.roleplay?.suiteVersion
  const requiredDshVersion = managerManifest.dsh?.roleplay?.requiresDsh
  const requiredNode = rootManifest.engines?.node
  const exactDshVersion = typeof requiredDshVersion === 'string' && /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(requiredDshVersion)
    ? requiredDshVersion
    : undefined
  const lockfilePath = join(projectRoot, 'pnpm-lock.yaml')

  const problems = []
  if (typeof suiteVersion !== 'string' || suiteVersion.length === 0) {
    problems.push(`${relative(projectRoot, managerManifestPath)}: 缺少 dsh.roleplay.suiteVersion`)
  }
  if (exactDshVersion === undefined) {
    problems.push(`${relative(projectRoot, managerManifestPath)}: dsh.roleplay.requiresDsh 必须固定到明确的 DSH 预发布版本`)
  }
  if (typeof requiredNode !== 'string' || requiredNode.length === 0) {
    problems.push('package.json: 缺少有效的 engines.node')
  }
  if (rootManifest.devDependencies?.['@deepseek-ai/dsh'] !== exactDshVersion) {
    problems.push(`package.json: devDependencies.@deepseek-ai/dsh 应固定为 ${String(exactDshVersion)}`)
  }

  const manifestRecords = [{
    importerId: '.',
    label: 'package.json',
    manifest: rootManifest,
  }]
  let dshDependencyCount = 0
  for (const workspaceRoot of [packagesRoot, pluginsRoot]) {
    for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifestPath = join(workspaceRoot, entry.name, 'package.json')
      let manifest
      try {
        manifest = readManifest(manifestPath)
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      const label = relative(projectRoot, manifestPath)
      manifestRecords.push({
        importerId: relative(projectRoot, dirname(manifestPath)).replaceAll('\\', '/'),
        label,
        manifest,
      })
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith('dsh-roleplay-')) {
        problems.push(`${label}: package name 必须以 dsh-roleplay- 开头`)
      }
      if (manifest.version !== suiteVersion) {
        problems.push(`${label}: Roleplay package 版本应与组合版本 ${suiteVersion} 一致，当前为 ${String(manifest.version)}`)
      }
      if (manifest.engines?.node !== requiredNode) {
        problems.push(`${label}: engines.node 应为 ${JSON.stringify(requiredNode)}`)
      }

      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
          if (typeof specifier === 'string' && /^(?:file|link):/.test(specifier)) {
            problems.push(`${label}: ${field}.${name} 不得引用仓库外本地路径`)
          }
          if (!name.startsWith('@deepseek-ai/dsh-')) continue
          dshDependencyCount += 1
          if (specifier !== exactDshVersion) {
            problems.push(`${label}: ${field}.${name} 应精确锁定为 ${exactDshVersion}，当前为 ${String(specifier)}`)
          }
        }
      }
    }
  }

  let lockedDshPackageCount = 0
  try {
    const lockfile = parseYaml(readFileSync(lockfilePath, 'utf8'))
    const lockfileResult = findHarnessLockfileProblems({
      exactDshVersion,
      lockfile,
      manifestRecords,
    })
    problems.push(...lockfileResult.problems)
    lockedDshPackageCount = lockfileResult.lockedDshPackageCount
  } catch (error) {
    problems.push(`pnpm-lock.yaml: 无法解析：${error instanceof Error ? error.message : String(error)}`)
  }

  const peerCheck = runPeerDependencyCheck()
  if (!peerCheck.ok) {
    problems.push(`pnpm-lock.yaml: peer 依赖图检查失败${peerCheck.detail.length > 0 ? `：${peerCheck.detail}` : ''}`)
  }

  if (problems.length > 0) {
    process.stderr.write(`Harness 兼容性检查失败：\n- ${problems.join('\n- ')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`Harness 兼容性检查通过：Roleplay ${suiteVersion}，DSH ${exactDshVersion}，${manifestRecords.length - 1} 个 workspace package，${dshDependencyCount} 项 DSH 声明，锁定 ${lockedDshPackageCount} 个 DSH package，peer 依赖图有效，Node ${requiredNode}。\n`)
  }
}

function readManifest(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function findHarnessLockfileProblems({ exactDshVersion, lockfile, manifestRecords }) {
  const lockProblems = []
  const importers = lockfile?.importers
  if (importers === null || typeof importers !== 'object' || Array.isArray(importers)) {
    return {
      lockedDshPackageCount: 0,
      problems: ['pnpm-lock.yaml: 缺少有效的 importers'],
    }
  }

  for (const { importerId, label, manifest } of manifestRecords) {
    const importer = importers[importerId]
    if (importer === null || typeof importer !== 'object' || Array.isArray(importer)) {
      lockProblems.push(`pnpm-lock.yaml: 缺少 ${label} 对应的 importer ${JSON.stringify(importerId)}`)
      continue
    }

    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
        if (!isDshPackage(name)) continue
        const locked = importer[field]?.[name]
        if (locked === undefined) {
          lockProblems.push(`pnpm-lock.yaml: ${label} 的 ${field}.${name} 缺少锁定结果`)
          continue
        }
        const lockedSpecifier = typeof locked === 'string' ? undefined : locked?.specifier
        if (lockedSpecifier !== undefined && lockedSpecifier !== specifier) {
          lockProblems.push(`pnpm-lock.yaml: ${label} 的 ${field}.${name} specifier 应为 ${String(specifier)}，当前为 ${String(lockedSpecifier)}`)
        }
        const version = resolvedRegistryVersion(locked)
        if (version !== exactDshVersion) {
          lockProblems.push(`pnpm-lock.yaml: ${label} 的 ${field}.${name} 应解析为 ${String(exactDshVersion)}，当前为 ${String(version ?? lockedVersion(locked))}`)
        }
      }
    }
  }

  const lockedDshPackages = new Set()
  const packages = lockfile?.packages
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    lockProblems.push('pnpm-lock.yaml: 缺少有效的 packages')
  } else {
    for (const dependencyPath of Object.keys(packages)) {
      const identity = parseDshDependencyPath(dependencyPath)
      if (identity === undefined) continue
      lockedDshPackages.add(`${identity.name}@${identity.version}`)
      if (identity.version !== exactDshVersion) {
        lockProblems.push(`pnpm-lock.yaml: ${identity.name} 应锁定为 ${String(exactDshVersion)}，当前为 ${identity.version}`)
      }
    }
  }

  return {
    lockedDshPackageCount: lockedDshPackages.size,
    problems: lockProblems,
  }
}

function isDshPackage(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

function lockedVersion(entry) {
  return typeof entry === 'string' ? entry : entry?.version
}

export function resolvedRegistryVersion(entry) {
  const version = lockedVersion(entry)
  if (typeof version !== 'string' || /^(?:file|link|workspace):/.test(version)) return undefined
  return version.split('(', 1)[0]
}

export function parseDshDependencyPath(dependencyPath) {
  if (typeof dependencyPath !== 'string') return undefined
  const match = /^(@deepseek-ai\/dsh(?:-[^@()]+)?)@(\d+\.\d+\.\d+(?:-[^()]+)?)(?:\(|$)/.exec(dependencyPath)
  if (match === null) return undefined
  return { name: match[1], version: match[2] }
}

function runPeerDependencyCheck() {
  const args = ['peers', 'check', '--lockfile-only']
  const npmExecPath = process.env.npm_execpath
  const usesPnpm = typeof npmExecPath === 'string'
    && basename(npmExecPath).toLowerCase().includes('pnpm')
  const capture = createOutputCapture()
  let result
  try {
    result = usesPnpm
      ? spawnSync(process.execPath, [npmExecPath, ...args], peerCheckOptions(capture.fd))
      : spawnSync('pnpm', args, { ...peerCheckOptions(capture.fd), shell: process.platform === 'win32' })
  } finally {
    capture.close()
  }
  const output = capture.read().trim()
  if (result.error !== undefined) {
    return { detail: result.error.message, ok: false }
  }
  return {
    detail: output.replaceAll(/\s*\n\s*/g, ' | '),
    ok: result.status === 0,
  }
}

/**
 * 把子进程输出落到临时文件而非管道。
 *
 * 受限环境会拒绝管道 stdio（`spawn EPERM`），而文件句柄放行——`run-package-tests.mjs`
 * 用的是同一手法。pnpm 的 peer 图检查本身仍照常真实执行，成败仍取子进程退出码，
 * 只是失败时的原始输出改为从文件读回，不再经 stdout/stderr 管道。
 *
 * @returns {{ fd: number, close: () => void, read: () => string }} 捕获句柄。
 */
function createOutputCapture() {
  const logPath = join(tmpdir(), `dsh-check-harness-compat-${process.pid}.log`)
  const fd = openSync(logPath, 'w')
  return {
    fd,
    close() {
      closeSync(fd)
    },
    read() {
      try {
        return readFileSync(logPath, 'utf8')
      } catch {
        return ''
      } finally {
        rmSync(logPath, { force: true })
      }
    },
  }
}

function peerCheckOptions(fd) {
  return {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', fd, fd],
  }
}
