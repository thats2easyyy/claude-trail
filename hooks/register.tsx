import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Beat, Mode, OutputType, Picked, Question, Saved, Shot, Source, Trail } from '../types'
import { adopt, feedIn, nextJob, parseBeats, parseCleared, SYSTEM } from './digest.ts'
import { captionJob, parseCaptions } from './caption.ts'
import { candidates, reach } from './jump.ts'
import { isSession, keepDays, prunable, sized, staleCopies } from './prune.ts'
import type { Kept } from './prune.ts'
import { add, basename, clean, emptyTrail, isEarlier, mended, outputType, paneAnswer, publishedAt, SENT, tag, toolNote, videosNamed, waitingCount } from './trail.ts'
import type { TrailEvent } from './trail.ts'
import { clock, layout, zoneOf } from './view.ts'
import type { Target } from './view.ts'

/**
 * Trail: what this conversation did, as a feed in a side pane.
 *
 * Hooks on the conversation's rows and tool calls feed `add`, which folds
 * them into steps: what was asked, what the model said it was doing with a
 * count of the work under it, the pictures it looked at, how each turn came
 * out. A model then reads the steps a stretch at a time and writes an update
 * for each, a few sentences on what was done and what came of it, the way a
 * match is told as it goes. Those updates, newest first, with the pictures
 * between them, are what the pane lists; every step is one key away. A line
 * is a Button: pressing it shows the way to its row in the transcript.
 * Claude can also put a question to the person in the pane, under a picture
 * if it is about one, and their answer goes back as their next message.
 *
 * The trail is kept in a file beside its pictures, by session, so it is there
 * when the session is opened again; a session that ran before the mod did is
 * read back from its transcript file by `tools/backfill.ts`.
 */

const PANE = 'trail'
const TITLE = 'Trail'
const COLUMNS = 62
/** Cells of empty margin each side of the pane's body. */
const MARGIN = 1
/** The pane is drawn again for a change no more often than this. */
const PUSH_MS = 800
const SAVE_MS = 5000
/** The longer side of a kept picture, in pixels: sharp at the pane's width, small to hand to the terminal. */
const THUMB_PX = '720'
const SIPS = '/usr/bin/sips'
const BASE64 = '/usr/bin/base64'
const RM = '/bin/rm'
const DU = '/usr/bin/du'
/** How often, across every session on the machine, what is past keeping is looked for; and how long after a session starts. */
const PRUNE_EVERY_MS = 86_400_000
const PRUNE_AFTER_MS = 8000
const COPIES_AT_ONCE = 40
const CP = '/bin/cp'
const OPEN = '/usr/bin/open'
const QLMANAGE = '/usr/bin/qlmanage'
const DATE = '/bin/date'
const REBUILD_MS = 120_000
const USAGE = 'Usage: /trail [close|off|on|rebuild|where]'
/** What the line under the tabs says while the person has the model calls turned off. */
const OFF = 'updates are off: /trail on'
const OPENED = 'Trail opened. Point at an entry and click the arrow beside its time to jump to it in the conversation.'
/**
 * The way to an entry's place in the conversation: an arrow beside its time,
 * there only while the pointer is over the entry. Actions are a word or two
 * at most, so the pane is the work and not its controls.
 */
const GO = '→'
/** The same, where no pointer rests: on a question, which is not passed over but answered. */
const GO_WORD = '[jump]'
const NOTED = 60
const JOURNAL_MOST = 5000
/** Highlights are written a moment after there is something to write them from, one stretch at a time. */
const DIGEST_MS = 1500
const DIGEST_NEXT_MS = 300
const DIGEST_RETRY_MS = 60_000
const DIGEST_TIMEOUT_MS = 90_000
const DIGEST_TOKENS = 1400
/** Captions are asked for a little after a turn ends, while the conversation is fresh in the provider's cache. */
const CAPTION_MS = 4000
/**
 * The session's own model writes the updates: a stretch is a page of log and a few lines of reply, and a
 * small model was seen to report what was asked for as done. The small one stands in where the session's cannot be asked.
 */
const DIGEST_FALLBACK = 'haiku'
/** The tool as the model calls it. Matched by pattern: the engine's list of tool names is written before this one exists. */
const ASK_TOOL = /^mcp__trail__ask$/
const ASK_DESCRIPTION = [
  'Puts a question to the person in their Trail side pane, where it stays until they answer, optionally under a picture it is about.',
  'Use it whenever you need them to confirm or choose something, and always when the question is about an image: pass the image so they see it right above the question ("Is this the garage where you put the letter H?").',
  'It is the right way to ask when they may be away from the conversation. It does not wait: their answer arrives later as their next message, so end your turn if you cannot go on without it, or carry on with what does not depend on it.',
].join(' ')
const ASK_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The question, in one or two plain sentences.' },
    options: { type: 'array', items: { type: 'string' }, description: 'Up to four short answers to offer as buttons, such as "Yes" and "No". They can always type their own.' },
    image: { type: 'string', description: 'Absolute path of a picture (PNG, JPEG, GIF or WebP) to show above the question.' },
  },
  required: ['question'],
}

const TYPED_MEANWHILE = /The user sent a new message while you were working:\s*([\s\S]*?)\s*(?:\n\s*This is how Claude Code surfaces|<\/system-reminder>|$)/

const EMPTY: Saved = { v: 5, sid: '', trail: emptyTrail() }
const NONE: Picked = { id: '' }
const saved = atom({ plugin: 'trail', key: 'saved' } as const, EMPTY)
const picked = atom({ plugin: 'trail', key: 'picked' } as const, NONE)
const page = atom({ plugin: 'trail', key: 'page' } as const, 0)
const mode = atom({ plugin: 'trail', key: 'mode' } as const, 'feed')
const status = atom({ plugin: 'trail', key: 'status' } as const, '')

type Dollar = EngineInterface
type Block = { type: string; [field: string]: unknown }
type Message = { type: string; name?: string; isMeta?: true; content: readonly Block[] }
type Held = { data: string; type: string }

// The engine reads this file to see what the mod calls: `$` may only be handed to functions declared here at
// the top of it, so everything that needs `$` is one, and what they share is the module's own.

/** The trail as it stands; the session's state has it as of the last push, the file as of the last save. */
let live: Trail = emptyTrail()
/** The session the trail is of, and where its file and pictures are; empty until `begin` has run. */
let sid = ''
let dir = ''
let zone = 0
let starting: Promise<void> | null = null
let isRebuilding = false
/**
 * What happened since the transcript file was last trusted to hold everything: kept from the moment a trail
 * begins until its transcript has been read back, to lay over what the file held.
 */
