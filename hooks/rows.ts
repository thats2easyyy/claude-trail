// A transcript file's rows as trail events: how a session that ran before the mod was loaded gets its trail.
// Pure: whoever calls reads the file. The file's layout is the engine's own business and no promise of its
// API, so every field is taken as it may or may not be there.

import { basename, outputType, publishedAt, SENT, toolNote, videosNamed } from './trail.ts'
import type { TrailEvent } from './trail.ts'

type Block = {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
  source?: { media_type?: string; data?: string }
}

type Row = {
  type?: string
  subtype?: string
  uuid?: string
  timestamp?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  isApiErrorMessage?: boolean
  cwd?: string
  content?: unknown
  message?: { content?: unknown; model?: string; stop_reason?: string | null }
  attachment?: { type?: string; prompt?: unknown; commandMode?: string; origin?: { kind?: string } }
  toolUseResult?: { attachments?: unknown }
}

/** A picture as its row holds it, keyed by the shot event it belongs to. */
export type Held = { mediaType: string; base64: string }

/**
 * `pictures` has, by shot, the picture its row holds; `sent`, by shot, the
 * path of a file Claude sent the person; `made`, by shot, a video a command
 * named and when that command ran (whether the file is there, and was written
 * then, is the caller's to find out: a command that only lists a video names
 * it too); `opened`, by shot, the path of a picture Claude opened; `asked`, by question, the path of the picture it was asked about.
 */
export type Named = { path: string; from: number; to: number }
export type Parsed = { events: TrailEvent[]; pictures: Map<string, Held>; sent: Map<string, string>; made: Map<string, Named>; opened: Map<string, string>; asked: Map<string, string> }

const ASK_TOOL = 'mcp__trail__ask'
const OWN_COMMAND = /<command-name>\s*\/?trail\s*</
const INTERRUPTED = /^\s*\[Request interrupted by user[^\]]*\]\s*$/
const STOP_HOOK = /^\s*Stop hook feedback/
const SYNTHETIC = '<synthetic>'

const pictureOf = (block: Block | undefined): Held | undefined =>
  block?.type === 'image' && typeof block.source?.data === 'string' ? { mediaType: block.source.media_type ?? 'image/png', base64: block.source.data } : undefined

const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? content.filter((block): block is Block => typeof block === 'object' && block !== null) : [])

