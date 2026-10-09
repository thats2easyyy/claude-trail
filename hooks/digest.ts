// The feed's updates: the steps of the work, put to a model as a log divided into stretches, and its reply
// read back as one short account of each stretch, the way a match is told as it goes. Pure: the model call is
// the hooks module's; this makes the prompt and reads the answer.

import type { Beat, Item, Trail } from '../types'
import { clean, clip, MAX_BEATS, workCount, workLine } from './trail.ts'

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
}

/** Characters of log put to the model at once. */
const LOG_MAX = 9000
/** Steps to a stretch: each stretch is told in one update, so this is how often a long run is told of. */
const STRETCH_STEPS = 4
/** Big tasks one reply may name: more than a few is a list of steps, not of tasks. */
const TASKS_MOST = 4
const UPDATE_MAX = 420
const TASK_MAX = 110

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
  const told = waiting.filter(items => slight(items) === undefined)
  const local = waiting.flatMap(items => slight(items) ?? [])
  if (told.length === 0) return { ids, slots: [], prompt: '', local }
  const { prompt, slots } = logOf(told)
  return { ids, slots, prompt: clip(prompt, LOG_MAX * 2), ...(local.length > 0 ? { local } : {}) }
}

/** The model's reply as updates: each line it wrote in the form asked for, tied to the last step of the stretch it numbers. */
export const parseBeats = (reply: string, job: Job): Beat[] => {
  const beats: Beat[] = []
  const told = new Set<number>()
  let tasks = 0
  for (const raw of reply.split('\n')) {
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

/** The trail with the updates in, the steps they tell of marked as told and relieved of what was kept only for the telling. */
export const feedIn = (trail: Trail, job: Job, beats: Beat[]): Trail => {
  const covered = new Set(job.ids)
  const known = new Set(trail.feed.map(beat => beat.id))
  const feed = [...trail.feed, ...[...(job.local ?? []), ...beats].filter(beat => !known.has(beat.id))].sort((a, b) => a.turn - b.turn || a.at - b.at)
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
 * of its pictures and the answers given to its questions.
 */
export const adopt = (built: Trail, had: Trail): Trail => {
  const told = new Set(had.items.filter(item => item.fed).map(item => item.id))
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