let journal: TrailEvent[] | null = null
let pushTimer: Timer | null = null
let lastSavedAt = 0
let hasShotsDir = false

let digestTimer: Timer | null = null
let isDigesting = false
/** The model the updates are written with, once one has answered. */
let digestModel = ''
/** Steps a model was asked about and gave nothing readable for: they stay as steps rather than be asked about again. */
const skipped = new Set<string>()

let captionTimer: Timer | null = null
let isCaptioning = false

/** Questions the person has answered in the pane: a second press before the pane is drawn again sends nothing more. */
const answered = new Set<string>()

/** A folded run's id in the transcript, by each tool call in it: what a jump to a folded call scrolls to. */
const groupsByCall = new Map<string, string>()

/** What the mod saw, for whoever is working on it: written beside the trail as diag.json. */
const diag = {
  appends: [] as string[],
  jumps: [] as string[],
  shots: [] as string[],
  rebuilds: [] as string[],
  digests: [] as string[],
  captions: [] as string[],
  questions: [] as string[],
  prunes: [] as string[],
  faults: [] as string[],
}

const jot = (list: string[], line: string) => {
  list.push(line)
  if (list.length > NOTED) list.shift()
}

const fault = ($: Dollar, where: string, error: unknown) => {
  jot(diag.faults, `${where}: ${String(error)}`)
  $.ui.log(`trail: ${where}: ${String(error)}`, { to: 'debug' })
}

/** Why a call on the engine did not do what was asked: what it answered, or what it threw. */
const whyNot = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 120)

const safeName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)

const save = async ($: Dollar, now: number) => {
  if (!sid || !dir) return
  lastSavedAt = now
  const kept: Saved = { v: 5, sid, trail: live }
  await $.fs.write(`${dir}/trail.json`, JSON.stringify(kept))
  await $.fs.write(`${dir}/diag.json`, JSON.stringify({ at: now, sid, zone, items: live.items.length, updates: live.feed.length, model: digestModel, ...diag }, null, 1))
}

/** Hands the trail to the session's state, which draws the pane again, and to its file when that is due. */
const push = async ($: Dollar, isSaving: boolean) => {
  pushTimer?.cancel()
  pushTimer = null
  try {
    const kept: Saved = { v: 5, sid, trail: live }
    await update($, saved, () => kept)
    const now = await $.clock.now()
    if (isSaving || now - lastSavedAt >= SAVE_MS) await save($, now)
  } catch (error) {
    fault($, 'push', error)
  }
}

const soon = ($: Dollar) => {
  if (!pushTimer) pushTimer = $.clock.after(PUSH_MS, () => void push($, false))
}

const tell = async ($: Dollar, text: string) => {
  try {
    await update($, status, () => text)
  } catch {
    // The line is a courtesy; the feed goes on without it.
  }
}

/**
 * Whether the person has turned the mod's model calls off (`/trail off`), on
 * this machine and in every session: the steps are still noted, which costs
 * nothing, but no update is written and no picture captioned until `/trail on`.
 */
const isOff = ($: Dollar): Promise<boolean> =>
  $.store.get('off').then(
    value => value === true,
    () => false,
  )

/**
 * Puts a stretch of steps to a model and resolves its reply, or null when no
 * model gave one. The first model to answer is the one asked from then on.
 */
const complete = async ($: Dollar, prompt: string): Promise<string | null> => {
  const names = digestModel ? [digestModel] : [await $.session.model().catch(() => ''), DIGEST_FALLBACK]
  for (const model of names.filter((name, index) => name !== '' && names.indexOf(name) === index)) {
    try {
      const reply = await $.model.complete({ model, system: SYSTEM, prompt, maxTokens: DIGEST_TOKENS, effort: 'low', timeoutMs: DIGEST_TIMEOUT_MS })
      if (reply.isAnswered) {
        digestModel = model
        jot(diag.digests, `${model} in=${reply.usage.input_tokens} out=${reply.usage.output_tokens}`)
        return reply.text
      }
      jot(diag.digests, `${model}: ${reply.reason}${reply.reason === 'api-error' ? ` ${reply.error} ${reply.status}` : ''}`)
      // A call cut short says nothing about the model; one the provider refused may fare better on another.
      if (reply.reason === 'aborted') return null
    } catch (error) {
      jot(diag.digests, `${model} refused: ${whyNot(error)}`)
    }
  }
  return null
}

/**
 * Writes the updates for the steps that are ready for them: the newest first, then the
 * history behind it, one model call at a time and never from inside a hook
 * the conversation is waiting on. Resolves how long to wait before the next.
 */
const digest = async ($: Dollar): Promise<number | null> => {
  if (isDigesting || isRebuilding || !sid) return null
  if (await isOff($)) {
    await tell($, OFF)
    return null
  }
  const job = nextJob(live, skipped)
  if (!job) {
    await tell($, '')
    return null
  }
  const of = sid
  isDigesting = true
  try {
    let beats: Beat[] = []
    let cleared: string[] = []
    if (job.prompt) {
      await tell($, 'writing the latest update…')
      const reply = await complete($, job.prompt)
      if (of !== sid) return null
      if (reply === null) {
        // No model answered: the steps are shown as they are, and a while later it is tried again.
        await tell($, 'updates are waiting on a model')
        return DIGEST_RETRY_MS
      }
      beats = parseBeats(reply, job)
      cleared = parseCleared(reply, job)
      if (beats.length === 0) {
        for (const id of job.ids) skipped.add(id)
        jot(diag.digests, `unreadable reply: ${reply.slice(0, 160)}`)
        return DIGEST_NEXT_MS
      }
    }
    live = feedIn(live, job, beats, cleared)
    await push($, true)
    return DIGEST_NEXT_MS
  } catch (error) {
    fault($, 'digest', error)
    return DIGEST_RETRY_MS
  } finally {
    isDigesting = false
  }
}

/** After `ms`, writes the updates the steps are ready for, and goes on until none is. */
const digestSoon = ($: Dollar, ms: number) => {
  if (digestTimer) return
  digestTimer = $.clock.after(ms, () => {
    digestTimer = null
    void digest($).then(again => {
      if (again !== null) digestSoon($, again)
    })
  })
}

/**
 * Asks the conversation itself what its pictures show and what they were
 * about, and sets the answers under them. The question is put over the whole
 * transcript, so it is asked only just after a turn has ended, when the
 * provider still has that transcript at hand, and for all the pictures at once.
 */
