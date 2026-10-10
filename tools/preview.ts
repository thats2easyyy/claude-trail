// Prints a kept trail as the pane would lay it out, to read one without a terminal:
//   node tools/preview.ts <dir holding trail.json | trail.json> [columns] [feed|outputs|steps|questions] [page]
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { mended } from '../hooks/trail.ts'
import { layout } from '../hooks/view.ts'

const [where, columns = '58', listing = 'feed', back = '0'] = process.argv.slice(2)
const MODES = ['feed', 'outputs', 'steps', 'questions'] as const
if (!where) {
  console.error('usage: node tools/preview.ts <dir holding trail.json | trail.json> [columns] [feed|outputs|steps|questions] [page]')
  process.exit(2)
}
const path = statSync(where).isDirectory() ? join(where, 'trail.json') : where
const trail = mended((JSON.parse(readFileSync(path, 'utf8')) as { trail?: unknown }).trail)
if (!trail) {
  console.error(`${path} holds no trail`)
  process.exit(1)
}

const width = Number(columns)
const mode = MODES.find(known => known === listing) ?? 'feed'
const page = layout(trail, { width, picked: { id: '' }, page: Number(back), mode, zone: -new Date().getTimezoneOffset() })
console.log(MODES.map(known => (known === mode ? `[${known}]` : known)).join('  '))
console.log(page.foot)
if (page.later > 0) console.log(`[${page.later} later]  [latest]`)
console.log('')
for (const row of page.rows) {
  if (row.kind === 'day') console.log(`${row.text} ${'─'.repeat(Math.max(0, width - row.text.length - 1))}`)
  else if (row.kind === 'question') {
    console.log(`Claude is asking you · ${row.time}\n`)
    for (const text of row.lines) console.log(text)
    if (row.question.options.length > 0) console.log(`\n${row.question.options.map(option => `[ ${option} ]`).join('  ')}`)
    console.log('\n> Type your answer')
  } else {
    const pad = ' '.repeat(row.pad)
    console.log(`${row.time}${row.open ? (row.tone === 'quiet' ? '  [open] (opened)' : '  [open]') : ''}${row.hasMore ? (row.isOpen ? '  [less]' : '  [more]') : ''}${row.settles ? '  [done]' : ''}`)
    row.lines.forEach((text, index) => console.log(index === 0 && row.pad > 0 ? `${row.glyph} ${text}` : pad + text))
    for (const ref of row.refs ?? []) console.log(`${pad}${/^https?:/.test(ref) ? '[open]' : '[copy]'} ${ref}`)
    if (row.work) console.log(`${pad}└ ${row.work}`)
  }
  console.log('')
}
if (page.earlier > 0) console.log(`[${page.earlier} earlier]`)
