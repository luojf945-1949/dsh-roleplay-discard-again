#!/usr/bin/env node
/**
 * Repoint the Roleplay suite at a different GitHub account.
 *
 * A fork has to move three things in lockstep or the built package keeps
 * publishing itself under the upstream scope: the npm scope, the repository
 * URLs, and the install instructions in the README.
 *
 * Usage:
 *   node tools/repoint-fork.mjs <github-account>          # rewrite
 *   node tools/repoint-fork.mjs <github-account> --check   # report only
 *
 * The upstream author is always credited in LICENSE/THIRD_PARTY_NOTICES.md and
 * is never rewritten here; only the package scope and repository URLs move.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')

/** The upstream account this fork descends from. */
const UPSTREAM_ACCOUNT = 'lutrodev'

/** The npm scope and repository slug the suite publishes under. */
const PACKAGE_BASENAME = 'dsh-roleplay'

/**
 * Files that carry the npm scope or repository URLs.
 *
 * Kept as an explicit list: a blind repository-wide rewrite would also hit the
 * upstream credits and the dependency pins in the lockfile.
 */
const TARGETS = [
  'package.json',
  'README.md',
  'scripts/build-npm-package.mjs',
]

const [account, ...flags] = process.argv.slice(2)
const checkOnly = flags.includes('--check')

if (account === undefined || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(account)) {
  process.stderr.write(
    'usage: node tools/repoint-fork.mjs <github-account> [--check]\n'
    + '  <github-account> is the GitHub login that owns the fork, e.g. octocat\n',
  )
  process.exitCode = 2
} else {
  const from = `${UPSTREAM_ACCOUNT}/${PACKAGE_BASENAME}`
  const to = `${account}/${PACKAGE_BASENAME}`
  const changes = []

  for (const target of TARGETS) {
    const path = join(projectRoot, target)
    const source = readFileSync(path, 'utf8')
    const count = source.split(from).length - 1
    if (count === 0) continue
    changes.push({ target, count, path, source })
  }

  if (changes.length === 0) {
    process.stdout.write(`No references to ${from} remain; nothing to repoint.\n`)
  } else if (checkOnly) {
    for (const change of changes) {
      process.stderr.write(`${change.target}: ${change.count} reference(s) still point at ${from}\n`)
    }
    process.exitCode = 1
  } else {
    for (const change of changes) {
      writeFileSync(change.path, change.source.split(from).join(to))
      process.stdout.write(`  ${String(change.count).padStart(4)}  ${relative(projectRoot, change.path).replaceAll('\\', '/')}\n`)
    }
    const total = changes.reduce((sum, change) => sum + change.count, 0)
    process.stdout.write(`Repointed ${from} -> ${to}: ${total} references.\n`)
  }
}