const caption = async ($: Dollar) => {
  if (isCaptioning || isRebuilding || !sid || (await isOff($))) return
  const job = captionJob(live, at => clock(at, zone))
  if (!job) return
  const of = sid
  isCaptioning = true
  try {
    const reply = await $.model.fork({ prompt: job.prompt })
    if (of !== sid) return
    if (!reply.isAnswered) {
      jot(diag.captions, `no answer: ${reply.reason}`)
      return
    }
    const told = parseCaptions(reply.text, job)
    jot(diag.captions, `${told.filter(one => one.text).length} of ${job.shots.length} captioned, cache read ${reply.usage.cache_read_input_tokens}, in ${reply.usage.input_tokens}, out ${reply.usage.output_tokens}`)
    for (const one of told) await record($, now => ({ t: 'caption', id: one.id, at: now, text: one.text }))
    await push($, true)
  } catch (error) {
    fault($, 'caption', error)
  } finally {
    isCaptioning = false
  }
}

const captionSoon = ($: Dollar) => {
  captionTimer?.cancel()
  captionTimer = $.clock.after(CAPTION_MS, () => {
    captionTimer = null
    void caption($)
  })
}

const load = async ($: Dollar): Promise<Trail | null> => {
  try {
    const path = `${dir}/trail.json`
    if (!(await $.fs.exists(path))) return null
    const kept = JSON.parse(await $.fs.read(path)) as Partial<Saved>
    return kept.v === 5 && kept.sid === sid ? mended(kept.trail) : null
  } catch (error) {
    fault($, 'load', error)
    return null
  }
}

/**
 * Reads the session's transcript file back into a trail, pictures included: a
 * host command, since the file is far larger than a mod may read. What only
 * the mod knew (the updates written so far, the answers given in the pane)
 * is carried over. Asked for by the person, the latest of it is put to the
 * model again, which is how a session told before the mod knew to look finds
 * what is waiting on them. Resolves why not when it could not ('' when it did).
 */
const rebuild = async ($: Dollar, isAsked = false): Promise<string> => {
  if (isRebuilding) return 'already rebuilding'
  const [of, into] = [sid, dir]
  if (!of || !into) return 'no session yet'
  isRebuilding = true
  journal ??= []
  let why = ''
  try {
    const had = live
    // Run from the mod's own folder: in the session's, a project's pin may pick a Node that cannot run the tool.
    const ran = await $.process.run(['node', `${$.plugin.root}/tools/backfill.ts`, of, into], { cwd: $.plugin.root, timeoutMs: REBUILD_MS })
    const built = ran.exitCode === 0 && of === sid ? await load($) : null
    if (ran.exitCode !== 0) why = (ran.stderr || ran.stdout || `exit ${ran.exitCode}`).trim().slice(-200)
    else if (of !== sid) why = 'the session changed meanwhile'
    else if (!built) why = 'nothing readable was written'
    else {
      live = journal.reduce(add, adopt(built, had, isAsked))
      await push($, true)
    }
    jot(diag.rebuilds, why || ran.stdout.trim().slice(0, 300))
  } catch (error) {
    why = whyNot(error)
    fault($, 'rebuild', error)
  } finally {
    isRebuilding = false
    journal = null
  }
  digestSoon($, DIGEST_MS)
  return why
}

/**
 * Removes what the mod kept for other sessions that is past keeping: the
 * pictures of one idle a week, the whole folder of one idle as long as Claude
 * Code keeps a transcript, and in those that stay the whole-size copies made
 * a week ago or more. Once a day at most, whichever session comes to it
 * first, and never this session's own. Only folders the mod made, named by a
 * session's id inside the mod's own folder, are ever removed.
 */
const prune = async ($: Dollar) => {
  try {
    const root = dir.slice(0, dir.lastIndexOf('/'))
    if (!sid || !root.startsWith('/') || !root.endsWith('/.claude/trail')) return
    const now = await $.clock.now()
    const last = await $.store.get('prunedAt')
    if (typeof last === 'number' && now - last < PRUNE_EVERY_MS) return
    await $.store.set('prunedAt', now)
    const kept: Kept[] = []
    for (const entry of await $.fs.list(root)) {
      if (entry.kind !== 'dir') continue
      const at = `${root}/${entry.name}`
      const written = (path: string) =>
        $.fs.stat(path).then(
          stat => stat.mtimeMs,
          () => 0,
        )
      kept.push({ name: entry.name, touchedAt: (await written(`${at}/trail.json`)) || (await written(at)), hasShots: await $.fs.exists(`${at}/shots`).catch(() => false) })
    }
    const settings = (await $.settings.read().catch(() => ({}))) as Record<string, unknown>
    const { folders, pictures } = prunable(kept, now, sid, keepDays(settings['cleanupPeriodDays']))
    for (const name of folders) await $.process.run([RM, '-rf', `${root}/${name}`], { timeoutMs: 60_000 })
    for (const name of pictures) await $.process.run([RM, '-rf', `${root}/${name}/shots`], { timeoutMs: 60_000 })
    // In the sessions that stay, this one included, a whole-size copy goes a week after it was made.
    let copies = 0
    for (const one of kept) {
      if (!isSession(one.name) || !one.hasShots || folders.includes(one.name) || pictures.includes(one.name)) continue
      const shots = `${root}/${one.name}/shots`
      const stale = staleCopies(await $.fs.list(shots).catch(() => []), now)
      for (let from = 0; from < stale.length; from += COPIES_AT_ONCE) await $.process.run([RM, '-f', ...stale.slice(from, from + COPIES_AT_ONCE).map(name => `${shots}/${name}`)], { timeoutMs: 60_000 })
      copies += stale.length
    }
    jot(diag.prunes, `${kept.length} sessions kept: removed ${folders.length} whole, the pictures of ${pictures.length}, ${copies} whole-size copies`)
  } catch (error) {
    fault($, 'prune', error)
  }
}

/** How much the mod keeps on disk, for `/trail where`: this session's folder and all of them together. */
const keptSize = async ($: Dollar): Promise<string> => {
  try {
    const root = dir.slice(0, dir.lastIndexOf('/'))
    const ran = await $.process.run([DU, '-sk', dir, root], { timeoutMs: 20_000 })
    const [own, all] = ran.stdout.split('\n').map(line => Number(line.trim().split(/\s+/)[0]))
    return own !== undefined && all !== undefined && Number.isFinite(own) && Number.isFinite(all) ? ` (${sized(own)}; every conversation together ${sized(all)})` : ''
  } catch {
    return ''
  }
}

const zoneNow = async ($: Dollar): Promise<number> => {
  try {
    const ran = await $.process.run([DATE, '+%z'], { timeoutMs: 5000 })
    const minutes = zoneOf(ran.stdout)
    if (minutes !== undefined) return minutes
  } catch {
    // Without the host's answer the module's own idea of the zone has to do.
  }
  return -new Date().getTimezoneOffset()
}

