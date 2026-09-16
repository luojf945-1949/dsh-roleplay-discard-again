#!/usr/bin/env node
/**
 * Retarget this Roleplay suite onto the configured DeepSeek Harness version.
 *
 * Every DSH declaration in this repository is an **exact** pin, and the suite
 * also ships an allowlist of those pins. Bumping the Harness baseline is
 * therefore a mechanical, repository-wide rewrite rather than a hand edit,
 * and this script is the single place that knows how to perform it.
 *
 * Usage:
 *   node tools/adapt-harness.mjs <version>          # rewrite (e.g. 0.1.5-rc.1)
 *   node tools/adapt-harness.mjs <version> --check  # report only, exit 1 on drift
 *
 * The lockfile is intentionally never rewritten here: `pnpm install` owns it.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')

/** Text formats that carry DSH version pins or package names. */
const TEXT_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.mjs', '.js', '.cjs', '.ts', '.md'])

/** Directories that are generated or vendored, never hand-edited. */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', '.npm-package'])

/** The lockfile is resolved by the package manager, not by string rewriting. */
const SKIP_FILES = new Set(['pnpm-lock.yaml'])

/**
 * Matches any published DSH version, including pre-release and build tags.
 *
 * Deliberately anchored to the `0.1.x` line so the sweep cannot touch unrelated
 * third-party versions that happen to share the working tree.
 */
const DSH_VERSION_PATTERN = /\b0\.1\.\d+(?:-[0-9A-Za-z.-]+)?\b/g

/**
 * Discover every text file in the repository that version pins may appear in.
 *
 * @returns {string[]} Absolute file paths.
 */
function collectTargets() {
  const targets = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        visit(join(directory, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      if (!TEXT_EXTENSIONS.has(extname(entry.name))) continue
      const path = join(directory, entry.name)
      if (SKIP_FILES.has(relative(projectRoot, path).replaceAll('\\', '/'))) continue
      targets.push(path)
    }
  }
  visit(projectRoot)
  return targets.sort()
}

/**
 * Read the exact Harness version this repository currently declares.
 *
 * The suite treats `dsh.roleplay.requiresDsh` in the feature manager manifest as
 * the authoritative declaration; everything else must agree with it.
 *
 * @returns {string | undefined} The declared version, or undefined when absent.
 */
function readDeclaredVersion() {
  const manifestPath = join(projectRoot, 'plugins', 'rp-feature-manager', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const declared = manifest.dsh?.roleplay?.requiresDsh
  return typeof declared === 'string' && declared.length > 0 ? declared : undefined
}

/** @param {string} value @returns {boolean} */
function isValidVersion(value) {
  return /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(value)
}

const [requestedVersion, ...flags] = process.argv.slice(2)
const checkOnly = flags.includes('--check')

if (requestedVersion === undefined || !isValidVersion(requestedVersion)) {
  process.stderr.write(
    'usage: node tools/adapt-harness.mjs <version> [--check]\n'
    + '  <version> must be an exact published Harness version, e.g. 0.1.5-rc.1\n',
  )
  process.exitCode = 2
} else {
  const declaredVersion = readDeclaredVersion()
  if (declaredVersion === undefined) {
    process.stderr.write('plugins/rp-feature-manager/package.json: dsh.roleplay.requiresDsh is missing or invalid\n')
    process.exitCode = 1
  } else if (declaredVersion === requestedVersion) {
    process.stdout.write(`Harness baseline is already ${requestedVersion}; nothing to rewrite.\n`)
  } else if (checkOnly) {
    process.stderr.write(`Harness baseline drift: declared ${declaredVersion}, expected ${requestedVersion}\n`)
    process.exitCode = 1
  } else {
    const rewritten = []
    let occurrences = 0

    for (const path of collectTargets()) {
      const source = readFileSync(path, 'utf8')
      const matches = source.match(DSH_VERSION_PATTERN)
      if (matches === null || !matches.includes(declaredVersion)) continue
      const next = source.replaceAll(declaredVersion, requestedVersion)
      const count = source.split(declaredVersion).length - 1
      writeFileSync(path, next)
      occurrences += count
      rewritten.push({ path: relative(projectRoot, path).replaceAll('\\', '/'), count })
    }

    for (const entry of rewritten) {
      process.stdout.write(`  ${String(entry.count).padStart(5)}  ${entry.path}\n`)
    }
    process.stdout.write(
      `Retargeted Harness ${declaredVersion} -> ${requestedVersion}: `
      + `${occurrences} occurrences across ${rewritten.length} files.\n`
      + 'Next: pnpm install --no-frozen-lockfile, then pnpm run check:compat.\n',
    )
  }
}
