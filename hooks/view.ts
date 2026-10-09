// What the pane shows, as plain rows: the trail laid out for a width, before any element is made.
// Pure, so a test or the preview tool can read a page without a terminal.

import type { Item, ItemKind, Mode, OutputType, Picked, Question, Shot, Trail } from '../types'
import { clip, isOwnOutput, isSent, SENT, waitingCount, workCount, workLine } from './trail.ts'

/** What a press on a line jumps to: the transcript row it stands for, and a tool call beside it. */
export type Target = { id: string; anchor: string; alt?: string; kind: string }

export type Picture = { file: string; columns: number; rows: number; alt: string }

/**
 * One entry of the pane, whatever the view. Every entry is drawn the same
 * way: a quiet row with its time and its actions in brackets, then what it
 * says under that, then its picture if it has one.
 */
export type Row =
  | { kind: 'day'; key: string; text: string }
  | {
      kind: 'line'
      key: string
      /** What `[go to conversation]` scrolls the transcript to. */
      target: Target
      time: string
      /** The mark before the words, or a space for an entry that has none (an update is read as a short piece). */
      glyph: string
      /** The words, wrapped: a few rows at rest, all of them once `[more]` is pressed. */
      lines: string[]
      /** Cells the words after the first row are set in by: the mark's width. */
      pad: number
      /** There is more to read than is shown: the entry has `[more]`, or `[less]` while it is all shown. */
      hasMore: boolean
      isOpen: boolean
      work: string
      /** Once the person has asked to go to the entry's place in the conversation: that it went, or why it did not. */
      note: string
      /** How the words are weighted: what was asked, something to be read, or an aside. */
      tone: 'ask' | 'plain' | 'quiet'
      /** An output's entry: the whole of it, for `[open]`. */
      open?: string
      /** An output's entry: its picture, when it is one of those drawn. */
      picture?: Picture
      /** A thing the work left for the person to do: what `[done]` stops waiting. */
      settles?: string
    }
  | {
      kind: 'question'
      key: string
      question: Question
      time: string
      /** The question, wrapped. */
      lines: string[]
      picture?: Picture
    }

export type Page = {
  rows: Row[]
  /** Entries older than the page shows, and newer. */
  earlier: number
  later: number
  foot: string
}

export type Look = {
  width: number
  picked: Picked
  page: number
  mode: Mode
  /** Minutes east of UTC where the person is. */
  zone: number
}

/** Lines to a page, and how far a page back moves: pages overlap so a place is not lost. */
export const PAGE_LINES = 120
export const PAGE_STEP = 80
/** Outputs to a page of the outputs view: each is drawn, so far fewer. */
export const PAGE_OUTPUTS = 12
/** Pictures drawn at once; the rest are a line each until pressed. */
const PICTURES = 6
/** A terminal cell is about twice as tall as it is wide. */
const CELL_ASPECT = 0.5
const PICTURE_ROWS = 14
const PICTURE_COLUMNS = 64
/** Cells an entry's mark takes before its words, and that the rows under the first are set in by. */
const MARK = 2
/** The widest a line of text is set, in cells: wider is tiring to read. */
const MEASURE = 72
const NOBODYS = /^(Background task\b|Carried on without a new prompt$)/

const GLYPH: Record<ItemKind, string> = { ask: '❯', step: '•', done: '✓', shot: '▣', recap: '≡', compact: '~' }
/** Lines of a request or a step shown once it is opened, and of an update always: an update is there to be read whole. */
const DETAIL_OPEN = 12
const UPDATE_LINES = 12
const CAPTION_LINES = 6
const OUTPUT_GLYPH: Record<OutputType, string> = { image: '▣', video: '▶', file: '▤', link: '↗' }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const isWide = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1faff) ||
  (code >= 0x20000 && code <= 0x3fffd)

/** How many terminal cells a string takes, near enough to cut it by. */
export const cells = (text: string): number => {
  let count = 0
  for (const char of text) count += isWide(char.codePointAt(0) ?? 0) ? 2 : 1
  return count
}

const cutTo = (text: string, width: number): string => {
  let out = ''
  let used = 0
  for (const char of text) {
    const size = isWide(char.codePointAt(0) ?? 0) ? 2 : 1
    if (used + size > width) break
    out += char
    used += size
  }
  return out
}