/** Finds this session's trail: in the state after a reload, else in its file, else in its transcript. */
const begin = async ($: Dollar) => {
  const home = (await $.env.get('HOME')) ?? ''
  const id = await $.session.id()
  dir = `${home}/.claude/trail/${id}`
  zone = await zoneNow($)
  hasShotsDir = false
  skipped.clear()
  const held = await read($, saved)
  const again = held.v === 5 && held.sid === id ? mended(held.trail) : null
  sid = id
  if (again) {
    live = again
    digestSoon($, DIGEST_MS)
    // The module starting again inside a live session comes right after a turn: its pictures can be asked about.
    if (!live.isOpen) captionSoon($)
    // Told before the mod looked for what waits on the person: its latest is read once more, for that.
    if (!live.sought) $.clock.after(50, () => void rebuild($, true))
    $.clock.after(PRUNE_AFTER_MS, () => void prune($))
    return
  }
  live = (await load($)) ?? emptyTrail()
  journal = []
  await update($, picked, () => NONE)
  await update($, page, () => 0)
  await push($, false)
  // The file may be from before the session went on without the mod; its transcript has all of it.
  $.clock.after(PRUNE_AFTER_MS, () => void prune($))
  const isBehind = !live.sought
  $.clock.after(50, () => void rebuild($, isBehind).then(why => (why ? $.ui.log(`trail: could not read this session's transcript back (${why}); /trail rebuild tries again`) : undefined)))
}

const ready = async ($: Dollar) => {
  if (sid) return
  starting ??= begin($).finally(() => {
    starting = null
  })
  await starting
}

/** Folds one thing that happened into the trail, never letting a fault of this mod's reach what it is watching. */
const record = async ($: Dollar, made: (now: number) => TrailEvent | null) => {
  try {
    await ready($)
    const event = made(await $.clock.now())
    if (!event) return
    if (journal && journal.length < JOURNAL_MOST) journal.push(event)
    const next = add(live, event)
    if (next === live) return
    live = next
    soon($)
    // A turn that has ended, or a running one that has said enough, has a stretch to write an update for.
    if (event.t === 'end' || event.t === 'say') digestSoon($, DIGEST_MS)
    if (event.t === 'end' && !event.aborted) captionSoon($)
  } catch (error) {
    fault($, 'record', error)
  }
}

const sizeOf = async ($: Dollar, path: string): Promise<{ w: number; h: number }> => {
  const ran = await $.process.run([SIPS, '-g', 'pixelWidth', '-g', 'pixelHeight', path], { timeoutMs: 10_000 })
  const w = /pixelWidth:\s*(\d+)/.exec(ran.stdout)
  const h = /pixelHeight:\s*(\d+)/.exec(ran.stdout)
  return { w: w ? Number(w[1]) : 0, h: h ? Number(h[1]) : 0 }
}

/**
 * Keeps a picture for the trail: a small PNG of the mod's own to draw in the
 * pane, safe from whatever later overwrites the original. The whole picture
 * is not copied when it is a file on disk (copies were most of what the mod
 * kept): the file is opened where it lies, for as long as it is still the
 * picture that was kept. One that is passing (bytes that never were a file)
 * is copied whole, there being nowhere else to open it from. Host commands
 * make these, since a mod writes only text. Resolves null for a picture that
 * could not be read.
 */
const keep = async ($: Dollar, id: string, source: string, suffix: string, isPassing = false): Promise<Shot | null> => {
  await ready($)
  if (!source.startsWith('/')) return null
  if (!hasShotsDir) {
    await $.fs.write(`${dir}/shots/.keep`, '')
    hasShotsDir = true
  }
  const name = safeName(id)
  const out = `${dir}/shots/${name}.png`
  const ran = await $.process.run([SIPS, '-s', 'format', 'png', '-Z', THUMB_PX, source, '--out', out], { timeoutMs: 15_000 })
  // sips answers 0 for a file it could not open and writes nothing: the picture is kept only if it is there.
  if (ran.exitCode !== 0 || !(await $.fs.exists(out))) {
    jot(diag.shots, `${id} not kept: ${(ran.stderr || ran.stdout).trim().slice(0, 120)}`)
    return null
  }
  const { w, h } = await sizeOf($, out)
  jot(diag.shots, `${id} ${w}x${h}`)
  if (isPassing) {
    const full = `${dir}/shots/${name}.full${suffix}`
    const copied = await $.process.run([CP, source, full], { timeoutMs: 15_000 })
    return copied.exitCode === 0 ? { file: out, w, h, full } : { file: out, w, h }
  }
  const lies = await $.fs.stat(source).catch(() => null)
  return lies?.kind === 'file' ? { file: out, w, h, full: source, stamp: Math.round(lies.mtimeMs) } : { file: out, w, h }
}

/**
 * Keeps what there is to see of a file that is no picture: the preview the
 * system makes of a video or a document, as the pane's small PNG. The file
 * itself is not copied (a video is large): it is opened where it lies.
 */
const keepPreview = async ($: Dollar, id: string, source: string, type: OutputType): Promise<Shot> => {
  await ready($)
  const none: Shot = { file: '', w: 0, h: 0, full: source, type }
  if (!source.startsWith('/')) return none
  try {
    const into = `${dir}/shots/ql-${safeName(id)}`
    await $.fs.write(`${into}/.keep`, '')
    hasShotsDir = true
    await $.process.run([QLMANAGE, '-t', '-s', THUMB_PX, '-o', into, source], { timeoutMs: 20_000 })
    const out = `${into}/${basename(source)}.png`
    if (!(await $.fs.exists(out))) return none
    const { w, h } = await sizeOf($, out)
    jot(diag.shots, `${id} ${type} ${w}x${h}`)
    return { ...none, file: out, w, h }
  } catch (error) {
    fault($, 'keepPreview', error)
    return none
  }
}

/** Something the work produced that is no picture: a video, a file handed over, a page published. Set in the trail where it happened. */
const output = async ($: Dollar, id: string, shot: Shot, label: string, anchor: string, note?: string) => {
  await record($, now => ({ t: 'shot', id, at: now, anchor, file: shot.file, w: shot.w, h: shot.h, label, ...(shot.full ? { full: shot.full } : {}), ...(shot.type ? { type: shot.type } : {}), ...(note ? { note } : {}) }))
}

/**
 * The videos a command left behind: files it names, in what it ran or what
 * it printed, that were written while it ran. Rendering and recording make
 * these, and no tool ever opens them, so this is the only place they show.
 */