export const eventsFromRows = (lines: Iterable<string>, home = ''): Parsed => {
  const events: TrailEvent[] = []
  const videos = new Map<string, Named>()
  const opened = new Map<string, string>()
  const pictures = new Map<string, Held>()
  const sent = new Map<string, string>()
  const asked = new Map<string, string>()
  const calls = new Map<string, { tool: string; input: Record<string, unknown>; at: number }>()
  /** When the model last stopped of its own accord with nothing after it: where its turn ended, if no row says so. */
  let stoppedAt: number | null = null
  /** What the model says next answers a hook that held its stop, not the person: it is no step of the work. */
  let isAnsweringHook = false

  const endIfStopped = () => {
    if (stoppedAt !== null) events.push({ t: 'end', at: stoppedAt })
    stoppedAt = null
  }
  const prompt = (id: string, at: number, text: string) => {
    if (OWN_COMMAND.test(text)) return false
    // Stopped by the person: the turn ended there, and not with an answer.
    if (INTERRUPTED.test(text)) {
      stoppedAt = null
      events.push({ t: 'end', at, aborted: true })
      return false
    }
    endIfStopped()
    isAnsweringHook = false
    events.push({ t: 'prompt', id, at, text, isCommand: text.includes('<command-name>') })
    return true
  }

  for (const line of lines) {
    if (!line) continue
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      continue
    }
    if (typeof row !== 'object' || row === null || row.isSidechain || typeof row.uuid !== 'string') continue
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) || 0 : 0
    const id = row.uuid

    if (row.type === 'system') {
      if (row.subtype === 'away_summary' && typeof row.content === 'string') events.push({ t: 'recap', id, at, text: row.content })
      else if (row.subtype === 'turn_duration') {
        stoppedAt = null
        events.push({ t: 'end', at })
      } else if (row.subtype === 'compact_boundary') events.push({ t: 'compact', id, at })
      continue
    }

    // What the person typed while a turn ran is kept as an attachment to that turn, not as a row of theirs.
    if (row.type === 'attachment') {
      const typed = row.attachment
      if (typed?.type === 'queued_command' && typed.commandMode === 'prompt' && typed.origin?.kind === 'human' && !row.isMeta) {
        const text = typeof typed.prompt === 'string' ? typed.prompt : blocksOf(typed.prompt).flatMap(block => (typeof block.text === 'string' ? [block.text] : [])).join('\n')
        if (text) prompt(id, at, text)
      }
      continue
    }

    const content = row.message?.content
    if (row.type === 'user') {
      // The summary a compaction leaves is the engine's words, set where the person's would be.
      if (row.isCompactSummary) continue
      if (typeof content === 'string') {
        if (row.isMeta) {
          stoppedAt = null
          if (STOP_HOOK.test(content)) isAnsweringHook = true
        } else prompt(id, at, content)
        continue
      }
      const blocks = blocksOf(content)
      const results = blocks.filter(block => block.type === 'tool_result')
      const said = blocks.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
      if (row.isMeta || results.length > 0) stoppedAt = null
      if (row.isMeta && said.some(text => STOP_HOOK.test(text))) isAnsweringHook = true
      if (said.length > 0 && !row.isMeta && results.length === 0 && prompt(id, at, said.join('\n'))) {
        blocks.forEach((block, index) => {
          const held = pictureOf(block)
          if (!held) return
          const shot = `${id}:${index}`
          pictures.set(shot, held)
          events.push({ t: 'shot', id: shot, at, anchor: id, file: '', w: 0, h: 0, label: 'You pasted a picture', from: 'person' })
        })
      }
      for (const result of results) {
        const call = result.tool_use_id
        if (typeof call !== 'string') continue
        if (result.is_error) events.push({ t: 'fail', id: call, at })
        const made = calls.get(call)
        // A picture Claude sent the person is named in the row's record of the call, not held in it.
        if (made?.tool === 'SendUserFile' && Array.isArray(row.toolUseResult?.attachments)) {
          ;(row.toolUseResult.attachments as { path?: unknown; isImage?: unknown }[]).forEach((file, index) => {
            if (typeof file !== 'object' || file === null || typeof file.path !== 'string') return
            const shot = `${call}:${index}`
            sent.set(shot, file.path)
            const type = file.isImage === true ? 'image' : outputType(file.path) === 'video' ? 'video' : 'file'
            const said = typeof made.input['caption'] === 'string' ? made.input['caption'] : undefined
            events.push({ t: 'shot', id: shot, at, anchor: call, file: '', w: 0, h: 0, label: SENT + basename(file.path), type, ...(said ? { note: said } : {}) })
          })
        }
        const answer = typeof result.content === 'string' ? result.content : blocksOf(result.content).flatMap(block => (typeof block.text === 'string' ? [block.text] : [])).join('\n')
        // A video a command made is named in what it ran or printed, and nowhere else.
        if (made?.tool === 'Bash' && !result.is_error) {
          const cwd = typeof row.cwd === 'string' ? row.cwd : ''
          for (const name of videosNamed(`${typeof made?.input['command'] === 'string' ? made.input['command'] : ''}\n${answer}`)) {
            const path = name.startsWith('/') ? name : name.startsWith('~/') ? home + name.slice(1) : `${cwd}/${name.replace(/^\.\//, '')}`
            const shot = `out:${call}:${path}`
            videos.set(shot, { path, from: made.at, to: at })
            events.push({ t: 'shot', id: shot, at, anchor: call, file: '', w: 0, h: 0, label: basename(path), type: 'video' })
          }
        }
        const url = made?.tool === 'Artifact' ? publishedAt(answer) : undefined
        if (url) events.push({ t: 'shot', id: call, at, anchor: call, file: '', w: 0, h: 0, label: `Published ${typeof made?.input['file_path'] === 'string' ? basename(made.input['file_path']) : 'a page'}`, full: url, type: 'link' })
        const held = blocksOf(result.content).map(pictureOf).filter(Boolean).at(-1)
        if (!held) continue
        const path = typeof made?.input['file_path'] === 'string' ? made.input['file_path'] : ''
        const short = (made?.tool ?? 'a tool').split('__').slice(2).join(' ') || (made?.tool ?? 'a tool')
        pictures.set(call, held)
        if (path) opened.set(call, path)
        events.push({ t: 'shot', id: call, at, anchor: call, file: '', w: 0, h: 0, label: path ? basename(path) : `Picture from ${short}` })
      }
      continue
    }

    if (row.type === 'assistant') {
      // A reply the engine wrote in the model's place is no step, unless it is saying the model's reply failed.
      if (row.message?.model === SYNTHETIC && !row.isApiErrorMessage) continue
      let said = 0
      for (const block of blocksOf(content)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (!isAnsweringHook) events.push({ t: 'say', id: said === 0 ? id : `${id}:${said}`, at, text: block.text })
          said++
        } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          isAnsweringHook = false
          const input = typeof block.input === 'object' && block.input !== null ? block.input : {}
          calls.set(block.id, { tool: block.name, input, at })
          const file = typeof input['file_path'] === 'string' ? input['file_path'] : undefined
          events.push({ t: 'tool', id: block.id, at, tool: block.name, note: toolNote(block.name, input), file })
          if (block.name === ASK_TOOL && typeof input['question'] === 'string') {
            const options = Array.isArray(input['options']) ? input['options'].filter((option): option is string => typeof option === 'string') : []
            if (typeof input['image'] === 'string') asked.set(block.id, input['image'])
            events.push({ t: 'question', id: block.id, at, text: input['question'], options })
          }
        }
      }
      stoppedAt = row.message?.stop_reason === 'end_turn' ? at : null
    }
  }
  endIfStopped()

  return { events, pictures, sent, made: videos, opened, asked }
}
