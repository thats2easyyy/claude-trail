// The trail's steps: conversation events in, a list of what happened out.
// Pure (no `$`, no Node, no DOM), so the hooks, the tests and the rebuild tool share it.

import type { Beat, Item, ItemKind, OutputType, Question, Shot, Source, Trail, Work } from '../types'

export type TrailEvent =
  | { t: 'prompt'; id: string; at: number; text: string; isCommand?: boolean }
  | { t: 'say'; id: string; at: number; text: string }
  | { t: 'tool'; id: string; at: number; tool: string; note: string; file?: string }
  | { t: 'fail'; id: string; at: number }
  | { t: 'shot'; id: string; at: number; anchor: string; file: string; w: number; h: number; label: string; full?: string; type?: OutputType; from?: Source; note?: string }
  | { t: 'recap'; id: string; at: number; text: string }
  | { t: 'compact'; id: string; at: number }
  | { t: 'question'; id: string; at: number; text: string; options: string[]; shot?: Shot }
  | { t: 'answer'; id: string; at: number; text: string }
  | { t: 'caption'; id: string; at: number; text: string }
  | { t: 'end'; at: number; aborted?: boolean }

export const MAX_ITEMS = 400
export const MAX_BEATS = 300
const MAX_QUESTIONS = 40
const QUESTION_MAX = 400
const OPTIONS_MOST = 4
const OPTION_MAX = 28
/** What a question the conversation went on past is taken to have been answered with. */
export const ANSWERED_THERE = 'answered in the conversation'
const FILES_KEPT = 3
const EXTRA_KEPT = 24
const NOTES_KEPT = 8
const RECENT_KEPT = 60
const LINE_MAX = 200
const RECAP_MAX = 600
const NOTE_MAX = 320
/** How much of what was said is kept for a highlight to be written from: all of an answer, the start of a step. */
const ANSWER_MAX = 1600
/** Of an answer longer than that, how much is its end: where it says how things stand and what waits on the person. */
const ANSWER_END = 600
const STEP_MAX = 320
const SENTENCE_MIN = 32
/** A line this long before a list or a break stands on its own. */
const LEAD_MIN = 20
const CARRIED_ON = 'Carried on without a new prompt'
const TASK = 'Background task: '

/** How an answer given in the pane reads when it reaches the conversation, and how it is known again in a transcript. */
export const paneAnswer = (question: string, answer: string): string => `About your question in the Trail pane ("${question}"): ${answer}`
const PANE_ANSWER = /^About your question in the Trail pane \("[\s\S]*?"\): ([\s\S]+)$/

export const emptyTrail = (): Trail => ({ items: [], feed: [], questions: [], turn: 0, isOpen: false, isFresh: false, lastTool: '', lastAt: 0, recent: [], sought: true })

const emptyWork = (): Work => ({ cmds: 0, reads: 0, edits: 0, agents: 0, other: 0, fails: 0, files: [], moreFiles: 0, extra: [], now: '', notes: [] })

const READS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch'])
const EDITS = new Set(['Write', 'Edit', 'NotebookEdit'])
const AGENTS = new Set(['Agent', 'Task', 'Workflow'])

/** A short name for a long string, the same wherever it is worked out: what a file made from a path is called by. */
export const tag = (text: string): string => {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36)
}

const MOVING = /\.(mp4|mov|m4v|webm|mkv|gif)$/i
const STILL = /\.(png|jpe?g|webp|heic|tiff?|bmp)$/i

/** A file last written this long before a session's first event was there before it: looked at, not made. */
const EARLIER_MS = 60_000

/** Whether a file Claude opened is from before the session, given when it was last written and when the session began. */
export const isEarlier = (writtenAt: number, beganAt: number): boolean => beganAt > 0 && writtenAt > 0 && writtenAt < beganAt - EARLIER_MS

/**
 * Whether a picture of the trail is Claude's own output: something the
 * session made, sent or published, and not one the person pasted or a file
 * from before the session that Claude only looked at.
 */
export const isOwnOutput = (item: Item, trail: Trail): boolean =>
  item.kind === 'shot' && item.shot?.from === undefined && !trail.items.some(other => other.kind === 'ask' && other.id === item.anchor)