const heedVideos = async ($: Dollar, id: string, text: string, since: number) => {
  try {
    const named = videosNamed(text)
    if (named.length === 0) return
    const home = (await $.env.get('HOME')) ?? ''
    const cwd = await $.session.cwd()
    for (const name of named) {
      const path = name.startsWith('/') ? name : name.startsWith('~/') ? home + name.slice(1) : `${cwd}/${name.replace(/^\.\//, '')}`
      const made = await $.fs.stat(path).catch(() => null)
      // One that was there before the command ran was only named by it, not made by it.
      if (!made || made.kind !== 'file' || made.size === 0 || made.mtimeMs < since - 2000) continue
      const key = `out:${tag(path)}:${Math.round(made.mtimeMs)}`
      if (live.items.some(item => item.id === `${key}:shot`)) continue
      await output($, key, await keepPreview($, key, path, 'video'), basename(path), id)
    }
  } catch (error) {
    fault($, 'heedVideos', error)
  }
}

const suffixOf = (path: string) => (/\.(png|jpe?g|gif|webp)$/i.exec(path)?.[0] ?? '.png').toLowerCase()

/** A picture the model looked at or sent: kept, and set in the trail where it happened. Resolves whether it was. */
const shoot = async ($: Dollar, id: string, source: string, label: string, anchor: string, suffix: string, from?: Source, note?: string, isPassing = false): Promise<boolean> => {
  try {
    const shot = await keep($, id, source, suffix, isPassing)
    if (shot) await record($, now => ({ t: 'shot', id, at: now, anchor, file: shot.file, w: shot.w, h: shot.h, label, ...(shot.full ? { full: shot.full } : {}), ...(shot.stamp !== undefined ? { stamp: shot.stamp } : {}), ...(from ? { from } : {}), ...(note ? { note } : {}) }))
    return shot !== null
  } catch (error) {
    fault($, 'shoot', error)
    return false
  }
}

/** The same for a picture that never was a file: a browser's screenshot, one the person pasted. */
const shootInline = async ($: Dollar, id: string, held: Held, label: string, anchor: string, from?: Source) => {
  try {
    await ready($)
    const text = `${dir}/shots/${safeName(id)}.b64`
    const bytes = `${dir}/shots/${safeName(id)}.bin`
    await $.fs.write(text, held.data)
    hasShotsDir = true
    const ran = await $.process.run([BASE64, '-D', '-i', text, '-o', bytes], { timeoutMs: 15_000 })
    if (ran.exitCode === 0) await shoot($, id, bytes, label, anchor, suffixOf(`.${held.type.split('/')[1] ?? 'png'}`), from, undefined, true)
    await $.process.run([RM, '-f', text, bytes], { timeoutMs: 5000 })
  } catch (error) {
    fault($, 'shootInline', error)
  }
}

const textsOf = (message: Message): string[] =>
  message.content.filter(block => block.type === 'text' && typeof block['text'] === 'string').map(block => block['text'] as string)

const imagesOf = (blocks: readonly Block[]): Held[] =>
  blocks.flatMap(block => {
    const source = block.type === 'image' ? (block['source'] as { data?: unknown; media_type?: unknown } | undefined) : undefined
    return typeof source?.data === 'string' ? [{ data: source.data, type: typeof source.media_type === 'string' ? source.media_type : 'image/png' }] : []
  })

/** One row the conversation kept: a prompt, a command, what the model said, a recap, a compaction. */
const heed = async ($: Dollar, door: string, uuid: string, message: Message, origin: string) => {
  try {
    const texts = textsOf(message)
    jot(diag.appends, `${door} ${message.type}${message.name ? '/' + message.name : ''}${message.isMeta ? ' meta' : ''} ${origin} ${uuid}`)
    if (door === 'response') {
      let index = 0
      for (const text of texts) {
        const id = index === 0 ? uuid : `${uuid}:${index}`
        index++
        await record($, now => ({ t: 'say', id, at: now, text }))
      }
      return
    }
    if (door === 'notice') {
      const text = texts[0]
      if (message.name === 'away_summary' && text) await record($, now => ({ t: 'recap', id: uuid, at: now, text }))
      return
    }
    if (door === 'compaction') {
      await record($, now => ({ t: 'compact', id: uuid, at: now }))
      return
    }
    // What the person typed while the turn ran reaches it wrapped in the engine's words; theirs are inside.
    if (door === 'delivery' && message.type === 'attachment' && message.name === 'queued_command') {
      const typed = TYPED_MEANWHILE.exec(texts.join('\n'))?.[1]
      if (typed) await record($, now => ({ t: 'prompt', id: uuid, at: now, text: typed }))
      return
    }
    if (message.isMeta || message.type !== 'user' || texts.length === 0) return
    const text = texts.join('\n')
    // The mod's own command is no part of the work.
    if (/<command-name>\s*\/?trail\s*</.test(text)) return
    await record($, now => ({ t: 'prompt', id: uuid, at: now, text, isCommand: door === 'command' }))
    let index = 0
    for (const held of imagesOf(message.content)) await shootInline($, `${uuid}:${index++}`, held, 'You pasted a picture', uuid, 'person')
  } catch (error) {
    fault($, 'heed', error)
  }
}

/** Pictures a connected tool answered with: they are in the row its result is kept as, and nowhere on disk. */
const heedPictures = async ($: Dollar, message: Message, tool: string) => {
  try {
    const short = tool.split('__').slice(2).join(' ') || tool
    for (const block of message.content) {
      const id = block['tool_use_id']
      const inside = block['content']
      if (block.type !== 'tool_result' || typeof id !== 'string' || !Array.isArray(inside)) continue
      const held = imagesOf(inside as Block[]).at(-1)
      if (held) await shootInline($, id, held, `Picture from ${short}`, id)
    }
  } catch (error) {
    fault($, 'heedPictures', error)
  }
}

