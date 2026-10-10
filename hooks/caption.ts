// What each picture of the feed shows and what it was about, asked of the conversation itself: the model that
// writes the updates reads a log and sees no picture, while the conversation holds them and what was said of
// them. Pure: the hooks module puts the question; this words it and reads the answer.

import type { Item, Trail } from '../types'
import { clean, clip } from './trail.ts'

/** Pictures to ask about. */
export type CaptionJob = {
  /** The pictures, by the number each has in the question. */
  shots: Item[]
  prompt: string
}

/** Pictures asked about at once, newest first: more would be a long answer and old ones may have left the conversation. */
const MOST = 10
const CAPTION_MAX = 320
const SAID_MAX = 110

const INTRO = [
  'This message is not from the person. It is the Trail side pane, which shows them an activity feed of this conversation, asking you for captions for the pictures and other outputs in that feed. Do not go on with the work and do not use any tool: only answer this.',
  '',
  'For each picture listed below, write a caption of one or two plain sentences, at most thirty-five words, that says what the picture shows and what it was about:',
  '- for a picture the person pasted: what they were showing you and what they were telling you with it;',
  '- for a picture you opened or were given by a tool: why you looked at it and what you saw in it;',
  '- for a picture you sent them: what it shows and why you sent it.',
  'Say what you made of it, concretely, so that someone who has not seen the conversation understands the picture. Write to the person as "you". No filler.',
  'If you cannot find a picture in this conversation, write a single dash for it.',
  '',
  'The pictures, oldest first:',
]

const OUTRO = ['', 'Reply with one line per picture and nothing else:', 'N|caption']

/** How the question names a picture, so the conversation can tell which is meant. */
const described = (shot: Item, trail: Trail, time: (at: number) => string): string => {
  const when = shot.at > 0 ? ` at ${time(shot.at)}` : ''
  const ask = trail.items.find(item => item.kind === 'ask' && item.id === shot.anchor)
  if (ask) {
    const fellows = trail.items.filter(item => item.kind === 'shot' && item.anchor === shot.anchor)
    const place = fellows.length > 1 ? ` (picture ${fellows.indexOf(shot) + 1} of ${fellows.length} in that message)` : ''
    return `a picture the person pasted${when}, with their message beginning "${clip(ask.line, SAID_MAX)}"${place}`
  }
  const type = shot.shot?.type ?? 'image'
  if (type === 'link') return `the page you published${when} (${shot.line}): say what it is and what it is for`
  if (type === 'video') return `the video ${shot.line.replace(/^Sent you /, '')}, which ${shot.line.startsWith('Sent you ') ? 'you sent the person' : 'a command you ran made'}${when}: you cannot see it here, so say what it is of and what it was made for`
  if (type === 'file') return `the file ${shot.line.replace(/^Sent you /, '')}, which you sent the person${when}: say what it is and what it is for`
  if (shot.line.startsWith('Sent you ')) return `the picture ${shot.line.slice('Sent you '.length)}, which you sent the person${when}`
  if (shot.line.startsWith('Picture from ')) return `a picture a tool returned to you${when} (${shot.line.slice('Picture from '.length)})`
  return `the picture ${shot.line}, which you opened${when}`
}

/**
 * The pictures still without a caption of the conversation's own (none at
 * all, or one only made out from the words around it), as a question for it:
 * only those since the context was last compacted, which are the ones it
 * still holds. Null when there are none.
 */
export const captionJob = (trail: Trail, time: (at: number) => string): CaptionJob | null => {
  const since = trail.items.map(item => item.kind).lastIndexOf('compact')
  const shots = trail.items.filter((item, index) => index > since && item.kind === 'shot' && item.shot !== undefined && (item.shot.note === undefined || item.shot.guess === true)).slice(-MOST)
  if (shots.length === 0) return null
  const lines = shots.map((shot, index) => `${index + 1}. ${described(shot, trail, time)}`)
  return { shots, prompt: [...INTRO, ...lines, ...OUTRO].join('\n') }
}

/**
 * The answer as captions, by picture. One the conversation could not find,
 * or gave no line for, gets an empty caption: it has been asked about, and
 * is not asked about again.
 */
export const parseCaptions = (reply: string, job: CaptionJob): { id: string; text: string }[] => {
  const told = new Map<number, string>()
  for (const raw of reply.split('\n')) {
    const found = /^\s*[-*]?\s*\[?(\d+)\]?\s*[|.:)]\s*(.*?)\s*$/.exec(raw)
    if (!found) continue
    const index = Number(found[1]) - 1
    if (index < 0 || index >= job.shots.length || told.has(index)) continue
    const text = clean(found[2]!)
    told.set(index, /^[-–—]*$/.test(text) ? '' : clip(text, CAPTION_MAX))
  }
  // An answer with no line in the form asked for is no answer: the pictures are asked about another time.
  if (told.size === 0) return []
  return job.shots.map((shot, index) => ({ id: shot.id, text: told.get(index) ?? '' }))
}