/** The things the work left for the person to do that they have not done yet, oldest first. */
export const waitsOf = (trail: Trail): Beat[] => trail.feed.filter(beat => beat.kind === 'waiting' && beat.over === undefined)

/** How many things wait on the person: questions put to them in the pane, and what the work left for them to do. */
export const waitingCount = (trail: Trail): number => trail.questions.filter(question => question.answer === undefined).length + waitsOf(trail).length

/** How a file Claude handed the person is named in the trail. */
export const SENT = 'Sent you '

/**
 * Whether an entry is something Claude gave the person: a file it sent them,
 * or a page it published. These are what a conversation says "I sent you"
 * about, and what a terminal does not show.
 */
export const isSent = (item: Item): boolean => item.kind === 'shot' && (item.line.startsWith(SENT) || item.shot?.type === 'link')

/** What kind of output a file is, by its name. */
export const outputType = (path: string): OutputType => (MOVING.test(path) ? 'video' : STILL.test(path) ? 'image' : 'file')

/**
 * The video files a command names, in what it ran and what it printed: what
 * rendering or recording leaves behind and nobody opens with a tool. Paths
 * as written, a few at most; whether each is a file just made is the caller's
 * to find out.
 */
export const videosNamed = (text: string): string[] => {
  const found = new Set<string>()
  for (const match of text.matchAll(/(?:^|[\s'"=(:])((?:~\/|\.{0,2}\/)?[\w@%+,.\-\/]+\.(?:mp4|mov|m4v|webm|mkv|gif))(?=$|[\s'"),;:])/gim)) {
    found.add(match[1]!)
    if (found.size >= 5) break
  }
  return [...found]
}

/** The address a page was published at, in what the tool that published it answered. */
export const publishedAt = (text: string): string | undefined => /\bPublished\b[^\n]*?\bat (https:\/\/[^\s)]+)/.exec(text)?.[1]

export const basename = (path: string): string => {
  const cut = path.replace(/\/+$/, '')
  return cut.slice(cut.lastIndexOf('/') + 1)
}

const span = (from: number, to: number): string => String.fromCharCode(from) + '-' + String.fromCharCode(to)
/** Control characters and the marks that turn text around or hide in it: one of them in a tree refuses the whole pane. */
const UNSEEN = new RegExp('[' + span(0, 0x1f) + span(0x7f, 0x9f) + span(0x200b, 0x200f) + span(0x2028, 0x202e) + String.fromCharCode(0xfeff) + ']', 'g')

/** One line of plain characters. */
export const clean = (text: string): string => text.replace(UNSEEN, ' ').replace(/\s+/g, ' ').trim()

/** Cut by characters, never through one, at a word where there is one near. */
export const clip = (text: string, max: number): string => {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  const cut = chars.slice(0, max - 1).join('')
  const space = cut.lastIndexOf(' ')
  return (space > cut.length * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '') + '…'
}

const plain = (text: string): string =>
  clean(
    text
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1'),
  )

/** What is kept of an answer: all of it, or of a long one its start and its end, the middle left out. */
const headAndEnd = (flat: string): string => {
  const chars = Array.from(flat)
  if (chars.length <= ANSWER_MAX) return flat
  const end = chars.slice(-ANSWER_END).join('')
  return clip(flat, ANSWER_MAX - ANSWER_END) + ' ' + end.slice(end.indexOf(' ') + 1)
}

/** Where the first sentence of a plain line ends; a very short one takes the next along. */
const sentenceEnd = (flat: string): number => {
  const stop = /[.!?:](?=\s+[A-Z"'`(\[]|$)/g
  for (let match = stop.exec(flat); match; match = stop.exec(flat)) {
    const isLast = match.index + 1 >= flat.length
    if (!isLast && (match[0] === ':' || match.index + 1 < SENTENCE_MIN)) continue
    return match.index + 1
  }
  return flat.length
}

/** A line that leads into a list or a new paragraph says its piece alone: the first item is not the rest of its sentence. */
const lead = (text: string): string => {
  const cut = /\n(?=\s*\n|\s{0,3}(?:[-*+]|\d+\.)\s)/.exec(text)
  return cut && plain(text.slice(0, cut.index)).length >= LEAD_MIN ? text.slice(0, cut.index) : text
}

/** The first sentence of what the model said, as one plain line. */
export const firstSentence = (text: string): string => {
  const flat = plain(lead(text))
  return clip(flat.slice(0, sentenceEnd(flat)), LINE_MAX)
}

const TAGGED = /<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|command-message|skill-format|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g
const INTERRUPTED = /^\s*\[Request interrupted by user/

/** The person's prompt as one plain line; empty for rows that are not a prompt at all. */
export const promptLine = (text: string, max = LINE_MAX): string => {
  const command = /<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/.exec(text)
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)
    const name = command[1]!.startsWith('/') ? command[1]! : '/' + command[1]!
    return clip(clean(name + ' ' + (args?.[1] ?? '')), max)
  }
  const task = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/.exec(text)
  const summary = task && /<summary>([\s\S]*?)<\/summary>/.exec(task[1]!)
  if (summary) {
    // How the task came out is what matters about it: said first, where no clip takes it.
    const said = clean(summary[1]!)
    const status = clean(/<status>([\s\S]*?)<\/status>/.exec(task![1]!)?.[1] ?? '')
    return clip((status && !said.toLowerCase().includes(status.toLowerCase()) ? `Background task ${status}: ` : TASK) + said, max)
  }
  // The engine's own mark for a turn the person stopped is no prompt of theirs.
  if (INTERRUPTED.test(text)) return ''
  const shell = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)
  if (shell) return clip(clean('! ' + shell[1]!), max)
  const said = text
    .replace(TAGGED, ' ')
    .replace(/<\/?pasted_content[^>]*>/g, ' ')
    .replace(/\[Image(?: #\d+|: source: [^\]]*)\]/g, ' ')
  return clip(clean(said), max)
}

/** One short phrase for a tool call, from its own arguments. */
export const toolNote = (tool: string, input: Record<string, unknown>): string => {
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const note =
    text('description') ||
    (text('file_path') && basename(text('file_path'))) ||
    text('skill') ||
    text('query') ||
    text('url') ||
    text('pattern') ||
    text('command') ||
    text('name')
  const short = tool.startsWith('mcp__') ? tool.split('__').slice(2).join(' ') || tool : tool
  return clip(clean(note || short), 80)
}

export const workCount = (work: Work): number => work.cmds + work.reads + work.edits + work.agents + work.other

const tally = (work: Work, tool: string, note: string, file?: string): Work => {
  const next = { ...work, now: note }
  // A call that says what it is for is what a highlight is written from; a bare file name says little.
  const isTelling = note !== '' && (tool === 'Bash' || AGENTS.has(tool) || tool.startsWith('mcp__') || tool === 'Skill' || tool === 'WebSearch')
  if (isTelling && next.notes.length < NOTES_KEPT && !next.notes.includes(note)) next.notes = [...next.notes, note]
  if (tool === 'Bash') next.cmds++
  else if (READS.has(tool)) next.reads++
  else if (EDITS.has(tool)) {
    next.edits++
    const name = file ? clean(basename(file)) : ''
    if (name && !next.files.includes(name) && !next.extra.includes(name)) {
      if (next.files.length < FILES_KEPT) next.files = [...next.files, name]
      else {
        next.moreFiles++
        if (next.extra.length < EXTRA_KEPT) next.extra = [...next.extra, name]
      }
    }
  } else if (AGENTS.has(tool)) next.agents++
  else next.other++
  return next
}

const merge = (into: Work, from: Work): Work => {
  const files = [...into.files]
  const extra = [...into.extra]
  let moreFiles = into.moreFiles
  for (const name of [...from.files, ...from.extra]) {
    if (files.includes(name) || extra.includes(name)) continue
    if (files.length < FILES_KEPT) files.push(name)
    else {
      moreFiles++
      if (extra.length < EXTRA_KEPT) extra.push(name)
    }
  }
  // Names past what either kept are counted, though not known.
  moreFiles += Math.max(0, from.moreFiles - from.extra.length)
  return {
    cmds: into.cmds + from.cmds,
    reads: into.reads + from.reads,
    edits: into.edits + from.edits,
    agents: into.agents + from.agents,
    other: into.other + from.other,
    fails: into.fails + from.fails,
    files,
    moreFiles,
    extra,
    now: from.now || into.now,
    notes: [...into.notes, ...from.notes.filter(note => !into.notes.includes(note))].slice(0, NOTES_KEPT),
  }
}

export const change = (items: Item[], index: number, to: (item: Item) => Item): Item[] => {
  const next = items.slice()
  next[index] = to(next[index]!)
  return next
}

const withKind = (items: Item[], index: number, kind: ItemKind): Item[] => change(items, index, item => ({ ...item, kind }))

/** The line of the turn that tool calls count under: its newest ask, step or result. */
const bearerOf = (items: Item[], turn: number, before = items.length): number => {
  for (let i = before - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'recap' || item.kind === 'compact' || item.kind === 'shot') continue
    return item.turn === turn ? i : -1
  }
  return -1
}

/**
 * Keeps the list bounded. Steps go first, their work kept under the line
 * before them: those of older turns, then the oldest of the running turn. A
 * turn never loses its ask, result or pictures that way; only when nothing
 * but those is left do whole turns go, oldest first.
 */
const thin = (items: Item[]): Item[] => {
  if (items.length <= MAX_ITEMS) return items
  const out = items.slice()
  let over = out.length - MAX_ITEMS
  const newest = out[out.length - 1]!.turn
  for (const ofNewest of [false, true]) {
    for (let i = 0; i < out.length - 1 && over > 0; i++) {
      const item = out[i]!
      if (item.kind !== 'step' || (item.turn === newest) !== ofNewest) continue
      const bearer = bearerOf(out, item.turn, i)
      if (bearer < 0) continue
      if (item.work) out[bearer] = { ...out[bearer]!, work: merge(out[bearer]!.work ?? emptyWork(), item.work) }
      out.splice(i, 1)
      i--
      over--
    }
  }
  if (over <= 0) return out
  let cut = over
  while (cut < out.length - 1 && out[cut]!.turn === out[cut - 1]!.turn) cut++
  return out.slice(cut)
}

const has = (trail: Trail, id: string): boolean => trail.items.some(item => item.id === id)

/** A turn to put work under: the one running, the newest ask's if it has not ended, else one nobody asked for. */
const reopen = (trail: Trail, id: string, at: number): Trail => {
  if (trail.isOpen) return trail
  if (trail.isFresh) return { ...trail, isOpen: true }
  const turn = trail.turn + 1
  const ask: Item = { id: id + ':turn', anchor: id, kind: 'ask', at, turn, line: CARRIED_ON }
  return { ...trail, items: [...trail.items, ask], turn, isOpen: true, isFresh: true }
}

const seenOnce = (trail: Trail, key: string): Trail | null =>
  trail.recent.includes(key) ? null : { ...trail, recent: [...trail.recent, key].slice(-RECENT_KEPT) }

/** Folds one thing that happened into the trail. */
export const add = (trail: Trail, event: TrailEvent): Trail => {
  const next = fold(trail, event)
  // A caption is written after the fact: it is no sign of when the work last moved.
  return event.t !== 'caption' && event.at > next.lastAt ? { ...next, lastAt: event.at } : next
}

const fold = (trail: Trail, event: TrailEvent): Trail => {
  switch (event.t) {
    case 'prompt': {
      if (has(trail, event.id)) return trail
      const line = promptLine(event.text)
      if (!line) return trail
      // A command typed while a turn runs is beside the point of that turn: it neither ends it nor heads the work after.
      if (event.isCommand && trail.isOpen) return trail
      // A turn never seen to end stopped when it last did something, not when the person next spoke, and with no result.
      const closed = trail.isOpen ? fold(trail, { t: 'end', at: trail.lastAt || event.at, aborted: true }) : trail
      const turn = closed.turn + 1
      const ask: Item = { id: event.id, anchor: event.id, kind: 'ask', at: event.at, turn, line }
      const whole = promptLine(event.text, ANSWER_MAX)
      if (whole.length > line.length) ask.more = whole
      // Whatever the person says next is taken as their answer to what was waiting on them: said in the pane, it
      // names the question; said in the conversation, the conversation has it.
      const isTheirs = event.isCommand !== true && !/^Background task\b/.test(line)
      const given = PANE_ANSWER.exec(whole)?.[1]
      const questions = isTheirs
        ? closed.questions.map(question => (question.answer === undefined ? { ...question, answer: clip(given ?? ANSWERED_THERE, QUESTION_MAX), answeredAt: event.at } : question))
        : closed.questions
      return { ...closed, items: thin([...closed.items, ask]), questions, turn, isOpen: event.isCommand !== true, isFresh: true }
    }
    case 'say': {
      if (has(trail, event.id)) return trail
      const flat = plain(event.text)
      const line = clip(flat.slice(0, sentenceEnd(flat)), LINE_MAX)
      if (!line) return trail
      const base = reopen(trail, event.id, event.at)
      // What was said before this turned out not to be the turn's answer: its start is enough to keep.
      const before = bearerOf(base.items, base.turn)
      const items =
        before >= 0 && base.items[before]!.kind === 'step' && (base.items[before]!.more?.length ?? 0) > STEP_MAX
          ? change(base.items, before, item => ({ ...item, more: clip(item.more ?? '', STEP_MAX) }))
          : base.items
      const step: Item = { id: event.id, anchor: event.id, kind: 'step', at: event.at, turn: base.turn, line }
      if (flat.length > line.length) step.more = headAndEnd(flat)
      if (base.lastTool) step.alt = base.lastTool
      return { ...base, items: thin([...items, step]) }
    }
    case 'tool': {
      const counted = seenOnce(trail, event.id)
      if (!counted) return trail
      const base = { ...reopen(counted, event.id, event.at), lastTool: event.id }
      const bearer = bearerOf(base.items, base.turn)
      if (bearer < 0) return base
      const items = base.items[bearer]!.kind === 'done' ? withKind(base.items, bearer, 'step') : base.items
      return {
        ...base,
        items: change(items, bearer, item => ({
          ...item,
          // The row a line stands for may not scroll; the first call made under it is beside it and does.
          alt: item.work && workCount(item.work) > 0 ? item.alt : event.id,
          work: tally(item.work ?? emptyWork(), event.tool, event.note, event.file),
        })),
      }
    }
    case 'fail': {
      const counted = seenOnce(trail, 'fail:' + event.id)
      if (!counted) return trail
      const bearer = bearerOf(counted.items, counted.turn)
      if (bearer < 0) return counted
      return { ...counted, items: change(counted.items, bearer, item => ({ ...item, work: { ...(item.work ?? emptyWork()), fails: (item.work?.fails ?? 0) + 1 } })) }
    }
    case 'shot': {
      const id = event.id + ':shot'
      if (has(trail, id)) return trail
      const base = reopen(trail, event.id, event.at)
      const shot: Item = {
        id,
        anchor: event.anchor,
        kind: 'shot',
        at: event.at,
        turn: base.turn,
        line: clip(clean(event.label), LINE_MAX),
        shot: { file: event.file, w: event.w, h: event.h },
      }
      if (event.full) shot.shot!.full = event.full
      if (event.type && event.type !== 'image') shot.shot!.type = event.type
      if (event.from) shot.shot!.from = event.from
      // What Claude said of a file as it handed it over is its caption from the start.
      if (event.note && clean(event.note)) shot.shot!.note = clip(clean(event.note), NOTE_MAX)
      return { ...base, items: thin([...base.items, shot]) }
    }
    case 'recap': {
      const line = clip(plain(event.text), RECAP_MAX)
      if (!line || has(trail, event.id)) return trail
      // Only where things stand now is worth its rows: a newer recap takes the older one's place.
      const recap: Item = { id: event.id, anchor: event.id, kind: 'recap', at: event.at, turn: trail.turn, line }
      return { ...trail, items: thin([...trail.items.filter(item => item.kind !== 'recap'), recap]) }
    }
    case 'compact': {
      if (has(trail, event.id) || trail.items[trail.items.length - 1]?.kind === 'compact') return trail
      const at: Item = { id: event.id, anchor: event.id, kind: 'compact', at: event.at, turn: trail.turn, line: 'Context was compacted here' }
      if (trail.lastTool) at.alt = trail.lastTool
      return { ...trail, items: thin([...trail.items, at]) }
    }
    case 'question': {
      const text = clip(clean(event.text), QUESTION_MAX)
      if (!text || trail.questions.some(question => question.id === event.id)) return trail
      const options = event.options.map(option => clip(clean(option), OPTION_MAX)).filter(Boolean).slice(0, OPTIONS_MOST)
      const question: Question = { id: event.id, at: event.at, text, options }
      if (event.shot) question.shot = event.shot
      return { ...trail, questions: [...trail.questions, question].slice(-MAX_QUESTIONS) }
    }
    case 'answer': {
      const text = clip(clean(event.text), QUESTION_MAX)
      const index = trail.questions.findIndex(question => question.id === event.id && question.answer === undefined)
      if (index < 0 || !text) return trail
      const questions = trail.questions.slice()
      questions[index] = { ...questions[index]!, answer: text, answeredAt: event.at }
      return { ...trail, questions }
    }
    case 'caption': {
      // `id` is the picture's own line; an empty caption still says the picture was asked about.
      const index = trail.items.findIndex(item => item.id === event.id && item.shot !== undefined)
      if (index < 0 || trail.items[index]!.shot!.note === event.text) return trail
      return { ...trail, items: change(trail.items, index, item => ({ ...item, shot: { ...item.shot!, note: event.text } })) }
    }
    case 'end': {
      if (!trail.isOpen) return trail.isFresh ? { ...trail, isFresh: false } : trail
      let items = trail.items
      const last = bearerOf(items, trail.turn)
      // What the model said last, with nothing done after it, is how the turn came out, unless it was cut short.
      if (!event.aborted && last >= 0 && items[last]!.kind === 'step' && workCount(items[last]!.work ?? emptyWork()) === 0) items = withKind(items, last, 'done')
      const ask = items.findIndex(item => item.turn === trail.turn && item.kind === 'ask')
      if (ask >= 0) items = change(items, ask, item => ({ ...item, ms: Math.max(0, event.at - item.at) }))
      return { ...trail, items, isOpen: false, isFresh: false }
    }
  }
}

const isQuestion = (question: unknown): question is Question =>
  typeof question === 'object' && question !== null && typeof (question as Question).id === 'string' && typeof (question as Question).text === 'string' && Array.isArray((question as Question).options)

const isBeat = (beat: unknown): beat is Beat =>
  typeof beat === 'object' && beat !== null && typeof (beat as Beat).id === 'string' && typeof (beat as Beat).title === 'string' && typeof (beat as Beat).anchor === 'string'

/** A trail read back from a file or the state, with anything missing made whole. */
export const mended = (value: unknown): Trail | null => {
  if (typeof value !== 'object' || value === null) return null
  const from = value as Partial<Trail>
  if (!Array.isArray(from.items)) return null
  const items = from.items
    .filter((item): item is Item => typeof item === 'object' && item !== null && typeof item.id === 'string' && typeof item.line === 'string' && typeof item.kind === 'string')
    .map(item => (item.work && (!Array.isArray(item.work.notes) || !Array.isArray(item.work.extra)) ? { ...item, work: { ...emptyWork(), ...item.work, notes: item.work.notes ?? [], extra: item.work.extra ?? [] } } : item))
  return {
    items,
    feed: Array.isArray(from.feed) ? from.feed.filter(isBeat) : [],
    questions: Array.isArray(from.questions) ? from.questions.filter(isQuestion) : [],
    turn: typeof from.turn === 'number' ? from.turn : 0,
    isOpen: from.isOpen === true,
    isFresh: from.isFresh === true,
    lastTool: typeof from.lastTool === 'string' ? from.lastTool : '',
    lastAt: typeof from.lastAt === 'number' ? from.lastAt : items.reduce((latest, item) => Math.max(latest, item.at), 0),
    recent: Array.isArray(from.recent) ? from.recent.filter((id): id is string => typeof id === 'string') : [],
    ...(from.sought === true ? { sought: true as const } : {}),
  }
}

/** "1 failed · 6 commands · edited draw.ts, png.ts +2" */
export const workLine = (work: Work): string => {
  const parts: string[] = []
  const count = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push(n + ' ' + (n === 1 ? one : many))
  }
  // What failed is said first: the line is clipped from its end, and that is the last thing to lose.
  count(work.fails, 'failed', 'failed')
  count(work.cmds, 'command', 'commands')
  if (work.files.length > 0) parts.push('edited ' + work.files.join(', ') + (work.moreFiles > 0 ? ' +' + work.moreFiles : ''))
  else count(work.edits, 'edit', 'edits')
  count(work.reads, 'read', 'reads')
  count(work.agents, 'agent run', 'agent runs')
  count(work.other, 'other call', 'other calls')
  return parts.join(' · ')
}
