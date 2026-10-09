// The feed's updates: the steps of the work, put to a model as a log divided into stretches, and its reply
// read back as one short account of each stretch, the way a match is told as it goes. Pure: the model call is
// the hooks module's; this makes the prompt and reads the answer.

import type { Beat, Item, Trail } from '../types'
import { clean, clip, MAX_BEATS, waitsOf, workCount, workLine } from './trail.ts'

/** Steps to write updates for. */
export type Job = {
  /** The steps it covers, which are marked once the updates are in. */
  ids: string[]
  /** The log's numbered stretches, by number: each the step its update is tied to, the last of the stretch. */
  slots: Item[]
  /** The log, when a model is to read it. */
  prompt: string
  /** The updates, when the work is too slight to need a model: an exchange with no work in it. */
  local?: Beat[]
  /** The log runs to the latest of the session: only then does it show what is left waiting on the person. */
  isLatest: boolean
  /** The things still waiting on the person that the log names, in the order it marks them w1, w2 and so on. */
  open: string[]
}

/** Characters of log put to the model at once. */
const LOG_MAX = 9000
/** Characters of the newest turns told again when the person asks for the transcript to be read back: under one log's worth. */
const RETOLD_MAX = 6000
/** Steps to a stretch: each stretch is told in one update, so this is how often a long run is told of. */
const STRETCH_STEPS = 4
/** Big tasks one reply may name: more than a few is a list of steps, not of tasks. */
const TASKS_MOST = 4
const UPDATE_MAX = 420
const TASK_MAX = 110
/** Things one reply may leave waiting on the person, the length of each, and how many still waiting are put to the model. */
const WAITS_MOST = 3
const WAIT_MAX = 200
const OPEN_MOST = 8
const STILL_WAITING = 'STILL WAITING ON THE PERSON FROM BEFORE THIS LOG:'
/** What in an answer with no work in it says something may be left with the person: it is then put to a model like any other. */
const LEFT_WITH_THEM = /\?|\b(?:waits?|waiting|blocked) on you\b|\bneeds? you(?:r)?\b|\byou(?:'ll| will)? (?:need|have) to\b|\b(?:once|until|after) you\b|\byour (?:call|go-ahead|approval|answer|decision|choice|pick|sign-off)\b|\blet me know\b|\bconfirm\b/i

export const SYSTEM = [
  'You write the live activity feed of a coding session between a person and Claude, an AI coding agent: short updates, like the running commentary of a match, that let the person follow what happened without reading the conversation.',
  '',
  'You are given a log of part of the session: what the person asked, then what Claude said and did, divided into numbered stretches marked [1], [2] and so on.',
  'Write one update for each stretch: one to three plain sentences, at most forty words, saying what was done in it and what came of it. Short is the point: the person should take each one in at a glance.',
  'Tell it as it happened, in the past tense, concrete and specific: the name of the thing, the number, the outcome. In the first stretch of a request, begin from what was asked. Where a stretch ends a request, end with how things stand and anything now waiting on the person.',
  'Write to the person: call them "you" and the agent "Claude".',
  'Leave out the routine: reading files, re-running commands, what will be done next. No filler, no praise, no headings, no lists.',
  'Report only what the log shows Claude did, found or asked. What the person asked for is there so you know what the work was for: never report it as done unless the log shows it.',
  '',
  'Reply with one line per stretch:',
  'N|update',
  'where N is the number of the stretch.',
  '',
  'Then, only if the log shows a big task brought to a finish, add one line for each such task:',
  'done|N|what was finished, in at most ten words',
  'where N is the stretch in which it was finished. A big task is a whole piece of work completed: a feature built and working, a problem found and fixed, a round of review applied, something handed over. Steps on the way, partial progress, plans and answers to questions are not big tasks, and most logs have none. Name the thing itself ("Trail mod built and passing its tests"), not the effort.',
  '',
  'Then, only if the end of the log leaves something waiting on the person, add one line for each such thing:',
  'wait|N|what they are to do, in at most twenty words',
  'where N is the stretch that left it waiting. Something waits on the person when a piece of the work cannot go on, or cannot be finished, until they act: a command only they can run, a sign-in or a permission, an approval, a choice or a question Claude put to them, something to try and report back on. Begin with the verb and say what it unblocks ("Run `gh auth refresh -s workflow` so the packaging branch can be pushed"). An offer of more work, a suggestion, and anything Claude will do by itself are not waiting on them, and most logs leave nothing waiting.',
  'The log may open with things still waiting on the person from before, marked w1, w2 and so on. Never write a wait line for one of those again. If the log shows that one of them was done or answered, or no longer matters, add a line:',
  'clear|w1',
  'with its mark.',
  'Write nothing else.',
].join('\n')

const bearing = (item: Item): boolean => item.kind === 'ask' || item.kind === 'step' || item.kind === 'done'
const isStep = (item: Item): boolean => item.kind === 'step' || item.kind === 'done'

const beatAt = (item: Item, text: string): Beat => ({
  id: 'b:' + item.id,
  ref: item.id,
  turn: item.turn,
  at: item.at,
  kind: 'summary',
  title: clip(clean(text), UPDATE_MAX),
  detail: '',
  anchor: item.anchor,
  ...(item.alt ? { alt: item.alt } : {}),
})

/** Work too slight to need a model: something asked and answered with nothing done, or a command nothing followed. */
const slight = (items: Item[]): Beat[] | undefined => {
  const steps = items.filter(isStep)
  const worked = items.some(item => item.work !== undefined && workCount(item.work) > 0) || items.some(item => item.kind === 'shot')
  if (worked || steps.length > 1) return undefined
  const [answer] = steps
  // An answer that may leave something with the person is read by a model, which says what waits on them.
  if (answer && LEFT_WITH_THEM.test(answer.more ?? answer.line)) return undefined
  // The answer is the whole of what happened: its start is the update.
  return answer ? [beatAt(answer, answer.more ?? answer.line)] : []
}

/** A turn's steps as stretches, each to be told in one update; a lone last step joins the stretch before it. */
const stretchesOf = (items: Item[]): Item[][] => {
  const parts: Item[][] = [[]]
  let steps = 0
  for (const item of items) {
    if (isStep(item) && steps >= STRETCH_STEPS) {
      parts.push([])
      steps = 0
    }
    parts[parts.length - 1]!.push(item)
    if (isStep(item)) steps++
  }
  const last = parts[parts.length - 1]!
  if (parts.length > 1 && last.filter(isStep).length < 2) parts.splice(parts.length - 2, 2, [...parts[parts.length - 2]!, ...last])
  return parts.filter(part => part.length > 0)
}

const entryText = (item: Item, isLast: boolean): string => {
  const did = item.work && workCount(item.work) > 0 ? ` [did: ${[...item.work.notes, workLine(item.work)].join('; ')}]` : ''
  if (item.kind === 'shot') return `looked at a picture: ${item.line}`
  if (item.kind === 'ask') return `(before saying anything)${did}`
  const said = item.more ?? item.line
  return `${item.kind === 'done' && isLast ? 'final answer' : 'said'}: ${said}${did}`
}

const logOf = (turns: Item[][]): { prompt: string; slots: Item[] } => {
  const slots: Item[] = []
  const lines: string[] = []
  for (const items of turns) {
    const ask = items.find(item => item.kind === 'ask')
    if (lines.length > 0) lines.push('')
    // A request whose first stretch is told already is there for what the work is about, not to be told again.
    lines.push(ask?.fed ? 'EARLIER THE PERSON ASKED (already told of: do not repeat it):' : lines.length === 0 ? 'THE PERSON ASKED:' : 'THEN THE PERSON ASKED:')
    lines.push(ask ? (ask.more ?? ask.line) : '(the work carried on from before)')
    lines.push(ask?.fed ? 'CLAUDE WENT ON:' : 'CLAUDE:')
    const shown = items.filter(item => bearing(item) || item.kind === 'shot').filter(item => item.kind !== 'ask' || (item.work !== undefined && workCount(item.work) > 0))
    for (const stretch of stretchesOf(shown)) {
      slots.push([...stretch].reverse().find(bearing) ?? stretch[stretch.length - 1]!)
      lines.push(`[${slots.length}]`)
      for (const item of stretch) lines.push(entryText(item, item === shown[shown.length - 1]))
    }
  }
  return { prompt: lines.join('\n'), slots }
}

/**
 * The next steps worth writing updates for, newest first so what the person
 * sees on opening the pane is written before the history behind it: the
 * steps of a finished turn not yet told, or of a running one once a stretch
 * of them is there. Finished turns with little in them are taken together.
 */
export const nextJob = (trail: Trail, skipped: ReadonlySet<string> = new Set()): Job | null => {
  const byTurn = new Map<number, Item[]>()
  for (const item of trail.items) {
    if (item.kind === 'recap' || item.kind === 'compact') continue
    byTurn.set(item.turn, [...(byTurn.get(item.turn) ?? []), item])
  }
  const waiting: Item[][] = []
  for (const turn of [...byTurn.keys()].sort((a, b) => b - a)) {
    const items = byTurn.get(turn)!
    const isRunning = trail.isOpen && turn === trail.turn
    // The newest step of a running turn is still gathering its work; the rest can be told.
    const lastBearer = [...items].reverse().find(bearing)
    const open = items.filter(item => !item.fed && !skipped.has(item.id) && (!isRunning || item !== lastBearer))
    const fresh = open.filter(item => bearing(item) || item.kind === 'shot')
    if (fresh.filter(bearing).length === 0) continue
    if (isRunning && fresh.filter(isStep).length < STRETCH_STEPS) continue
    const stretch = [...(open.some(item => item.kind === 'ask') ? [] : items.filter(item => item.kind === 'ask')), ...open]
    if (waiting.length > 0 && logOf([...waiting, stretch]).prompt.length > LOG_MAX) break
    waiting.push(stretch)
    if (isRunning) break
  }
  if (waiting.length === 0) return null

  // Oldest first in the log, as it happened.
  waiting.reverse()
  const ids = waiting.flat().map(item => item.id)
  // Only a log that runs to the latest shows how things now stand: what is left with the person, and what no
  // longer is. One with something already told after it is history being caught up on.
  const last = Math.max(...waiting.flat().map(item => item.turn))
  const isLatest = !trail.items.some(item => item.turn > last && item.fed)
  const open = isLatest ? waitsOf(trail).slice(-OPEN_MOST) : []
  // While something waits on the person every exchange is read by a model: any of them may be where it was done.
  const isSlight = (items: Item[]): Beat[] | undefined => (open.length > 0 ? undefined : slight(items))
  const told = waiting.filter(items => isSlight(items) === undefined)
  const local = waiting.flatMap(items => isSlight(items) ?? [])
  if (told.length === 0) return { ids, slots: [], prompt: '', local, isLatest, open: [] }
  const { prompt, slots } = logOf(told)
  const still = open.length > 0 ? [STILL_WAITING, ...open.map((beat, index) => `w${index + 1}: ${beat.title}`), '', ''].join('\n') : ''
  return { ids, slots, prompt: still + clip(prompt, LOG_MAX * 2), ...(local.length > 0 ? { local } : {}), isLatest, open: open.map(beat => beat.id) }
}

/** The model's reply as updates: each line it wrote in the form asked for, tied to the last step of the stretch it numbers. */
export const parseBeats = (reply: string, job: Job): Beat[] => {
  const beats: Beat[] = []
  const told = new Set<number>()
  let tasks = 0
  let waits = 0
  for (const raw of reply.split('\n')) {
    // Something left waiting on the person: tied to the stretch that left it, and listed apart until it is done.
    const wait = /^\s*[-*]?\s*wait\s*\|\s*\[?(\d+)\]?\s*\|\s*(.+?)\s*$/i.exec(raw)
    if (wait) {
      const left = job.slots[Number(wait[1]) - 1]
      const what = clip(clean(wait[2]!), WAIT_MAX)
      if (left && what.length >= 4 && waits < WAITS_MOST) beats.push({ ...beatAt(left, what), id: `w:${left.id}:${waits++}`, kind: 'waiting' })
      continue
    }
    if (/^\s*[-*]?\s*clear\s*\|/i.test(raw)) continue
    // A big task finished: tied to the stretch it was finished in, and listed apart from the updates.
    const done = /^\s*[-*]?\s*done\s*\|\s*\[?(\d+)\]?\s*\|\s*(.+?)\s*$/i.exec(raw)
    const where = done ? job.slots[Number(done[1]) - 1] : undefined
    if (done && where && tasks < TASKS_MOST) {
      const title = clip(clean(done[2]!).replace(/[.;,]+$/, ''), TASK_MAX)
      if (title) beats.push({ ...beatAt(where, title), id: `d:${where.id}:${tasks++}`, kind: 'built' })
      continue
    }
    const found = /^\s*[-*]?\s*\[?(\d+)\]?\s*\|\s*(.+?)\s*$/.exec(raw)
    if (!found) continue
    const slot = Number(found[1])
    const at = job.slots[slot - 1]
    const text = clean(found[2]!)
    // One update to a stretch; a number that names none, or a line left empty, says nothing.
    if (!at || told.has(slot) || text.length < 4) continue
    told.add(slot)
    beats.push(beatAt(at, text))
  }
  return beats
}

/** The things still waiting on the person that the model's reply says no longer are: done, answered, or not needed now. */
export const parseCleared = (reply: string, job: Job): string[] => {
  const cleared = new Set<string>()
  for (const raw of reply.split('\n')) {
    const found = /^\s*[-*]?\s*clear\s*\|\s*\[?w?(\d+)\]?\s*$/i.exec(raw)
    const id = found ? job.open[Number(found[1]) - 1] : undefined
    if (id) cleared.add(id)
  }
  return [...cleared]
}

const sameWords = (a: string, b: string): boolean => a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * The trail with the updates in, the steps they tell of marked as told and relieved of what was kept only for
 * the telling. What the reply left waiting on the person is taken only from a log that ran to the latest (an
 * older stretch's is long since dealt with), and what it cleared stops waiting as of the log's last step.
 */
export const feedIn = (trail: Trail, job: Job, beats: Beat[], cleared: string[] = []): Trail => {
  const covered = new Set(job.ids)
  const known = new Set(trail.feed.map(beat => beat.id))
  const over = new Set(cleared)
  const overAt = job.slots.reduce((latest, slot) => Math.max(latest, slot.at), 0)
  const had = trail.feed.map(beat => (over.has(beat.id) && beat.over === undefined ? { ...beat, over: overAt } : beat))
  const stillOpen = had.filter(beat => beat.kind === 'waiting' && beat.over === undefined)
  const fresh = [...(job.local ?? []), ...beats].filter(beat => !known.has(beat.id) && (beat.kind !== 'waiting' || (job.isLatest && !stillOpen.some(other => sameWords(other.title, beat.title)))))
  const feed = [...had, ...fresh].sort((a, b) => a.turn - b.turn || a.at - b.at)
  return {
    ...trail,
    feed: feed.slice(-MAX_BEATS),
    items: trail.items.map(item => {
      if (!covered.has(item.id)) return item
      // What was kept only for the telling is let go; a request keeps its words, which are the person's to read back.
      const { more, ...told } = item
      return { ...told, ...(item.kind === 'ask' && more ? { more } : {}), fed: true as const, ...(told.work ? { work: { ...told.work, notes: [] } } : {}) }
    }),
  }
}

/**
 * A trail read back from its transcript, with what only the mod knew kept:
 * the updates already written for it (nothing is told twice), the captions
 * of its pictures and the answers given to its questions. Asked to tell the
 * latest again, it leaves the newest turns that fit one log untold: their
 * updates stand, and the model reads them once more for what they left
 * waiting on the person.
 */
export const adopt = (built: Trail, had: Trail, isRetelling = false): Trail => {
  const again = new Set<number>()
  if (isRetelling) {
    let room = RETOLD_MAX
    for (const turn of [...new Set(built.items.map(item => item.turn))].sort((a, b) => b - a)) {
      if (built.isOpen && turn === built.turn) continue
      room -= built.items.filter(item => item.turn === turn).reduce((sum, item) => sum + (item.more ?? item.line).length + 60, 0)
      if (room < 0 && again.size > 0) break
      again.add(turn)
    }
  }
  const told = new Set(had.items.filter(item => item.fed).map(item => item.id))
  for (const item of built.items) if (again.has(item.turn)) told.delete(item.id)
  const notes = new Map(had.items.flatMap(item => (item.shot?.note === undefined ? [] : [[item.id, item.shot.note] as const])))
  const turnOf = new Map(built.items.map(item => [item.id, item.turn]))
  const asked = new Map(had.questions.map(question => [question.id, question]))
  return {
    ...built,
    // An update keeps to the step it was tied to, wherever that step's turn now counts from.
    feed: had.feed.map(beat => ({ ...beat, turn: turnOf.get(beat.ref) ?? beat.turn })),
    questions: [...built.questions.map(question => asked.get(question.id) ?? question), ...had.questions.filter(question => !built.questions.some(other => other.id === question.id))].sort((a, b) => a.at - b.at),
    items: built.items.map(found => {
      const note = notes.get(found.id)
      const item = note !== undefined && found.shot ? { ...found, shot: { ...found.shot, note } } : found
      if (!told.has(item.id)) return item
      const { more, ...kept } = item
      return { ...kept, ...(item.kind === 'ask' && more ? { more } : {}), fed: true as const }
    }),
  }
}
