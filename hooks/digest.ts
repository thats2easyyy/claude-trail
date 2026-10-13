// The feed's updates: the steps of the work, put to a model as a log divided into stretches, and its reply
// read back as one short account of each stretch, the way a match is told as it goes. Pure: the model call is
// the hooks module's; this makes the prompt and reads the answer.

import type { Beat, Item, Trail } from '../types'
import { clean, clip, MAX_BEATS, SENT, waitsOf, workCount, workLine } from './trail.ts'

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
  /** The pictures and files without a caption that the log names, in the order it marks them p1, p2 and so on. */
  pics: string[]
}

/** Characters of log put to the model at once. */
const LOG_MAX = 9000
/** Characters of the newest turns told again when the person asks for the transcript to be read back: under one log's worth. */
const RETOLD_MAX = 6000
/** Steps to a stretch: each stretch is told in one update, so this is how often a long run is told of. */
const STRETCH_STEPS = 4
const UPDATE_MAX = 420
/** Actions to a stretch, and the length of one: an update is a few short lines, not a paragraph. */
const ACTIONS_MOST = 3
const ACTION_MAX = 90
/** What stands in for an exchange with no work in it: the start of the answer. */
const ANSWER_SHOWN = 110
/** Things one reply may leave waiting on the person, the length of each, and how many still waiting are put to the model. */
const WAITS_MOST = 3
const WAIT_MAX = 200
const OPEN_MOST = 8
/** Commands and links one thing waiting may carry, and the length of one. */
const REFS_MOST = 4
const REF_MAX = 240
/** Pictures one log asks captions for, and the length of a caption. */
const PICS_MOST = 12
const CAPTION_MAX = 320
const STILL_WAITING = 'STILL WAITING ON THE PERSON FROM BEFORE THIS LOG:'
/** What in an answer with no work in it says something may be left with the person: it is then put to a model like any other. */
const LEFT_WITH_THEM = /\?|\b(?:waits?|waiting|blocked) on you\b|\bneeds? you(?:r)?\b|\byou(?:'ll| will)? (?:need|have) to\b|\b(?:once|until|after) you\b|\byour (?:call|go-ahead|approval|answer|decision|choice|pick|sign-off)\b|\b(?:let|tell) me\b|\bsay which\b|\bup to you\b|\bconfirm\b/i

export const SYSTEM = [
  'You write the activity feed of a coding session between a person and Claude, an AI coding agent: a terse list of what was done, so the person can see what happened at a glance without reading the conversation.',
  '',
  'You are given a log of part of the session: what the person asked, then what Claude said and did, divided into numbered stretches marked [1], [2] and so on.',
  'For each stretch, write the things done in it that matter, as one to three actions. An action is a few words, eight at most, in the past tense, starting with a verb and naming the thing: "Fixed the scroll jump in the list", "Pushed the new look, 228 tests passing", "Opened PR 8", "Found the leak in the cache". Put the outcome or the number in it where there is one. Separate the actions of a stretch with " ; ".',
  'Only what was done or found. Leave out reading files, re-running commands, plans, explanations, what will be done next, and anything about how Claude went about it. No sentences, no "Claude" or "you" as the subject, no filler. Fewer actions is better: a stretch that did one thing gets one.',
  'Report only what the log shows was done or found. What the person asked for is there so you know what the work was for: never report it as done unless the log shows it.',
  '',
  'Reply with one line per stretch:',
  'N|action ; action',
  'where N is the number of the stretch.',
  '',
  'Then, only if the end of the log leaves something waiting on the person, add one line for each such thing:',
  'wait|N|what they are to do, in at most twenty words ::: command or link ;; command or link',
  'where N is the stretch that left it waiting. Something waits on the person when a piece of the work cannot go on, or cannot be finished, until they act: a command only they can run, a sign-in or a permission, an approval, a choice or a question Claude put to them, something to try and report back on. Begin with the verb and say what it unblocks ("Run `gh auth refresh -s workflow` so the packaging branch can be pushed"). An offer of more work, a suggestion, and anything Claude will do by itself are not waiting on them, and most logs leave nothing waiting.',
  'After " ::: " give what they need to do it with, up to four, separated by " ;; ": the exact command to run, or the link to open (a pull request, a page, a dashboard). Copy each exactly from the log. Where the log names the thing but not the command, give the command only if it is the plain, standard one for that action and tool (merging pull request 13 with the GitHub CLI is "gh pr merge 13"); never guess at flags, names or addresses. With nothing to give, leave " ::: " out.',
  'The log may open with things still waiting on the person from before, marked w1, w2 and so on. Never write a wait line for one of those again. If the log shows that one of them was done or answered, or no longer matters, add a line:',
  'clear|w1',
  'with its mark.',
  '',
  'Then, for each picture or file the log marks p1, p2 and so on, add one line:',
  'pic|p1|what it shows and what it was for, in at most thirty words',
  'going only by what the log says around it: what the person said as they pasted it, what Claude said it saw in it, what Claude made or sent it for. You cannot see the picture, so never guess at what is in it: if the log does not say, leave the caption empty ("pic|p1|").',
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
  // The answer is the whole of what happened: its first sentence, kept short, is the update.
  return answer ? [beatAt(answer, clip(answer.line, ANSWER_SHOWN))] : []
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

/** How the log tells of a picture or a file, by where it came from; marked when a caption is wanted for it. */
const pictureText = (item: Item, mark: string): string => {
  const marked = mark ? `[${mark}] ` : ''
  const type = item.shot?.type ?? 'image'
  if (item.shot?.from === 'person') return `${marked}the person pasted a picture with what they asked`
  if (item.line.startsWith(SENT)) return `${marked}sent the person ${type === 'video' ? 'a video' : type === 'file' ? 'a file' : 'a picture'}: ${item.line.slice(SENT.length)}`
  if (type === 'link') return `${marked}published a page: ${item.line.replace(/^Published /, '')}`
  if (type === 'video') return `${marked}a command made a video: ${item.line}`
  return `${marked}looked at a picture: ${item.line}`
}

const entryText = (item: Item, isLast: boolean, mark = ''): string => {
  const did = item.work && workCount(item.work) > 0 ? ` [did: ${[...item.work.notes, workLine(item.work)].join('; ')}]` : ''
  if (item.kind === 'shot') return pictureText(item, mark)
  if (item.kind === 'ask') return `(before saying anything)${did}`
  const said = item.more ?? item.line
  return `${item.kind === 'done' && isLast ? 'final answer' : 'said'}: ${said}${did}`
}

const logOf = (turns: Item[][]): { prompt: string; slots: Item[]; pics: string[] } => {
  const slots: Item[] = []
  const pics: string[] = []
  const lines: string[] = []
  // An output nothing has said anything of yet is marked, for the model to say what the log tells of it. A picture
  // the person pasted, or one from before the session, is listed nowhere and gets no caption.
  const markOf = (item: Item): string => (item.kind === 'shot' && item.shot?.note === undefined && item.shot?.from === undefined && pics.length < PICS_MOST ? `p${pics.push(item.id)}` : '')
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
      for (const item of stretch) lines.push(entryText(item, item === shown[shown.length - 1], markOf(item)))
    }
  }
  return { prompt: lines.join('\n'), slots, pics }
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
  if (told.length === 0) return { ids, slots: [], prompt: '', local, isLatest, open: [], pics: [] }
  const { prompt, slots, pics } = logOf(told)
  const still = open.length > 0 ? [STILL_WAITING, ...open.map((beat, index) => `w${index + 1}: ${beat.title}`), '', ''].join('\n') : ''
  return { ids, slots, prompt: still + clip(prompt, LOG_MAX * 2), ...(local.length > 0 ? { local } : {}), isLatest, open: open.map(beat => beat.id), pics }
}

