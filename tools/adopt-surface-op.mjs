#!/usr/bin/env node
/**
 * Rename the legacy `surfaceOp` replace keys to the current Harness contract.
 *
 * A replace surface operation is `{ op: 'replace', startSeq, endSeq }`. The
 * suite was written against an earlier spelling that used `start` / `end`, and
 * the Harness now rejects that shape at append time:
 *
 *   session event "assistant/message" carries an invalid replace surfaceOp
 *
 * Only `surfaceOp:` literals are touched. The same `start` / `end` names are
 * also used by JSON Patch operations (`{ op: 'replace', path, value }` has
 * neither key) and by unrelated local objects, so a repository-wide rename
 * would be wrong.
 *
 * Usage:
 *   node tools/adopt-surface-op.mjs          # rewrite
 *   node tools/adopt-surface-op.mjs --check  # report only, exit 1 on drift
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', '.npm-package'])
const EXTENSIONS = new Set(['.js', '.mjs', '.ts'])

/**
 * Match one `surfaceOp: { op: 'replace', ... }` object literal, capturing the
 * opening brace so the two legacy keys can be renamed inside it.
 */
const SURFACE_OP_REPLACE = /surfaceOp:\s*\{\s*op:\s*'replace'[^}]*\}/g

/**
 * Rename legacy keys inside a single replace surface operation.
 *
 * @param {string} literal The matched `surfaceOp: { ... }` text.
 * @returns {{ next: string, changes: number }} Rewritten literal and change count.
 */
function renameKeys(literal) {
  let changes = 0
  const next = literal
    .replace(/([{,]\s*)start(\s*:)/g, (_m, lead, colon) => { changes += 1; return `${lead}startSeq${colon}` })
    .replace(/([{,]\s*)end(\s*:)/g, (_m, lead, colon) => { changes += 1; return `${lead}endSeq${colon}` })
  return { next, changes }
}

const checkOnly = process.argv.slice(2).includes('--check')
const drifted = []
let files = 0
let edits = 0

const visit = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      visit(join(directory, entry.name))
      continue
    }
    if (!entry.isFile() || !EXTENSIONS.has(extname(entry.name))) continue
    const path = join(directory, entry.name)
    const source = readFileSync(path, 'utf8')
    let changed = 0
    const next = source.replace(SURFACE_OP_REPLACE, literal => {
      const result = renameKeys(literal)
      changed += result.changes
      return result.next
    })
    if (changed === 0) continue
    const label = relative(projectRoot, path).replaceAll('\\', '/')
    if (checkOnly) {
      drifted.push({ label, changed })
      continue
    }
    writeFileSync(path, next)
    files += 1
    edits += changed
    process.stdout.write(`  ${String(changed).padStart(3)}  ${label}\n`)
  }
}

for (const group of ['plugins', 'packages']) visit(join(projectRoot, group))

if (checkOnly) {
  if (drifted.length === 0) {
    process.stdout.write('All replace surface operations use startSeq/endSeq.\n')
  } else {
    for (const entry of drifted) process.stderr.write(`${entry.label}: ${entry.changed} legacy surfaceOp key(s)\n`)
    process.exitCode = 1
  }
} else {
  process.stdout.write(
    edits === 0
      ? 'Nothing to rename.\n'
      : `Renamed ${edits} legacy surfaceOp key(s) across ${files} file(s).\n`,
  )
}
