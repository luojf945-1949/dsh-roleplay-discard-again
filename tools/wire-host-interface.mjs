#!/usr/bin/env node
/**
 * Give every package that imports the adapter a dependency on it.
 *
 * The list is derived from the source tree rather than maintained by hand, so
 * adding a consumer cannot silently ship a package whose import cannot resolve.
 *
 * Run after `tools/adopt-host-interface.mjs` rewrites imports.
 * Idempotent: re-running reports what already exists.
 *
 * Usage: node tools/wire-host-interface.mjs
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')

const ADAPTER = 'dsh-roleplay-rp-host-interface'
const ADAPTER_RANGE = 'workspace:^'

/** The adapter itself is where the specifier is defined, not consumed. */
const ADAPTER_PACKAGE = 'packages/rp-host-interface'

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', '.npm-package'])
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.ts'])

/**
 * Find every workspace package whose non-test source imports the adapter.
 *
 * @returns {string[]} Package directory paths relative to the repository root.
 */
function findConsumers() {
  const consumers = new Set()
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name === 'test') continue
        visit(join(directory, entry.name))
        continue
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name))) continue
      const path = join(directory, entry.name)
      const label = relative(projectRoot, path).replaceAll('\\', '/')
      if (label.startsWith(`${ADAPTER_PACKAGE}/`)) continue
      if (!new RegExp(`from '${ADAPTER}(/|')`).test(readFileSync(path, 'utf8'))) continue
      const owner = /^(?:plugins|packages)\/[^/]+/.exec(label)
      if (owner !== null) consumers.add(owner[0])
    }
  }
  for (const group of ['plugins', 'packages']) visit(join(projectRoot, group))
  return [...consumers].sort()
}

let changed = 0
const consumers = findConsumers()

if (consumers.length === 0) {
  process.stdout.write('No package imports the adapter yet; nothing to wire.\n')
} else {
  for (const consumer of consumers) {
    const manifestPath = join(projectRoot, consumer, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const peers = manifest.peerDependencies ?? {}

    if (peers[ADAPTER] === ADAPTER_RANGE) {
      process.stdout.write(`  skip  ${consumer} (already declared)\n`)
      continue
    }

    const next = {
      ...manifest,
      peerDependencies: Object.fromEntries(
        Object.entries({ ...peers, [ADAPTER]: ADAPTER_RANGE })
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    }
    writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
    changed += 1
    process.stdout.write(`  add   ${consumer}  peerDependencies.${ADAPTER}\n`)
  }
}

process.stdout.write(
  changed === 0
    ? 'All consumers already declare the adapter.\n'
    : `Declared the adapter on ${changed} package(s). Next: pnpm install --no-frozen-lockfile.\n`,
)
