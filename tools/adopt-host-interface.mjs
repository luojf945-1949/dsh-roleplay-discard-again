#!/usr/bin/env node
/**
 * Route plugin source through the Harness adapter.
 *
 * Plugins must not import `@deepseek-ai/dsh-*` directly; that is what makes a
 * Harness upgrade a repository-wide hunt. This codemod rewrites the import
 * specifiers only — symbol names, import shape (default vs named), and
 * surrounding comments are preserved verbatim.
 *
 * Test files are deliberately left alone: they exercise the Harness packages as
 * a harness, and keeping their imports direct means a Harness change surfaces
 * as a test failure rather than being masked by the adapter.
 *
 * Usage:
 *   node tools/adopt-host-interface.mjs          # rewrite
 *   node tools/adopt-host-interface.mjs --check  # report only, exit 1 on drift
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')

const ADAPTER = 'dsh-roleplay-rp-host-interface'

/**
 * Harness module specifiers that must be reached through the adapter, mapped to
 * the adapter entry point that serves them.
 *
 * `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` are intentionally absent:
 * they are stable library dependencies (the plugin framework and the config
 * schema language), not Harness release-coupled APIs.
 */
const REDIRECTS = new Map([
  ['@deepseek-ai/dsh-llm', ADAPTER],
  ['@deepseek-ai/dsh-llm/message', `${ADAPTER}/message`],
  ['@deepseek-ai/dsh-compaction', ADAPTER],
  ['@deepseek-ai/dsh-compaction-basic', ADAPTER],
  ['@deepseek-ai/dsh-tools', ADAPTER],
  ['@deepseek-ai/dsh-typert-protocol', ADAPTER],
])

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'test', '.npm-package'])

/**
 * The adapter itself is the one place allowed to name a Harness module, so it
 * must never be redirected onto its own specifier.
 *
 * `rp-remote` is a documented second exception. Its `@Remote` decorator and
 * `TypertRemoteService` base class are inputs to the `dsh-typert-generator`
 * build tool, which resolves them by static package reference and cannot follow
 * a re-export through another package. Serving code generation from an adapter
 * would trade a build-time contract for a runtime one, so the package that
 * feeds the generator imports its source package directly.
 */
const SKIP_RELATIVE_PREFIXES = ['packages/rp-host-interface/', 'packages/rp-remote/']

/**
 * Rewrite adapter-bound specifiers in one source string.
 *
 * @param {string} source File contents.
 * @returns {{ next: string, changes: number }} Rewritten contents and change count.
 */
function redirect(source) {
  let next = source
  let changes = 0
  for (const [from, to] of REDIRECTS) {
    // Only rewrite a module specifier, never a bare mention inside prose.
    const pattern = new RegExp(`(from\\s+|import\\(\\s*)(['"])${from.replaceAll('/', '\\/')}\\2`, 'g')
    next = next.replace(pattern, (_match, prefix, quote) => {
      changes += 1
      return `${prefix}${quote}${to}${quote}`
    })
  }
  return { next, changes }
}

const checkOnly = process.argv.slice(2).includes('--check')
const drifted = []
let rewrittenFiles = 0
let rewrittenImports = 0

const visit = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      visit(join(directory, entry.name))
      continue
    }
    if (!entry.isFile()) continue
    if (!['.js', '.mjs', '.ts'].includes(extname(entry.name))) continue
    const path = join(directory, entry.name)
    const label = relative(projectRoot, path).replaceAll('\\', '/')
    if (SKIP_RELATIVE_PREFIXES.some(prefix => label.startsWith(prefix))) continue
    const source = readFileSync(path, 'utf8')
    const { next, changes } = redirect(source)
    if (changes === 0) continue
    if (checkOnly) {
      drifted.push({ label, changes })
      continue
    }
    writeFileSync(path, next)
    rewrittenFiles += 1
    rewrittenImports += changes
    process.stdout.write(`  ${String(changes).padStart(3)}  ${label}\n`)
  }
}

for (const group of ['plugins', 'packages']) {
  visit(join(projectRoot, group))
}

if (checkOnly) {
  if (drifted.length === 0) {
    process.stdout.write('All plugin source reaches the Harness through the adapter.\n')
  } else {
    for (const entry of drifted) process.stderr.write(`${entry.label}: ${entry.changes} direct Harness import(s)\n`)
    process.exitCode = 1
  }
} else {
  process.stdout.write(
    rewrittenImports === 0
      ? 'Nothing to redirect.\n'
      : `Redirected ${rewrittenImports} import(s) across ${rewrittenFiles} file(s) to ${ADAPTER}.\n`,
  )
}