/**
 * How many steps have no update and will get none unasked: those of turns
 * with something already told after them. They went by while the pane was
 * closed, and are history now that the latest is told.
 */
export const backlogOf = (trail: Trail): number => {
  const told = trail.items.reduce((latest, item) => (item.fed ? Math.max(latest, item.turn) : latest), -1)
  return trail.items.filter(item => isStep(item) && !item.fed && item.turn < told).length
}

/** The model's reply as updates: each line it wrote in the form asked for, tied to the last step of the stretch it numbers. */
export const parseBeats = (reply: string, job: Job): Beat[] => {
  const beats: Beat[] = []
  const told = new Set<number>()
  let waits = 0
  for (const raw of reply.split('\n')) {
    // Something left waiting on the person: tied to the stretch that left it, and listed apart until it is done.
    const wait = /^\s*[-*]?\s*wait\s*\|\s*\[?(\d+)\]?\s*\|\s*(.+?)\s*$/i.exec(raw)
    if (wait) {
      const left = job.slots[Number(wait[1]) - 1]
      const [said = '', withIt = ''] = wait[2]!.split(/\s+:::\s*/, 2)
      const what = clip(clean(said), WAIT_MAX)
      // What they need to do it with: commands to copy and links to open, as the model gave them.
      const refs = withIt
        .split(/\s*;;\s*/)
        .map(ref => clean(ref).replace(/^`+|`+$/g, ''))
        .filter(ref => ref.length >= 2 && ref.length <= REF_MAX)
        .slice(0, REFS_MOST)
      if (left && what.length >= 4 && waits < WAITS_MOST) beats.push({ ...beatAt(left, what), id: `w:${left.id}:${waits++}`, kind: 'waiting', ...(refs.length > 0 ? { refs } : {}) })
      continue
    }
    if (/^\s*[-*]?\s*(?:clear|pic)\s*\|/i.test(raw)) continue
    const found = /^\s*[-*]?\s*\[?(\d+)\]?\s*\|\s*(.+?)\s*$/.exec(raw)
    if (!found) continue
    const slot = Number(found[1])
    const at = job.slots[slot - 1]
    // The actions of the stretch, each kept short and on a line of its own.
    const actions = found[2]!
      .split(/\s+;\s+|\s*;\s*$/)
      .map(action => clip(clean(action).replace(/^[;\s]+|[.;,\s]+$/g, ''), ACTION_MAX))
      .filter(action => action.length >= 3)
      .slice(0, ACTIONS_MOST)
    // One update to a stretch; a number that names none, or a line left empty, says nothing.
    if (!at || told.has(slot) || actions.join('').length < 4) continue
    told.add(slot)
    beats.push({ ...beatAt(at, ''), title: actions.join('\n') })
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

/**
 * What the model's reply says of the pictures and files the log marked, by each: only where it had something to
 * say. One the log told nothing of keeps no caption: the model cannot see it, and does not guess.
 */
export const parsePictures = (reply: string, job: Job): { id: string; text: string }[] => {
  const told = new Map<string, string>()
  for (const raw of reply.split('\n')) {
    const found = /^\s*[-*]?\s*pic\s*\|\s*\[?p?(\d+)\]?\s*\|\s*(.*?)\s*$/i.exec(raw)
    const id = found ? job.pics[Number(found[1]) - 1] : undefined
    const text = found ? clean(found[2]!) : ''
    if (id && !told.has(id) && text.length >= 4 && !/^[-–—]+$/.test(text)) told.set(id, clip(text, CAPTION_MAX))
  }
  return [...told].map(([id, text]) => ({ id, text }))
}

/** The web page of a repository on GitHub, from its remote as git has it; '' for any other. */
export const repoPage = (remote: string | null | undefined): string => {
  const found = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec((remote ?? '').trim())
  return found ? `https://github.com/${found[1]}/${found[2]}` : ''
}

/**
 * Things waiting on the person that name pull requests by number, with the
 * link to each added when the session's repository is on GitHub: the number
 * and the repository are all a link is made of, so it is no guess.
 */
export const withPullLinks = (beats: Beat[], remote: string | null | undefined): Beat[] => {
  const page = repoPage(remote)
  if (!page) return beats
  return beats.map(beat => {
    if (beat.kind !== 'waiting') return beat
    const numbers: string[] = []
    for (const named of beat.title.matchAll(/\b(?:PRs?|pull requests?)\s*#?(\d+)((?:\s*(?:,|or|and|&)\s*#?\d+)*)/gi)) {
      for (const one of [named[1]!, ...[...named[2]!.matchAll(/\d+/g)].map(found => found[0])]) if (!numbers.includes(one)) numbers.push(one)
    }
    const had = beat.refs ?? []
    const links = numbers.map(number => `${page}/pull/${number}`).filter(link => !had.some(ref => ref.replace(/\/$/, '') === link))
    return links.length > 0 ? { ...beat, refs: [...links, ...had].slice(0, REFS_MOST + links.length) } : beat
  })
}

const sameWords = (a: string, b: string): boolean => a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * The trail with the updates in, the steps they tell of marked as told and relieved of what was kept only for
 * the telling. What the reply left waiting on the person is taken only from a log that ran to the latest (an
 * older stretch's is long since dealt with), and what it cleared stops waiting as of the log's last step.
 * What it said of the pictures becomes their captions.
 */
export const feedIn = (trail: Trail, job: Job, beats: Beat[], cleared: string[] = [], captions: { id: string; text: string }[] = []): Trail => {
  const covered = new Set(job.ids)
  const notes = new Map(captions.map(one => [one.id, one.text]))
  const known = new Set(trail.feed.map(beat => beat.id))
  const over = new Set(cleared)
  const overAt = job.slots.reduce((latest, slot) => Math.max(latest, slot.at), 0)
  // A thing already waiting that the reply tells of again, now with what it is done with, gains that.
  const gained = (beat: Beat): string[] | undefined =>
    beat.kind === 'waiting' && beat.over === undefined && !beat.refs?.length ? beats.find(told => told.kind === 'waiting' && told.refs?.length && (told.id === beat.id || sameWords(told.title, beat.title)))?.refs : undefined
  const had = trail.feed.map(beat => {
    const refs = gained(beat)
    const kept = refs ? { ...beat, refs } : beat
    return over.has(kept.id) && kept.over === undefined ? { ...kept, over: overAt } : kept
  })
  const stillOpen = had.filter(beat => beat.kind === 'waiting' && beat.over === undefined)
  const fresh = [...(job.local ?? []), ...beats].filter(beat => !known.has(beat.id) && (beat.kind !== 'waiting' || (job.isLatest && !stillOpen.some(other => sameWords(other.title, beat.title)))))
  const feed = [...had, ...fresh].sort((a, b) => a.turn - b.turn || a.at - b.at)
  return {
    ...trail,
    feed: feed.slice(-MAX_BEATS),
    items: trail.items.map(found => {
      const note = notes.get(found.id)
      const item = note !== undefined && found.shot && found.shot.note === undefined ? { ...found, shot: { ...found.shot, note } } : found
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
  const { sought: _, ...rest } = built
  return {
    ...rest,
    // What was told before the mod looked for what waits on the person stays so marked until its latest is told again.
    ...(isRetelling || had.sought ? { sought: true as const } : {}),
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
