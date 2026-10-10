// Reads a session's transcript file back into its trail:
//   node tools/backfill.ts <session id | path to .jsonl> <out dir>
// writes <out dir>/trail.json, and prints one line of JSON saying what it did. Nothing is copied or converted.
// The mod runs this for a session that went on without it; it is also the way to look at any past session.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { eventsFromRows } from '../hooks/rows.ts'
import { add, emptyTrail, isEarlier, tag } from '../hooks/trail.ts'

const [which, out] = process.argv.slice(2)
if (!which || !out) {
  console.error('usage: node tools/backfill.ts <session id | path to .jsonl> <out dir>')
  process.exit(2)
}

const find = (id: string): string | undefined => {
  if (id.endsWith('.jsonl')) return existsSync(id) ? id : undefined
  const projects = join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'projects')
  if (!existsSync(projects)) return undefined
  for (const project of readdirSync(projects)) {
    const path = join(projects, project, `${id}.jsonl`)
    if (existsSync(path)) return path
  }
  return undefined
}

const sid = which.endsWith('.jsonl') ? which.slice(which.lastIndexOf('/') + 1, -'.jsonl'.length) : which
const file = find(which)
let trail = emptyTrail()
let kept = 0
let skipped = 0

/** A file's lines, read a piece at a time: a long session's transcript is larger than a string may be. */
function* linesOf(path: string): Generator<string> {
  const from = openSync(path, 'r')
  const piece = Buffer.alloc(1 << 20)
  const decoder = new StringDecoder('utf8')
  let rest = ''
  try {
    for (let read = readSync(from, piece, 0, piece.length, null); read > 0; read = readSync(from, piece, 0, piece.length, null)) {
      const lines = (rest + decoder.write(piece.subarray(0, read))).split('\n')
      rest = lines.pop() ?? ''
      yield* lines
    }
    yield rest + decoder.end()
  } finally {
    closeSync(from)
  }
}

if (file) {
  const { events, sent, made, opened, asked } = eventsFromRows(linesOf(file), homedir())
  const began = events.find(event => event.at > 0)?.at ?? 0
  /** A file as it lies, when it is still what it was at `at`: written no later than that. Nothing is copied: it is opened where it is. */
  const lying = (path: string | undefined, at: number): { full: string; stamp: number } | undefined => {
    if (path === undefined || !path.startsWith('/') || !existsSync(path)) return undefined
    const stat = statSync(path)
    return stat.isFile() && at > 0 && stat.mtimeMs <= at + 2000 ? { full: path, stamp: Math.round(stat.mtimeMs) } : undefined
  }

  for (const event of events) {
    if (event.t === 'question') {
      // The picture a question was asked about is opened from the question, where it still lies.
      const source = asked.get(event.id)
      const there = source !== undefined && source.startsWith('/') && existsSync(source)
      trail = add(trail, there ? { ...event, shot: { file: '', w: 0, h: 0, full: source } } : event)
      continue
    }
    if (event.t !== 'shot' || event.type === 'link') {
      trail = add(trail, event)
      continue
    }
    if (event.type === 'video' || event.type === 'file') {
      const named = made.get(event.id)
      const source = sent.get(event.id) ?? named?.path
      if (!source || !source.startsWith('/') || !existsSync(source)) continue
      const stat = statSync(source)
      // A command that names a video made it only if the file was written while that command ran.
      if (named && (!stat.isFile() || stat.size === 0 || stat.mtimeMs < named.from - 5000 || stat.mtimeMs > named.to + 5000)) continue
      const id = named ? `out:${tag(source)}:${Math.round(stat.mtimeMs)}` : event.id
      kept++
      trail = add(trail, { ...event, id, file: '', w: 0, h: 0, full: source })
      continue
    }
    // A picture is told of in words. One that was a file is opened where it lies, while it is still that picture;
    // one that never was (pasted, a browser's screenshot) has nothing to open.
    const source = sent.get(event.id) ?? opened.get(event.id)
    const there = lying(source, event.at)
    // A picture Claude opened that was on disk before the session began was looked at, not made.
    const from = source !== undefined && existsSync(source) && isEarlier(statSync(source).mtimeMs, began) ? { from: 'earlier' as const } : {}
    if (there) kept++
    else skipped++
    trail = add(trail, { ...event, ...from, file: '', w: 0, h: 0, ...(there ?? {}) })
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'trail.json'), JSON.stringify({ v: 5, sid, trail }))
}

console.log(JSON.stringify({ sid, transcript: file ?? null, lines: trail.items.length, toOpen: kept, nothingToOpen: skipped }))