/** Wraps at words into at most `max` lines of `width` cells; what does not fit ends in an ellipsis. */
export const wrap = (text: string, width: number, max: number): string[] => {
  const room = Math.max(4, width)
  const out: string[] = []
  let line = ''
  const words = text.split(' ').filter(Boolean)
  let index = 0
  for (; index < words.length; index++) {
    let word = words[index]!
    const joined = line ? line + ' ' + word : word
    if (cells(joined) <= room) {
      line = joined
      continue
    }
    if (line) {
      out.push(line)
      line = ''
      if (out.length === max) break
    }
    // A word wider than the line is broken across lines.
    while (cells(word) > room) {
      const piece = cutTo(word, room)
      out.push(piece)
      word = word.slice(piece.length)
      if (out.length === max) break
    }
    if (out.length === max) break
    line = word
  }
  if (line && out.length < max) {
    out.push(line)
    index = words.length
  }
  if (index < words.length && out.length > 0) {
    const last = out[out.length - 1]!
    out[out.length - 1] = (cells(last) >= room ? cutTo(last, room - 1) : last).replace(/[\s,;:.]+$/, '') + '…'
  }
  return out
}

/** Wrapped lines with a tail set after the last of them, the line cut to make room: how long a turn ran is said whatever the length of what was asked. */
const tailed = (lines: string[], tail: string, room: number): string[] => {
  if (!tail || lines.length === 0) return lines
  const last = lines[lines.length - 1]!
  const fits = cells(last) + 2 + cells(tail) <= room
  const kept = fits ? last : cutTo(last, Math.max(1, room - cells(tail) - 3)).replace(/[\s,;:.…]+$/, '') + '…'
  return [...lines.slice(0, -1), kept + '  ' + tail]
}

const local = (at: number, zone: number): Date => new Date(at + zone * 60_000)
const two = (n: number): string => String(n).padStart(2, '0')

export const clock = (at: number, zone: number): string => {
  const date = local(at, zone)
  return two(date.getUTCHours()) + ':' + two(date.getUTCMinutes())
}

const dayOf = (at: number, zone: number): string => {
  const date = local(at, zone)
  return DAYS[date.getUTCDay()]! + ' ' + MONTHS[date.getUTCMonth()]! + ' ' + date.getUTCDate()
}

/** "42s", "3m", "2h 05m", "1d 4h": how long something took, or how long ago it was. */
export const span = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return Math.max(1, Math.round(ms / 1000)) + 's'
  if (minutes < 60) return minutes + 'm'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + 'h ' + two(minutes % 60) + 'm'
  return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h'
}

/** "+0900" or "-1000", as `date +%z` prints it, in minutes east of UTC; undefined when it is neither. */
export const zoneOf = (text: string): number | undefined => {
  const found = /^([+-])(\d\d)(\d\d)$/.exec(text.trim())
  if (!found) return undefined
  return (found[1] === '-' ? -1 : 1) * (Number(found[2]) * 60 + Number(found[3]))
}

/** The box of cells a picture of that shape is drawn in: as wide as there is room, never taller than a glance. */
export const pictureBox = (w: number, h: number, room: number): { columns: number; rows: number } => {
  const tall = w > 0 && h > 0 ? h / w : 0.625
  let columns = Math.max(8, Math.min(PICTURE_COLUMNS, 255, room))
  let rows = Math.max(1, Math.round(columns * tall * CELL_ASPECT))
  if (rows > PICTURE_ROWS) {
    rows = PICTURE_ROWS
    columns = Math.max(4, Math.min(columns, Math.round(rows / (tall * CELL_ASPECT))))
  }
  return { columns, rows }
}

const pictureOf = (shot: Shot, room: number, alt: string): Picture => ({ file: shot.file, ...pictureBox(shot.w, shot.h, room), alt: alt || ' ' })

/** Of a run of pictures taken one after another the last is drawn, and only of the newest runs. */
const drawnPictures = (items: Item[], picked: string): Set<string> => {
  // A recap or a compaction mark between two pictures does not part them.
  const told = items.filter(item => item.kind !== 'recap' && item.kind !== 'compact')
  const lastOfRun: string[] = []
  told.forEach((item, index) => {
    if (item.kind === 'shot' && told[index + 1]?.kind !== 'shot') lastOfRun.push(item.id)
  })
  const drawn = new Set(lastOfRun.slice(-PICTURES))
  if (picked) drawn.add(picked)
  return drawn
}

const counted = (count: number, one: string, many: string): string => count + ' ' + (count === 1 ? one : many)

const footOf = (trail: Trail, look: Look): string => {
  const steps = trail.items.filter(item => item.kind === 'step' || item.kind === 'done').length
  const outputs = trail.items.filter(item => isOwnOutput(item, trail)).length
  const waiting = waitingCount(trail)
  const told = trail.feed.filter(beat => beat.kind !== 'built' && beat.kind !== 'waiting').length
  const tasks = trail.feed.filter(beat => beat.kind === 'built').length
  const parts =
    look.mode === 'questions'
      ? []
      : [look.mode === 'sent' ? trail.items.filter(isSent).length + ' sent to you' : look.mode === 'feed' ? counted(told, 'update', 'updates') : look.mode === 'done' ? counted(tasks, 'big task done', 'big tasks done') : look.mode === 'outputs' ? counted(outputs, 'output', 'outputs') : counted(steps, 'step', 'steps')]
  if (waiting > 0) parts.push(waiting + ' waiting on you')
  const last = Math.max(trail.lastAt, trail.items.reduce((latest, item) => Math.max(latest, item.at), 0))
  // The day, not how long ago: the pane may sit undrawn for a night, and an age would go stale in it.
  if (trail.isOpen) parts.push('working now')
  else if (last > 0) parts.push('quiet since ' + dayOf(last, look.zone) + ' ' + clock(last, look.zone))
  return parts.join(' · ')
}

