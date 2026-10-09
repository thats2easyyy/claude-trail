// Reads a session's transcript file back into its trail, pictures included:
//   node tools/backfill.ts <session id | path to .jsonl> <out dir>
// writes <out dir>/trail.json and <out dir>/shots/*.png, and prints one line of JSON saying what it did.
// The mod runs this for a session that went on without it; it is also the way to look at any past session.
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { eventsFromRows } from '../hooks/rows.ts'
import { add, emptyTrail, isEarlier, tag } from '../hooks/trail.ts'

const THUMB_PX = '720'
/** The newest pictures are worth their file; a session with more keeps the rest as lines. */
const MOST_PICTURES = 120

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

const safeName = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)

/** A PNG's size, from its header. */
const sizeOf = (path: string): { w: number; h: number } => {
  const head = readFileSync(path).subarray(0, 24)
  return head.length < 24 ? { w: 0, h: 0 } : { w: head.readUInt32BE(16), h: head.readUInt32BE(20) }
}

const sid = which.endsWith('.jsonl') ? which.slice(which.lastIndexOf('/') + 1, -'.jsonl'.length) : which
const file = find(which)
let trail = emptyTrail()
let kept = 0
let skipped = 0

const SUFFIX: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }

/** Makes the pane's small PNG of a picture; false when the picture will not convert. */
const thumbOf = (source: string, thumb: string): boolean => {
  try {
    execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-Z', THUMB_PX, source, '--out', thumb], { stdio: 'ignore', timeout: 15_000 })
    return existsSync(thumb)
  } catch {
    return false
  }
}

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
  const { events, pictures, sent, made, opened, asked } = eventsFromRows(linesOf(file), homedir())
  const began = events.find(event => event.at > 0)?.at ?? 0

  /** The system's preview of a video or a document, as the pane's small PNG; undefined when it makes none. */
  const previewOf = (source: string, id: string): string | undefined => {
    const into = join(out, 'shots', `ql-${safeName(id)}`)
    const thumb = join(into, `${basename(source)}.png`)
    if (existsSync(thumb)) return thumb
    try {
      mkdirSync(into, { recursive: true })
      execFileSync('/usr/bin/qlmanage', ['-t', '-s', THUMB_PX, '-o', into, source], { stdio: 'ignore', timeout: 20_000 })
    } catch {
      // No preview: the output keeps its line and can still be opened.
    }
    return existsSync(thumb) ? thumb : undefined
  }
  const shots = join(out, 'shots')
  mkdirSync(shots, { recursive: true })
  const wanted = new Set([...pictures.keys()].slice(-MOST_PICTURES))

  for (const event of events) {
    if (event.t === 'question') {
      // The picture a question was asked about: the one the mod kept when it was asked, else the file if it is still there.
      const name = safeName(`q-${event.id}`)
      const thumb = join(shots, `${name}.png`)
      const source = asked.get(event.id)
      const has = existsSync(thumb) || (source !== undefined && source.startsWith('/') && existsSync(source) && thumbOf(source, thumb))
      const full = readdirSync(shots).find(other => other.startsWith(`${name}.full.`))
      trail = add(trail, has ? { ...event, shot: { file: thumb, ...sizeOf(thumb), full: full ? join(shots, full) : (source ?? thumb) } } : event)
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
      const thumb = previewOf(source, id)
      kept++
      trail = add(trail, { ...event, id, full: source, ...(thumb ? { file: thumb, ...sizeOf(thumb) } : {}) })
      continue
    }
    const held = pictures.get(event.id)
    const name = safeName(event.id)
    const thumb = join(shots, `${name}.png`)
    // A picture Claude sent is a file somewhere on disk: the copy the mod made when it was sent, else the file itself.
    const path = sent.get(event.id)
    if (!existsSync(thumb) && path !== undefined && path.startsWith('/') && existsSync(path)) thumbOf(path, thumb)
    // The file the picture was, when it is still on disk as it was when Claude opened or sent it: written no
    // later than that. It is then opened where it lies, and no copy of it is kept.
    const lies = path ?? opened.get(event.id)
    const written = lies !== undefined && lies.startsWith('/') && existsSync(lies) && statSync(lies).isFile() ? statSync(lies).mtimeMs : 0
    const isAsItWas = written > 0 && event.at > 0 && written <= event.at + 2000
    // Otherwise the picture as the transcript holds it is kept whole beside its small copy, to open.
    const whole = join(shots, `${name}.full${SUFFIX[held?.mediaType ?? ''] ?? '.png'}`)
    if (!existsSync(thumb) && held && wanted.has(event.id)) {
      try {
        writeFileSync(whole, Buffer.from(held.base64, 'base64'))
        if (!thumbOf(whole, thumb) || isAsItWas) rmSync(whole, { force: true })
      } catch {
        // A picture that will not convert is left out; the line it would have had is no loss beside the rest.
        rmSync(whole, { force: true })
      }
    }
    if (!existsSync(thumb)) {
      skipped++
      // One too old to be worth its file keeps its line; one that would not convert is left out.
      if (held && !wanted.has(event.id)) trail = add(trail, event)
      continue
    }
    kept++
    const full = readdirSync(shots).find(other => other.startsWith(`${name}.full.`))
    // A picture Claude opened that was on disk before the session began was looked at, not made.
    const source = opened.get(event.id)
    const from = source !== undefined && existsSync(source) && isEarlier(statSync(source).mtimeMs, began) ? { from: 'earlier' as const } : {}
    trail = add(trail, { ...event, ...from, file: thumb, ...sizeOf(thumb), ...(full ? { full: join(shots, full) } : isAsItWas && lies ? { full: lies, stamp: Math.round(written) } : {}) })
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'trail.json'), JSON.stringify({ v: 5, sid, trail }))
}

console.log(JSON.stringify({ sid, transcript: file ?? null, lines: trail.items.length, pictures: kept, picturesLeftOut: skipped }))