/** What came of a tool call: a failure to count, or a picture the model looked at or sent. */
const heedResult = async ($: Dollar, id: string, tool: string, input: Record<string, unknown>, since: number, ran: { deny?: string; isError?: true; result?: unknown; text?: string }) => {
  const file = typeof input['file_path'] === 'string' ? input['file_path'] : undefined
  try {
    if (ran.deny !== undefined || ran.isError === true) {
      await record($, now => ({ t: 'fail', id, at: now }))
      return
    }
    const result = (typeof ran.result === 'object' && ran.result !== null ? ran.result : {}) as { type?: unknown; attachments?: unknown; file?: { base64?: unknown; type?: unknown } }
    if (tool === 'Read' && file && result.type === 'image') {
      // Read finds a file whose name it was given nearly right; the picture it returned is there when the name is not.
      // A picture that was on disk before the session began was looked at, not made: it is no output of Claude's.
      const written = await $.fs.stat(file).then(
        stat => stat.mtimeMs,
        () => 0,
      )
      const from = isEarlier(written, live.items[0]?.at ?? 0) ? ('earlier' as const) : undefined
      const isKept = await shoot($, id, file, basename(file), id, suffixOf(file), from)
      const data = result.file?.base64
      if (!isKept && typeof data === 'string' && data) await shootInline($, id, { data, type: typeof result.file?.type === 'string' ? result.file.type : 'image/png' }, basename(file), id, from)
    }
    if (tool === 'SendUserFile' && Array.isArray(result.attachments)) {
      const said = typeof input['caption'] === 'string' ? input['caption'] : undefined
      let index = 0
      for (const sent of result.attachments as { path?: unknown; isImage?: unknown }[]) {
        if (typeof sent.path === 'string') {
          const key = `${id}:${index}`
          const label = SENT + basename(sent.path)
          // Whatever was handed over is an output: a picture is kept as one, anything else by its preview. What
          // Claude said of it as it sent it is its caption, there at once.
          if (sent.isImage === true) await shoot($, key, sent.path, label, id, suffixOf(sent.path), undefined, said)
          else await output($, key, await keepPreview($, key, sent.path, outputType(sent.path) === 'video' ? 'video' : 'file'), label, id, said)
        }
        index++
      }
    }
    if (tool === 'Bash') await heedVideos($, id, `${typeof input['command'] === 'string' ? input['command'] : ''}\n${ran.text ?? ''}`, since)
    if (tool === 'Artifact') {
      const url = publishedAt(ran.text ?? '')
      if (url) await output($, id, { file: '', w: 0, h: 0, full: url, type: 'link' }, `Published ${typeof input['file_path'] === 'string' ? basename(input['file_path']) : 'a page'}`, id)
    }
  } catch (error) {
    fault($, 'heedResult', error)
  }
}

const openPane = ($: Dollar) => $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS })

/** Moves the pane's own window back to its top, where the newest is; a pane not drawn yet has no window to move. */
const paneToTop = async ($: Dollar) => {
  try {
    await $.ui.scroll({ in: PANE, to: 'start' })
  } catch (error) {
    jot(diag.faults, `paneToTop: ${whyNot(error)}`)
  }
}

/**
 * Puts Claude's question in the pane, under its picture when it has one, and
 * resolves what to tell Claude about it. The pane is brought up for it, since
 * a question nobody sees is no question.
 */
const post = async ($: Dollar, id: string, text: string, options: string[], image: string): Promise<string> => {
  let shot: Shot | null = null
  if (image) shot = await keep($, `q-${id}`, image, suffixOf(image)).catch(() => null)
  await record($, now => ({ t: 'question', id, at: now, text, options, ...(shot ? { shot } : {}) }))
  await push($, true)
  jot(diag.questions, `asked ${id}${image ? (shot ? ' with a picture' : ' (picture unreadable)') : ''}`)
  try {
    // A question is to be answered before anything else is read: the pane turns to it.
    await update($, mode, () => ASKING)
    await update($, page, () => 0)
    const isShown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
    if (isShown) await paneToTop($)
    else {
      void openPane($).catch(() => undefined)
      $.ui.toast('Claude has a question for you: /trail')
    }
  } catch (error) {
    fault($, 'post', error)
  }
  const pictured = image && !shot ? ' The picture could not be read, so the question shows without it.' : ''
  return `The question is in the person's Trail pane.${pictured} Their answer will arrive as their next message: end your turn if you cannot go on without it.`
}

/** The person's answer to a question in the pane: kept beside it, and sent to the conversation as their own words. */
const answer = async ($: Dollar, question: Question, text: string) => {
  try {
    const said = clean(text)
    if (!said || answered.has(question.id)) return
    answered.add(question.id)
    await record($, now => ({ t: 'answer', id: question.id, at: now, text: said }))
    // With nothing left waiting the pane goes back to the feed.
    if (waitingCount(live) === 0) await update($, mode, now => (now === ASKING ? 'feed' : now))
    await push($, true)
    jot(diag.questions, `answered ${question.id}`)
    await $.prompt.submit({ text: paneAnswer(question.text, said), asUser: true })
  } catch (error) {
    fault($, 'answer', error)
  }
}

/** The person says a thing the work left for them is done: it stops waiting. */
const settle = async ($: Dollar, id: string) => {
  try {
    const now = await $.clock.now()
    live = { ...live, feed: live.feed.map(beat => (beat.id === id && beat.over === undefined ? { ...beat, over: now } : beat)) }
    if (waitingCount(live) === 0) await update($, mode, at => (at === ASKING ? 'feed' : at))
    await push($, true)
  } catch (error) {
    fault($, 'settle', error)
  }
}

/**
 * Scrolls the transcript to the row a line stands for. The scroll is the
 * first thing awaited: the transcript is the person's to move, and only what
 * answers their press may move it.
 */
const jump = async ($: Dollar, target: Target) => {
  try {
    const { why, tried } = await reach(candidates(target, groupsByCall), id =>
      $.ui.scroll({ to: { requestId: id }, block: 'start' }).then(
        moved => moved.deny,
        error => whyNot(error),
      ),
    )
    jot(diag.jumps, `${target.kind} ${target.id} ${tried.join(' | ')}`)
    await update($, picked, now => ({ id: target.id, jump: why, ...(now.id === target.id && now.isOpen ? { isOpen: true as const } : {}) }))
  } catch (error) {
    fault($, 'jump', error)
  }
}

/** Shows all an entry has to say, or goes back to its first rows when it is the one shown whole. */
const unfold = async ($: Dollar, target: Target) => {
  try {
    await update($, picked, now => (now.id === target.id && now.isOpen ? NONE : { id: target.id, isOpen: true }))
  } catch (error) {
    fault($, 'unfold', error)
  }
}

/**
 * Opens an output in the person's own viewer: the thing itself where it
 * lies, or the small copy the mod kept when a picture's file is gone or has
 * been written over since (the same name now holds another picture).
 */