type Entry = { at: number; rank: number; seq: number; row: (drawn: Set<string>) => Row }

/** Rows of an entry's words shown at rest and once opened, by what the entry is. */
const AT_REST: Record<ItemKind, number> = { ask: 3, step: 2, done: 4, shot: 1, recap: 8, compact: 1 }

export const layout = (trail: Trail, look: Look): Page => {
  // Text is set no wider than reads well, however wide the pane is drawn.
  const width = Math.max(16, Math.min(look.width, MEASURE))
  const isOpen = (id: string): boolean => look.picked.id === id && look.picked.isOpen === true
  const noteFor = (id: string): string => {
    if (look.picked.id !== id || look.picked.jump === undefined) return ''
    return look.picked.jump ? clip("can't go there: " + look.picked.jump, width) : 'the conversation is at this point now'
  }
  const timeOf = (at: number): string => (at > 0 ? clock(at, look.zone) : '--:--')
  const entries: Entry[] = []
  let seq = 0

  // The feed is the updates and the pictures, and nothing else: what was asked and each step are the other
  // view's. One line stands in for what no update tells of yet, the latest of it, so a running turn is seen to move.
  // The outputs are what the work produced, each drawn; the list of things done has no steps at all.
  const untold = look.mode === 'feed' ? [...trail.items].reverse().find(item => (item.kind === 'step' || item.kind === 'done') && !item.fed) : undefined
  for (const item of trail.items) {
    if (look.mode === 'done' || look.mode === 'questions') break
    // The outputs are Claude's: what the session made, sent or published, not what the person showed it.
    if (look.mode === 'outputs' && !isOwnOutput(item, trail)) continue
    // What Claude sent is a view of its own: the files and pages a conversation says it handed over.
    if (look.mode === 'sent' && !isSent(item)) continue
    if (look.mode === 'feed' && item.kind !== 'shot' && item !== untold) continue
    entries.push({
      at: item.at,
      rank: item.kind === 'ask' ? 0 : 1,
      seq: seq++,
      row: drawn => {
        const opened = isOpen(item.id)
        const isOutput = item.kind === 'shot'
        const room = Math.max(8, width - MARK)
        const took = item.kind === 'ask' && item.ms !== undefined && item.ms >= 60_000 ? '(' + span(item.ms) + ')' : ''
        // Opened, a request or a step shows all that was said; at rest, its first sentence.
        const rest = AT_REST[item.kind] ?? 2
        // Among the things sent, each is named by its file alone: that it was sent goes without saying there.
        const name = look.mode === 'sent' && item.line.startsWith(SENT) ? item.line.slice(SENT.length) : item.line
        const atRest = wrap(name, room, rest)
        const whole = wrap(item.more ?? name, room, DETAIL_OPEN)
        const hasMore = whole.length > atRest.length || (item.more !== undefined && item.more.length > item.line.length) || (atRest.at(-1)?.endsWith('…') ?? false)
        const said = tailed(opened ? whole : atRest, took, room)
        // An output is told of too: what it shows and what it was about, under its name.
        const lines = item.shot?.note ? [...said, ...wrap(item.shot.note, room, CAPTION_LINES)] : said
        const isDrawn = isOutput && item.shot?.file && drawn.has(item.id)
        return {
          kind: 'line',
          key: item.id,
          target: { id: item.id, anchor: item.anchor, kind: item.kind, ...(item.alt ? { alt: item.alt } : {}) },
          time: timeOf(item.at),
          glyph: item === untold ? '…' : isOutput ? OUTPUT_GLYPH[item.shot?.type ?? 'image'] : (GLYPH[item.kind] ?? '•'),
          lines,
          pad: MARK,
          hasMore: hasMore && !isOutput,
          isOpen: opened,
          // In the feed the tally is noise; under a step it is what the step came to.
          work: look.mode === 'steps' && item.work && workCount(item.work) > 0 ? clip(workLine(item.work), Math.max(8, room - 2)) : '',
          note: noteFor(item.id),
          // A request is the person's; work a finished background task set off, or that simply carried on, is nobody's.
          tone: item === untold ? 'quiet' : item.kind === 'ask' ? (NOBODYS.test(item.line) ? 'quiet' : 'ask') : item.kind === 'recap' || item.kind === 'compact' ? 'quiet' : 'plain',
          ...(isOutput && item.shot ? { open: item.shot.full || item.shot.file } : {}),
          ...(isDrawn ? { picture: pictureOf(item.shot!, room, item.line) } : {}),
        }
      },
    })
  }

  if (look.mode === 'feed' || look.mode === 'done' || look.mode === 'questions') {
    for (const beat of trail.feed) {
      // A big task done is one list's and a thing left with the person another's; the feed is the updates.
      const isTask = beat.kind === 'built'
      const isWait = beat.kind === 'waiting'
      if (isWait ? look.mode !== 'questions' || beat.over !== undefined : isTask !== (look.mode === 'done') || look.mode === 'questions') continue
      entries.push({
        at: beat.at,
        // An update tells of what came before it, pictures included: it sits above them.
        rank: 3,
        seq: seq++,
        row: () => {
          // A thing done or to do is a line with its mark; an update is a short piece, read across the whole pane.
          const pad = isTask || isWait ? MARK : 0
          return {
            kind: 'line',
            key: beat.id,
            target: { id: beat.id, anchor: beat.anchor, kind: isTask ? 'task' : isWait ? 'wait' : 'update', ...(beat.alt ? { alt: beat.alt } : {}) },
            time: timeOf(beat.at),
            glyph: isTask ? '✓' : isWait ? '○' : ' ',
            lines: wrap(beat.detail ? beat.title + ' ' + beat.detail : beat.title, width - pad, UPDATE_LINES),
            pad,
            hasMore: false,
            isOpen: false,
            work: '',
            note: noteFor(beat.id),
            tone: isTask || isWait ? 'ask' : 'plain',
            ...(isWait ? { settles: beat.id } : {}),
          }
        },
      })
    }
  }

  // A question asked and answered is a thing that happened: it is told among the steps, and nowhere else.
  for (const question of trail.questions) {
    if (question.answer === undefined || look.mode !== 'steps') continue
    const id = 'q:' + question.id
    entries.push({
      at: question.at,
      rank: 2,
      seq: seq++,
      row: () => {
        const room = Math.max(8, width - MARK)
        return {
          kind: 'line',
          key: id,
          target: { id, anchor: question.id, kind: 'question' },
          time: timeOf(question.at),
          glyph: '?',
          lines: [...wrap(question.text, room, 3), ...wrap('You: ' + question.answer, room, 3)],
          pad: MARK,
          hasMore: false,
          isOpen: false,
          work: '',
          note: noteFor(id),
          tone: 'plain',
        }
      },
    })
  }

  // The page reads from the latest back, strictly by the clock: what a request came to sits above the things
  // that happened in it, and the request itself below them, where it began. What has no time keeps its order.
  entries.sort((a, b) => (a.at && b.at ? a.at - b.at : 0) || a.rank - b.rank || a.seq - b.seq)
  entries.reverse()

  const total = entries.length
  const [size, step] = look.mode === 'outputs' || look.mode === 'sent' ? [PAGE_OUTPUTS, PAGE_OUTPUTS] : [PAGE_LINES, PAGE_STEP]
  const start = Math.min(Math.max(0, look.page) * step, Math.max(0, total - 1))
  const shown = entries.slice(start, start + size)
  const times = shown.map(entry => entry.at)
  const [from, to] = [Math.min(...times), Math.max(...times)]
  const within = shown.length > 0 ? trail.items.filter(item => item.at >= from && item.at <= to) : []
  // Among the outputs every one on the page is drawn: seeing them is what the view is for.
  const drawn = look.mode === 'outputs' || look.mode === 'sent' ? new Set(within.map(item => item.id)) : drawnPictures(within, look.picked.id)

  const rows: Row[] = []
  // What waits on the person has a view of its own, there only while something waits: it is to be answered, not read past.
  if (look.mode === 'questions') {
    for (const question of [...trail.questions].reverse()) {
      if (question.answer !== undefined) continue
      rows.push({
        kind: 'question',
        key: 'q:' + question.id,
        question,
        time: timeOf(question.at),
        lines: wrap(question.text, width, 8),
        ...(question.shot?.file ? { picture: pictureOf(question.shot, width, question.text) } : {}),
      })
    }
  }
  let day = ''
  for (const entry of shown) {
    const today = dayOf(entry.at, look.zone)
    if (entry.at > 0 && today !== day) {
      day = today
      rows.push({ kind: 'day', key: 'day:' + entry.seq, text: today })
    }
    rows.push(entry.row(drawn))
  }

  return { rows, earlier: Math.max(0, total - start - shown.length), later: start, foot: footOf(trail, look) }
}
