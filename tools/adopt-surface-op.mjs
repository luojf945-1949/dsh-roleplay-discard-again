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
 * The legacy spelling survives in **two** shapes, and both have to be renamed:
 *
 *   1. **Literals** — `surfaceOp: { op: 'replace', start: a, end: b }`.
 *      The Harness rejects these at append time, loudly.
 *   2. **Reads** — `event.surfaceOp.start`. The Harness never rejects these;
 *      `SurfaceOp` simply has no `start` field, so the read yields `undefined`
 *      and any guard built on it silently stops matching. These are the more
 *      dangerous half because nothing fails and no test notices.
 *
 * Neither rename is repository-wide. The same `start` / `end` names appear in
 * JSON Patch operations (`{ op: 'replace', path, value }` has neither key), in
 * unrelated local objects, and in navigation state, so both patterns are
 * anchored to `surfaceOp` specifically.
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

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.npm-package', '.pnpm-store'])
const EXTENSIONS = new Set(['.js', '.mjs', '.ts'])

/** 构建产物：真正的修复点在源码，重建对应插件后这些会自行消失。 */
const isGenerated = label => label.includes('/dist/')

/**
 * Match one `surfaceOp: { op: 'replace', ... }` object literal, capturing the
 * opening brace so the two legacy keys can be renamed inside it.
 *
 * `[^}]*` stops at the first closing brace, which is safe here: the replace
 * variant carries only `op` plus the two seq bounds, so it has no nesting.
 */
const SURFACE_OP_LITERAL = /surfaceOp:\s*\{\s*op:\s*'replace'[^}]*\}/g

/** Match a read of a legacy key off a surfaceOp, e.g. `event.surfaceOp?.start`. */
const SURFACE_OP_READ = /\.surfaceOp(\s*\??\.\s*)(start|end)\b/g

/**
 * Rename legacy keys inside a single replace surface operation literal.
 *
 * @param {string} literal The matched `surfaceOp: { ... }` text.
 * @returns {{ next: string, changes: number }} Rewritten literal and change count.
 */
function renameLiteralKeys(literal) {
  let changes = 0
  const next = literal
    .replace(/([{,]\s*)start(\s*:)/g, (_m, lead, colon) => { changes += 1; return `${lead}startSeq${colon}` })
    .replace(/([{,]\s*)end(\s*:)/g, (_m, lead, colon) => { changes += 1; return `${lead}endSeq${colon}` })
  return { next, changes }
}

/**
 * Rename legacy key reads off a surfaceOp, preserving the accessor style.
 *
 * `event.surfaceOp.start` becomes `event.surfaceOp.startSeq`, and
 * `event.surfaceOp?.end` becomes `event.surfaceOp?.endSeq`.
 *
 * @param {string} text Source text.
 * @param {number} line 1-based line number, for reporting.
 * @param {(entry: { line: number, from: string, to: string }) => void} record Change sink.
 * @returns {string} Rewritten text.
 */
function renameReads(text, line, record) {
  return text.replace(SURFACE_OP_READ, (match, accessor, field) => {
    const to = field === 'start' ? 'startSeq' : 'endSeq'
    record({ line, from: `surfaceOp${accessor.replaceAll(/\s/g, '')}${field}`, to: `surfaceOp${accessor.replaceAll(/\s/g, '')}${to}` })
    return `.surfaceOp${accessor}${to}`
  })
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
    const label = relative(projectRoot, path).replaceAll('\\', '/')
    const source = readFileSync(path, 'utf8')
    let changed = 0

    let next = source.replace(SURFACE_OP_LITERAL, literal => {
      const result = renameLiteralKeys(literal)
      changed += result.changes
      return result.next
    })

    // Reads are renamed per line so the report can name the exact location.
    next = next
      .split('\n')
      .map((line, index) => renameReads(line, index + 1, () => { changed += 1 }))
      .join('\n')

    if (changed === 0) continue
    const record = { label, changed, generated: isGenerated(label) }
    if (checkOnly) {
      drifted.push(record)
      continue
    }
    writeFileSync(path, next)
    files += 1
    edits += changed
    process.stdout.write(`  ${String(changed).padStart(3)}  ${label}${record.generated ? '  (构建产物)' : ''}\n`)
  }
}

for (const group of ['plugins', 'packages']) visit(join(projectRoot, group))

if (checkOnly) {
  if (drifted.length === 0) {
    process.stdout.write('All replace surface operations use startSeq/endSeq, in both literals and reads.\n')
  } else {
    const source = drifted.filter(entry => !entry.generated)
    const generated = drifted.filter(entry => entry.generated)
    for (const entry of drifted) {
      process.stderr.write(`${entry.label}: ${entry.changed} legacy surfaceOp key(s)${entry.generated ? ' [构建产物]' : ''}\n`)
    }
    if (generated.length > 0 && source.length === 0) {
      process.stderr.write('\n仅构建产物残留；重建对应插件后即可消失。\n')
    }
    process.exitCode = 1
  }
} else {
  process.stdout.write(
    edits === 0
      ? 'Nothing to rename.\n'
      : `Renamed ${edits} legacy surfaceOp key(s) across ${files} file(s).\n`,
  )
}
