#!/usr/bin/env node
/**
 * Build supabase/functions/jarvis-chat/index.ts.
 *
 * WHY THIS EXISTS. `supabase functions deploy` ships only the entrypoint for
 * this project — a local import of a sibling file fails to bundle, whether it
 * sits in a shared folder or in the function's own directory. Every other
 * function here is a single file, which is the same constraint showing.
 *
 * So the deployed function is one self-contained file, generated from the
 * modules in quoteleads/ — which stay the single editable source, and are what
 * the MCP server imports for the local bridge. Edit those, run this, deploy.
 *
 *     node tools/jarvis/build-edge.mjs
 *
 * The build fails loudly if two modules declare the same top-level name, since
 * concatenation would silently let one shadow the other.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fn = join(root, 'supabase', 'functions', 'jarvis-chat')
const src = join(fn, 'quoteleads')

// Dependency order: each module may only use what is already above it.
const MODULES = ['config.mjs', 'dates.mjs', 'db.mjs', 'auth.mjs', 'explore.mjs', 'tools.mjs']

const declared = new Map()

const inline = (name) => {
  const text = readFileSync(join(src, name), 'utf8')

  for (const m of text.matchAll(/^export (?:async function|function|const|let|class) ([A-Za-z0-9_$]+)/gm)) {
    if (declared.has(m[1])) {
      throw new Error(
        `Name collision: "${m[1]}" is declared in both ${declared.get(m[1])} and ${name}. ` +
          'Concatenation would shadow one of them — rename it.',
      )
    }
    declared.set(m[1], name)
  }

  return text
    // Imports between these modules become unnecessary once they share a scope.
    .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/[a-z]+\.mjs'\n/gm, '')
    // Everything lands in one module scope, so nothing needs exporting.
    .replace(/^export (async function|function|const|let|class) /gm, '$1 ')
}

const bodies = MODULES.map((m) => `// ─── ${m} ${'─'.repeat(Math.max(0, 60 - m.length))}\n\n${inline(m)}`)
const shell = readFileSync(join(fn, 'index.template.ts'), 'utf8')

const out = shell.replace(
  '/* __QUOTELEADS_TOOLS__ */',
  [
    '// ══════════════════════════════════════════════════════════════════',
    '//  GENERATED — do not edit below this line.',
    '//  Source: supabase/functions/jarvis-chat/quoteleads/*.mjs',
    '//  Rebuild: node tools/jarvis/build-edge.mjs',
    '// ══════════════════════════════════════════════════════════════════',
    '',
    ...bodies,
  ].join('\n'),
)

writeFileSync(join(fn, 'index.ts'), out)
console.log(`index.ts built · ${MODULES.length} modules · ${declared.size} top-level names · ${out.split('\n').length} lines`)