const openPicture = async ($: Dollar, shot: Shot) => {
  try {
    let path = shot.full || shot.file
    if (shot.full && shot.type !== 'link') {
      const lies = await $.fs.stat(shot.full).catch(() => null)
      const isSame = lies?.kind === 'file' && (shot.stamp === undefined || Math.round(lies.mtimeMs) === shot.stamp)
      // A video or a document has no copy to fall back on: what is there now is opened, if anything is.
      if (!isSame && shot.file) {
        path = shot.file
        $.ui.toast(lies ? 'The file has changed since: opening the copy Trail kept.' : 'The file is gone: opening the copy Trail kept.')
      } else if (!lies) {
        $.ui.toast(`Trail could not open it: ${basename(shot.full)} is no longer there.`)
        return
      }
    }
    if (!path) return
    const ran = await $.process.run([OPEN, path], { timeoutMs: 10_000 })
    if (ran.exitCode !== 0) $.ui.toast(`Trail could not open it: ${ran.stderr.trim().slice(0, 80)}`)
  } catch (error) {
    fault($, 'openPicture', error)
  }
}

const turnPage = async ($: Dollar, by: number) => {
  try {
    await update($, page, at => Math.max(0, by === 0 ? 0 : at + by))
    await paneToTop($)
  } catch (error) {
    fault($, 'turnPage', error)
  }
}

/** The view for what waits on the person, questions and things left for them to do: among the tabs only while something does. */
const ASKING: Mode = 'questions'

const EMPTY_VIEW: Record<Mode, string> = {
  sent: 'Nothing sent to you yet. Each file Claude sends you, and each page it publishes, shows here to open.',
  questions: 'Nothing is waiting on you.',
  feed: 'Nothing yet. The feed fills in as the conversation goes.',
  done: 'No big task finished yet. One is listed here when a whole piece of work is done.',
  outputs: 'Nothing made yet. What Claude produces shows here: screenshots of its work, videos, files it sends you, pages it publishes.',
  steps: 'Nothing yet. Each step shows here as it happens.',
}

/** The views, as the tabs name them. No hotkeys: their letters beside each name were more to read than the names. */
const TABS: readonly { mode: Mode; label: string }[] = [
  { mode: 'feed', label: 'highlights' },
  { mode: 'sent', label: 'sent' },
  { mode: 'done', label: 'done' },
  { mode: 'outputs', label: 'outputs' },
  { mode: 'steps', label: 'every step' },
]

const switchMode = async ($: Dollar, to: Mode) => {
  try {
    await update($, mode, () => to)
    await update($, page, () => 0)
    await update($, picked, () => NONE)
    await paneToTop($)
  } catch (error) {
    fault($, 'switchMode', error)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'trail',
      description: 'Show what this conversation did as a feed in a side pane; click a line to jump there',
      argumentHint: '[close|off|on|rebuild|where]',
      immediate: true,
    })
    await $.tool.register({ name: 'ask', description: ASK_DESCRIPTION, inputSchema: ASK_SCHEMA })
    try {
      await ready($)
      const isClosed = (await $.store.get('closed')) === true
      const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
      // Unasked, so the engine seats it only where there is room for a sidebar; /trail seats it anywhere.
      if (!isClosed && !isUp) void openPane($).catch(() => undefined)
    } catch (error) {
      fault($, 'session.start', error)
    }

    return next(e)
  })

  on('command.run', { command: 'trail' }, async ($, e) => {
    const verb = e.args.trim().toLowerCase()
    await ready($)
    if (verb === 'close') {
      await $.store.set('closed', true)
      await $.ui.close({ id: PANE })
      return { text: 'Trail closed.' }
    }
    if (verb === 'where') return { text: `Trail keeps this session in ${dir}${await keptSize($)}` }
    if (verb === 'off') {
      await $.store.set('off', true)
      await tell($, OFF)
      return { text: 'Trail is off in every session: it still notes each step, which costs nothing, but writes no updates and asks no model. /trail on turns it back on.' }
    }
    if (verb === 'on') {
      await $.store.set('off', false)
      await tell($, '')
      digestSoon($, 50)
      if (!live.isOpen) captionSoon($)
      return { text: 'Trail is on: updates are being written for what happened meanwhile.' }
    }
    if (verb === 'rebuild') {
      const why = await rebuild($, true)
      if (why) return { text: `Trail could not read the transcript back: ${why}` }
    } else if (verb !== '' && verb !== 'open') return { text: USAGE }

    await $.store.set('closed', false)
    await push($, false)
    const opened = await openPane($)
    if (!opened.isPlaced) return { text: `Trail is open but not shown: ${opened.reason}` }
    await paneToTop($)

    return { text: verb === 'rebuild' ? `Trail rebuilt from the transcript: ${live.items.length} steps.` : OPENED }
  })

  on('session.append', { door: ['prompt', 'command', 'response', 'delivery', 'compaction', 'notice'] }, async ($, e, next) => {
    // The row is the session's to store: it is read on its way there and passed on as it came.
    if (e.agentId === undefined) await heed($, e.door, e.uuid, e.message, e.origin.kind)

    return next(e)
  })

  on('session.append', { door: 'tool-result', origin: { kind: 'tool', tool: /^mcp__/ } }, async ($, e, next) => {
    if (e.agentId === undefined) await heedPictures($, e.message, e.origin.kind === 'tool' ? e.origin.tool : '')

    return next(e)
  })

  on('tool.call', { tool: ASK_TOOL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const question = typeof input['question'] === 'string' ? clean(input['question']) : ''
    if (!question) return { isError: true, result: 'No question was given: pass `question`.' }
    const options = Array.isArray(input['options']) ? input['options'].filter((option): option is string => typeof option === 'string') : []
    const image = typeof input['image'] === 'string' ? input['image'] : ''
    try {
      return { result: await post($, e.tool_use_id, question, options, image) }
    } catch (error) {
      fault($, 'ask', error)
      return { isError: true, result: `The question could not be put in the pane: ${whyNot(error)}. Ask it in the conversation instead.` }
    }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const id = e.tool_use_id
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const file = typeof input['file_path'] === 'string' ? input['file_path'] : undefined
    const since = await $.clock.now().catch(() => 0)
    await record($, now => ({ t: 'tool', id, at: now, tool, note: toolNote(tool, input), file }))
    const ran = await next(e)
    await heedResult($, id, tool, input, since, ran)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // A turn the person stopped, or that broke, did not come out as what was last said.
      const isCut = e.isAborted || e.reason !== 'answer'
      await record($, now => ({ t: 'end', at: now, ...(isCut ? { aborted: true } : {}) }))
      // A reload of this module comes when a turn ends, so the trail is handed over and saved before then.
      await push($, true)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await push($, true)
    if (e.reason === 'clear' || e.reason === 'resume') {
      // The process goes on under another session id, and no session.start follows: the next row begins its trail.
      sid = ''
      live = emptyTrail()
      await update($, saved, () => EMPTY).catch(() => undefined)
    }

    return next(e)
  })

  // The engine's word that the process now runs under a session: after /resume or /clear no session.start says so.
  on('classic.SessionStart', async ($, e, next) => {
    try {
      if (sid && e.session_id !== sid) {
        sid = ''
        live = emptyTrail()
      }
      await ready($)
    } catch (error) {
      fault($, 'classic.SessionStart', error)
    }

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set('closed', true).catch(() => undefined)

    return closed
  })

  // A run of calls the transcript folded into one line, left as it is: its id is what a jump to one of them scrolls to.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    for (const call of e.props.calls) if (call.tool_use_id) groupsByCall.set(call.tool_use_id, e.requestId)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kept = await read($, saved)
    const pick = await read($, picked)
    const back = await read($, page)
    const kind = await read($, mode)
    const trail = mended(kept.trail) ?? emptyTrail()
    const waiting = waitingCount(trail)
    // The tab for what waits on the person is there only while something does; with nothing left, the pane is back at the feed.
    const tabs = waiting > 0 ? [{ mode: ASKING, label: `${waiting} waiting on you` }, ...TABS] : TABS
    const listing: Mode = tabs.some(tab => tab.mode === kind) ? kind : 'feed'
    const doing = await read($, status)
    // A cell of margin each side keeps the words off the pane's frame.
    const width = Math.max(18, Math.min(200, e.props.bodyColumns) - 2 * MARGIN)
    const { rows, earlier, later, foot } = layout(trail, { width, picked: pick, page: back, mode: listing, zone })
    const { Box, Button, Text } = $.ui.resolve(e)
    const Image = e.surface === 'terminal' ? $.ui.resolve(e).Image : null
    const Input = e.surface === 'mobile' ? null : $.ui.resolve(e).Input

    return (
      <Box flexDirection="column" paddingX={MARGIN}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {tabs.map(tab =>
            tab.mode === listing ? (
              <Text bold inverse>{` ${tab.label} `}</Text>
            ) : (
              <Button key={`tab:${tab.mode}`} plain dimColor={tab.mode !== ASKING} label={tab.label} onPress={() => void switchMode($, tab.mode)} />
            ),
          )}
        </Box>
        <Text dimColor wrap="truncate-end">
          {doing ? `${foot} · ${doing}` : foot}
        </Text>
        {later > 0 && (
          <Box flexDirection="row" columnGap={2}>
            <Button key="later" plain dimColor label={`[${later} later]`} onPress={() => void turnPage($, -1)} />
            <Button key="latest" plain dimColor label="[latest]" onPress={() => void turnPage($, 0)} />
          </Box>
        )}
        <Box flexDirection="column" marginTop={1} rowGap={1}>
          {rows.length === 0 && <Text dimColor>{EMPTY_VIEW[listing]}</Text>}
          {rows.map(row => {
            if (row.kind === 'day') {
              return (
                <Text dimColor wrap="truncate-end">
                  {`${row.text} ${'─'.repeat(Math.max(0, width - row.text.length - 1))}`}
                </Text>
              )
            }
            if (row.kind === 'head') {
              return (
                <Text bold wrap="truncate-end">
                  {`${row.text} ${'─'.repeat(Math.max(0, width - row.text.length - 1))}`}
                </Text>
              )
            }
            if (row.kind === 'question') {
              const { question, picture } = row
              const whole = question.shot && (question.shot.full || question.shot.file) ? question.shot : undefined
              return (
                <Box key={`row:${row.key}`} flexDirection="column" rowGap={1}>
                  <Text dimColor wrap="truncate-end">{`Claude is asking you · ${row.time}`}</Text>
                  {picture && Image && <Image source={{ file: picture.file, format: 'png' }} columns={picture.columns} rows={picture.rows} alt={picture.alt} />}
                  <Box flexDirection="column">
                    {row.lines.map(text => (
                      <Text bold wrap="truncate-end">
                        {text}
                      </Text>
                    ))}
                  </Box>
                  {question.options.length > 0 && (
                    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                      {question.options.map((option, index) => (
                        <Button key={`answer:${question.id}:${index}`} label={option} onPress={() => void answer($, question, option)} />
                      ))}
                    </Box>
                  )}
                  {Input && <Input key={`say:${question.id}`} placeholder="Type your answer" submitLabel="Send" onSubmit={value => void answer($, question, value)} />}
                  <Box flexDirection="row" columnGap={2}>
                    {whole && <Button key={`open:${row.key}`} plain dimColor label="[open]" onPress={() => void openPicture($, whole)} />}
                    <Button key={`go:${row.key}`} plain dimColor label={GO_WORD} onPress={() => void jump($, { id: row.key, anchor: question.id, kind: 'question' })} />
                  </Box>
                </Box>
              )
            }
            const { target, open, picture, settles } = row
            const isAsk = row.tone === 'ask'
            const isQuiet = row.tone === 'quiet'
            const pad = ' '.repeat(row.pad)
            return (
              <Box key={`row:${row.key}`} flexDirection="column">
                <Box flexDirection="row" columnGap={2}>
                  <Text dimColor>{row.time}</Text>
                  {open && <Button key={`open:${row.key}`} plain dimColor label="[open]" onPress={() => void openPicture($, open)} />}
                  {row.hasMore && <Button key={`more:${row.key}`} plain dimColor label={row.isOpen ? '[less]' : '[more]'} onPress={() => void unfold($, target)} />}
                  {settles && <Button key={`settle:${row.key}`} plain dimColor label="[done]" onPress={() => void settle($, settles)} />}
                  <Box display="none" hover={{ display: 'flex' }}>
                    <Button key={`go:${row.key}`} plain label={GO} onPress={() => void jump($, target)} />
                  </Box>
                </Box>
                {row.note !== '' && (
                  <Text dimColor wrap="truncate-end">
                    {row.note}
                  </Text>
                )}
                {row.lines.map((text, index) => (
                  <Text bold={isAsk} dimColor={isQuiet} wrap="truncate-end">
                    {index === 0 && row.pad > 0 ? `${row.glyph} ${text}` : pad + text}
                  </Text>
                ))}
                {row.work !== '' && (
                  <Text dimColor wrap="truncate-end">
                    {`${pad}└ ${row.work}`}
                  </Text>
                )}
                {picture && Image && (
                  <Box flexDirection="row" marginTop={1}>
                    <Text>{pad}</Text>
                    <Image source={{ file: picture.file, format: 'png' }} columns={picture.columns} rows={picture.rows} alt={picture.alt} />
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
        {earlier > 0 && (
          <Box flexDirection="row" columnGap={2} marginTop={1}>
            <Button key="earlier" plain dimColor label={`[${earlier} earlier]`} onPress={() => void turnPage($, 1)} />
          </Box>
        )}
      </Box>
    )
  })
}
