import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { captionJob, parseCaptions } from '../hooks/caption.ts'
import { adopt, feedIn, nextJob, parseBeats, parseCleared } from '../hooks/digest.ts'
import { candidates, reach } from '../hooks/jump.ts'
import { eventsFromRows } from '../hooks/rows.ts'
import { add, ANSWERED_THERE, emptyTrail, firstSentence, MAX_ITEMS, mended, outputType, paneAnswer, promptLine, publishedAt, tag, videosNamed, waitsOf, workLine } from '../hooks/trail.ts'
import type { TrailEvent } from '../hooks/trail.ts'
import { layout, pictureBox, wrap, zoneOf } from '../hooks/view.ts'

const SID = 'session-1'
const HOME = '/Users/someone'
const DIR = `${HOME}/.claude/trail/${SID}`
const NOW = 1_800_000_000_000

const pane = <S extends 'terminal' | 'desktop'>(surface: S) =>
  ({
    plugin: 'trail',
    surface,
    component: 'Pane',
    requestId: 'trail',
    props: { title: 'Trail', isFocused: false, bodyColumns: 58, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    viewport: { columns: 200, rows: 50, isFullscreen: true },
  }) as const

const PERSON = { kind: 'composer' } as const
const MODEL = { kind: 'model', model: 'opus' } as const
const NOBODY = { id: '' }
const USAGE = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const folded = (events: TrailEvent[]) => events.reduce(add, emptyTrail())

/** A turn with real work in it: three steps, a failure, a picture, an answer. */
const WORKED: TrailEvent[] = [
  { t: 'prompt', id: 'p1', at: 1000, text: 'make the boss fight playable' },
  { t: 'tool', id: 't1', at: 2000, tool: 'Read', note: 'boss.cs', file: '/game/boss.cs' },
  { t: 'say', id: 's1', at: 3000, text: 'The encounter script is read. Next the attack patterns.' },
  { t: 'tool', id: 't2', at: 4000, tool: 'Edit', note: 'boss.cs', file: '/game/boss.cs' },
  { t: 'tool', id: 't3', at: 5000, tool: 'Bash', note: 'Run the play-mode tests' },
  { t: 'fail', id: 't3', at: 5500 },
  { t: 'shot', id: 't4', at: 6000, anchor: 't4', file: '/shots/t4.png', w: 720, h: 450, label: 'phase2.png', full: '/shots/t4.full.png' },
  { t: 'say', id: 's2', at: 7000, text: 'The boss fight is playable end to end. Two tests are still flaky.' },
  { t: 'end', at: 9000 },
]

/**
 * What the engine would answer beneath the mod. `files` is the disk, `ran`
 * the host commands it was asked to run, `sent` the prompts the mod submitted
 * and `asked` the logs it put to a model, each answered with `reply`. A test
 * has no transcript, so a jump finds nothing to scroll: the order of its
 * tries is tested on its own below.
 */
function engine(on: On, reply = '', captions = '') {
  const files = new Map<string, string>()
  const ran: string[][] = []
  const sent: string[] = []
  const asked: string[] = []
  const forked: string[] = []
  /** Files a command is taken to have just written. */
  const made = new Set<string>()
  mock.env(on, { HOME })
  mock.store(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('session.model', () => ({ value: 'opus' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__trail__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => (files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: 'no such file' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    const [command, flag] = e.argv
    // sips writes the picture it was asked for, and the system's preview of a file lands beside the others.
    const out = e.argv.indexOf('--out')
    if (command === '/usr/bin/sips' && out > 0) files.set(e.argv[out + 1] ?? '', 'png')
    if (command === '/usr/bin/qlmanage') files.set(`${e.argv[5]}/${String(e.argv[6]).split('/').pop()}.png`, 'png')
    const said = command === '/bin/date' ? '+0900\n' : flag === '-g' ? '  pixelWidth: 720\n  pixelHeight: 450\n' : ''
    // The transcript holds nothing in a test: the tool that reads it back is taken as not there.
    return { value: { exitCode: command === 'node' ? 1 : 0, stdout: said, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', (_$, e) => {
    asked.push(e.prompt)
    return { value: reply ? { isAnswered: true, text: reply, usage: USAGE } : { isAnswered: false, reason: 'empty-reply', usage: USAGE } }
  })
  // The conversation itself, asked about its pictures.
  on('model.fork', (_$, e) => {
    forked.push(e.prompt)
    return { value: captions ? { isAnswered: true, text: captions, usage: USAGE } : { isAnswered: false, reason: 'nothing-to-fork' } }
  })
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.stat', (_$, e) => (made.has(e.path) ? { value: { kind: 'file', size: 9000, mtimeMs: NOW + 500, isLink: false } } : { deny: 'no such file' }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'Read' && String(e.file_path).endsWith('.png')) return { result: { type: 'image', file: { base64: '', type: 'image/png', originalSize: 10, dimensions: { originalWidth: 1440, originalHeight: 900 } } } }
    if (e.tool === 'SendUserFile') return { result: { attachments: [{ path: '/work/out/demo.mp4', size: 9000, isImage: false }] }, text: '1 file delivered to user.' }
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
  })

  return { files, ran, sent, asked, forked, made }
}

/** A row as the engine appends it: what the model said, what the person asked, or a command they typed. */
const row = (door: 'response' | 'prompt' | 'command', uuid: string, text: string, agentId?: string) => ({
  door,
  uuid,
  origin: door === 'response' ? MODEL : PERSON,
  message: { type: door === 'response' ? ('assistant' as const) : ('user' as const), content: [{ type: 'text', text }] },
  ...(agentId === undefined ? {} : { agentId }),
})
/**
 * Raises a row as the engine does when it appends one. The session stores a row and a test has no session, so
 * nothing answers beneath the mod and the call rejects; the mod has read the row by then, which is what is tested.
 */
const appended = (call: Promise<unknown>) => call.catch(() => undefined)
const say = (uuid: string, text: string) => row('response', uuid, text)
/** Claude calling the mod's own tool, which the engine's list of tool names does not know of. */
const askInPane = ($: Engine, input: Record<string, unknown>) =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ result?: unknown; isError?: boolean }>)({ tool: 'mcp__trail__ask', ...input })
const ask = (uuid: string, text: string) => row('prompt', uuid, text)

// ------------------------------------------------------------ the steps

test('a turn folds into what was asked, each step with its work, its pictures, and how it came out', () => {
  const trail = folded(WORKED)

  expect(trail.items.map(item => item.kind)).toEqual(['ask', 'step', 'shot', 'done'])
  const [asked, step, shot, done] = trail.items
  expect(asked?.line).toBe('make the boss fight playable')
  expect(asked?.ms).toBe(8000)
  expect(asked?.alt).toBe('t1')
  expect(step?.line).toBe('The encounter script is read. Next the attack patterns.')
  expect(step?.alt).toBe('t2')
  // What failed is said first, where no clip of the line takes it.
  expect(workLine(step!.work!)).toBe('1 failed · 1 command · edited boss.cs')
  // What a call said it was for is kept, for the highlight to be written from.
  expect(step?.work?.notes).toEqual(['Run the play-mode tests'])
  expect(shot?.anchor).toBe('t4')
  expect(shot?.shot?.full).toBe('/shots/t4.full.png')
  expect(done?.line).toBe('The boss fight is playable end to end.')
  expect(done?.more).toBe('The boss fight is playable end to end. Two tests are still flaky.')
  expect(trail.isOpen).toBe(false)
})

test('an event seen twice counts once, so a transcript read back can be laid over what was seen live', () => {
  const events: TrailEvent[] = [
    { t: 'prompt', id: 'p1', at: 1000, text: 'go' },
    { t: 'tool', id: 't1', at: 2000, tool: 'Bash', note: 'ls' },
    { t: 'fail', id: 't1', at: 2100 },
    { t: 'say', id: 's1', at: 3000, text: 'Listed the folder, nothing odd in it at all.' },
  ]
  const once = folded(events)
  expect(folded([...events, ...events])).toEqual(once)
  expect(once.items[0]?.work?.cmds).toBe(1)
  expect(once.items[0]?.work?.fails).toBe(1)
})

test('a command typed mid-turn is no part of the turn; one typed at rest heads the work it starts', () => {
  const running = folded([
    { t: 'prompt', id: 'p1', at: 1000, text: 'go' },
    { t: 'prompt', id: 'c1', at: 2000, text: '<command-name>/effort</command-name><command-args>high</command-args>', isCommand: true },
    { t: 'tool', id: 't1', at: 3000, tool: 'Bash', note: 'ls' },
  ])
  expect(running.items).toHaveLength(1)
  expect(running.items[0]?.work?.cmds).toBe(1)

  const atRest = folded([
    { t: 'prompt', id: 'c1', at: 1000, text: '<command-name>/code-review</command-name><command-args></command-args>', isCommand: true },
    { t: 'tool', id: 't1', at: 2000, tool: 'Bash', note: 'git diff' },
    { t: 'end', at: 3000 },
    { t: 'tool', id: 't2', at: 4000, tool: 'Bash', note: 'later' },
  ])
  expect(atRest.items.map(item => item.line)).toEqual(['/code-review', 'Carried on without a new prompt'])
  expect(atRest.items[0]?.work?.cmds).toBe(1)
})

test('only the newest recap is kept, and a long session stays bounded without losing asks or pictures', () => {
  let trail = folded([
    { t: 'prompt', id: 'p0', at: 1, text: 'first' },
    { t: 'recap', id: 'r1', at: 2, text: 'Older recap.' },
    { t: 'recap', id: 'r2', at: 3, text: 'Newer recap.' },
  ])
  expect(trail.items.filter(item => item.kind === 'recap').map(item => item.line)).toEqual(['Newer recap.'])

  for (let turn = 1; turn <= 60; turn++) {
    trail = add(trail, { t: 'prompt', id: `p${turn}`, at: turn * 1000, text: `ask ${turn}` })
    for (let step = 0; step < 10; step++) {
      trail = add(trail, { t: 'say', id: `s${turn}-${step}`, at: turn * 1000 + step, text: `Step ${step} of turn ${turn} is finished now.` })
      trail = add(trail, { t: 'tool', id: `t${turn}-${step}`, at: turn * 1000 + step, tool: 'Bash', note: 'work' })
    }
    trail = add(trail, { t: 'shot', id: `shot${turn}`, at: turn * 1000 + 20, anchor: `t${turn}-9`, file: '/x.png', w: 10, h: 10, label: 'x.png' })
    trail = add(trail, { t: 'end', at: turn * 1000 + 30 })
  }
  expect(trail.items.length).toBeLessThanOrEqual(MAX_ITEMS)
  expect(trail.items.filter(item => item.kind === 'ask')).toHaveLength(61)
  expect(trail.items.filter(item => item.kind === 'shot')).toHaveLength(60)
  // The steps of the oldest turns are gone; the work they did is counted under their ask.
  expect(trail.items.find(item => item.id === 'p1')?.work?.cmds).toBe(10)
})

test('lines are one plain sentence: no markdown, no control characters, no wrapper tags', () => {
  expect(firstSentence('**Done.** The `worksite` mod is built: it draws a town. More follows.')).toBe('Done. The worksite mod is built: it draws a town.')
  expect(firstSentence(`Line one${String.fromCharCode(7)} has a bell\nand a break`)).toBe('Line one has a bell and a break')
  expect(firstSentence(`Zero${String.fromCharCode(0x200b)}width and a line${String.fromCharCode(0x2028)}separator`)).toBe('Zero width and a line separator')
  expect(promptLine('<command-name>/trail</command-name>\n<command-args>rebuild</command-args>')).toBe('/trail rebuild')
  expect(promptLine('<local-command-stdout>Set effort</local-command-stdout>')).toBe('')
  expect(promptLine('<task-notification><task-id>1</task-id><summary>Build finished</summary></task-notification>')).toBe('Background task: Build finished')
  expect(promptLine('[Image #1] doesnt look that good lol')).toBe('doesnt look that good lol')
})

test('a transcript file reads back as the same trail, pictures keyed by the call that looked at them', () => {
  const rows = [
    { type: 'user', uuid: 'u1', timestamp: '2026-10-02T21:00:00.000Z', message: { content: 'build the pane' } },
    { type: 'user', uuid: 'u2', timestamp: '2026-10-02T21:00:01.000Z', isMeta: true, message: { content: 'a reminder nobody typed' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-10-02T21:00:02.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/shots/pane.png' } }] } },
    {
      type: 'user',
      uuid: 'u3',
      timestamp: '2026-10-02T21:00:03.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] },
    },
    { type: 'assistant', uuid: 'side', isSidechain: true, timestamp: '2026-10-02T21:00:04.000Z', message: { content: [{ type: 'text', text: 'A subagent talking to itself.' }] } },
    {
      type: 'assistant',
      uuid: 'a2',
      timestamp: '2026-10-02T21:00:05.000Z',
      message: { content: [{ type: 'tool_use', id: 'toolu_ask', name: 'mcp__trail__ask', input: { question: 'Is this the pane you meant?', options: ['Yes', 'No'], image: '/shots/pane.png' } }] },
    },
    { type: 'assistant', uuid: 'a3', timestamp: '2026-10-02T21:00:06.000Z', message: { content: [{ type: 'text', text: 'The pane is built and shows the trail.' }] } },
    { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: '2026-10-02T21:00:07.000Z' },
    { type: 'system', subtype: 'away_summary', uuid: 'w1', timestamp: '2026-10-02T21:05:00.000Z', content: 'The pane is built; next is trying it.' },
    { type: 'user', uuid: 'u4', timestamp: '2026-10-02T22:00:00.000Z', message: { content: paneAnswer('Is this the pane you meant?', 'Yes') } },
  ]
  const { events, pictures, asked } = eventsFromRows([...rows.map(line => JSON.stringify(line)), 'not json', ''])

  expect(pictures.get('toolu_1')).toEqual({ mediaType: 'image/png', base64: 'AAAA' })
  expect(asked.get('toolu_ask')).toBe('/shots/pane.png')
  const trail = folded(events.map(event => (event.t === 'shot' ? { ...event, file: '/kept/toolu_1.png', w: 720, h: 450 } : event)))
  expect(trail.items.map(item => [item.kind, item.anchor])).toEqual([
    ['ask', 'u1'],
    ['shot', 'toolu_1'],
    ['done', 'a3'],
    ['recap', 'w1'],
    ['ask', 'u4'],
  ])
  expect(trail.items[0]?.at).toBe(Date.parse('2026-10-02T21:00:00.000Z'))
  expect(trail.items[1]?.line).toBe('pane.png')
  // The question the transcript shows being asked, and the answer the pane sent back for it.
  expect(trail.questions).toMatchObject([{ id: 'toolu_ask', text: 'Is this the pane you meant?', options: ['Yes', 'No'], answer: 'Yes' }])
})

test('one long turn stays bounded without losing its ask, its pictures or the count of its work', () => {
  let trail = folded([
    { t: 'prompt', id: 'p0', at: 10, text: 'an earlier ask' },
    { t: 'say', id: 's0', at: 20, text: 'An earlier answer, given in full.' },
    { t: 'end', at: 30 },
    { t: 'prompt', id: 'p1', at: 1000, text: 'port the whole renderer overnight' },
  ])
  for (let step = 0; step < 420; step++) {
    trail = add(trail, { t: 'say', id: `s${step + 1}`, at: 2000 + step * 10, text: `Working through part ${step} of the port now.` })
    trail = add(trail, { t: 'tool', id: `t${step}`, at: 2005 + step * 10, tool: 'Bash', note: 'build' })
    if (step === 5) trail = add(trail, { t: 'shot', id: 'pic', at: 2007 + step * 10, anchor: 't5', file: '/x.png', w: 10, h: 10, label: 'x.png' })
  }
  trail = add(trail, { t: 'end', at: 9000 })
  expect(trail.items.length).toBeLessThanOrEqual(MAX_ITEMS)
  expect(trail.items.filter(item => item.kind === 'ask').map(item => item.id)).toEqual(['p0', 'p1'])
  expect(trail.items.find(item => item.id === 'p1')?.ms).toBe(8000)
  expect(trail.items.filter(item => item.kind === 'shot')).toHaveLength(1)
  expect(trail.items.reduce((sum, item) => sum + (item.work?.cmds ?? 0), 0)).toBe(420)
})

test('a turn cut short has no result line, and one never seen to end stopped when it last did something', () => {
  const stopped = folded([
    { t: 'prompt', id: 'p1', at: 1000, text: 'port the renderer to Metal' },
    { t: 'say', id: 's1', at: 2000, text: 'Now I will rewrite the shader pipeline from scratch.' },
    { t: 'end', at: 2500, aborted: true },
  ])
  expect(stopped.items.map(item => item.kind)).toEqual(['ask', 'step'])

  const died = folded([
    { t: 'prompt', id: 'p1', at: 1000, text: 'port the renderer to Metal' },
    { t: 'tool', id: 't1', at: 1500, tool: 'Bash', note: 'build' },
    { t: 'say', id: 's1', at: 2000, text: 'Now I will rewrite the shader pipeline from scratch.' },
    { t: 'prompt', id: 'p2', at: 90_000, text: 'what happened last night?' },
  ])
  expect(died.items.map(item => [item.kind, item.ms])).toEqual([['ask', 1000], ['step', undefined], ['ask', undefined]])

  // A file edited many times is one file; so is one named past the few that are shown.
  let edits = folded([{ t: 'prompt', id: 'p1', at: 1, text: 'tidy up' }])
  for (const [index, name] of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'd.ts', 'd.ts', 'e.ts', 'a.ts'].entries()) edits = add(edits, { t: 'tool', id: `e${index}`, at: 2 + index, tool: 'Edit', note: name, file: `/src/${name}` })
  expect(workLine(edits.items[0]!.work!)).toBe('edited a.ts, b.ts, c.ts +2')
})

test('what the engine wrote into a transcript is not read as the person speaking or the model answering', () => {
  expect(promptLine('[Request interrupted by user]')).toBe('')
  expect(promptLine('<bash-input>git status</bash-input>')).toBe('! git status')
  expect(promptLine('<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>')).toBe('')
  expect(promptLine('<pasted_content id="2bde"> help me come up with ideas </pasted_content> for videos')).toBe('help me come up with ideas for videos')
  expect(promptLine('<task-notification><status>failed</status><summary>Workflow "ship blockers"</summary></task-notification>')).toBe('Background task failed: Workflow "ship blockers"')
  expect(firstSentence('The blocker burndown is moving:\n- **Sign fonts:** finished.\n- **Still running:** the other four fixers.')).toBe('The blocker burndown is moving:')

  const at = (second: number) => `2026-10-02T21:00:${String(second).padStart(2, '0')}.000Z`
  const said = (uuid: string, second: number, text: string, stop: string | null = null, extra: object = {}) => ({ type: 'assistant', uuid, timestamp: at(second), message: { content: [{ type: 'text', text }], stop_reason: stop }, ...extra })
  const rows = [
    { type: 'user', uuid: 'u1', timestamp: at(0), message: { content: 'port the renderer' } },
    said('a1', 1, 'The port is under way and compiling so far.'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: at(2) },
    { type: 'user', uuid: 'u2', timestamp: at(3), isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation that ran out of context.' } },
    { type: 'attachment', uuid: 'q1', timestamp: at(4), attachment: { type: 'queued_command', prompt: 'stop, use Vulkan instead of Metal', commandMode: 'prompt', origin: { kind: 'human' } } },
    { type: 'attachment', uuid: 'q2', timestamp: at(5), attachment: { type: 'queued_command', prompt: 'a task finished', commandMode: 'task-notification' } },
    { type: 'assistant', uuid: 'a2', timestamp: at(6), message: { content: [null, { type: 'tool_use', id: 'toolu_send', name: 'SendUserFile', input: { files: ['/shots/vulkan.png'] } }] } },
    { type: 'user', uuid: 'r1', timestamp: at(7), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_send', content: '1 file delivered to user.' }] }, toolUseResult: { attachments: [{ path: '/shots/vulkan.png', isImage: true }, { path: '/notes.txt', isImage: false }] } },
    said('a3', 8, 'Switched the port to Vulkan as you asked.', 'end_turn'),
    { type: 'user', uuid: 'h1', timestamp: at(9), isMeta: true, message: { content: 'Stop hook feedback:\n[keep going until the goal is met]' } },
    said('a4', 10, 'Still paused, as you asked. Nothing is running.', 'end_turn'),
    said('a5', 11, 'No response requested.', 'stop_sequence', { message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }),
    { type: 'user', uuid: 'u3', timestamp: at(20), message: { content: 'and now the shaders' } },
    said('a6', 21, 'Starting on the shaders with the vertex stage.'),
    { type: 'user', uuid: 'u4', timestamp: at(22), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  ]
  const { events, sent } = eventsFromRows(rows.map(line => JSON.stringify(line)))
  expect(sent.get('toolu_send:0')).toBe('/shots/vulkan.png')
  const trail = folded(events.map(event => (event.t === 'shot' ? { ...event, file: '/kept.png', w: 10, h: 10 } : event)))
  expect(trail.items.map(item => [item.kind, item.line])).toEqual([
    ['ask', 'port the renderer'],
    ['step', 'The port is under way and compiling so far.'],
    ['compact', 'Context was compacted here'],
    // Typed while the turn ran: it is what the person asked next.
    ['ask', 'stop, use Vulkan instead of Metal'],
    ['shot', 'Sent you vulkan.png'],
    // Whatever was handed over is an output, picture or not.
    ['shot', 'Sent you notes.txt'],
    // The turn ended where the model stopped of its own accord; its replies to the hook are no part of it.
    ['done', 'Switched the port to Vulkan as you asked.'],
    ['ask', 'and now the shaders'],
    // Interrupted: what was said last is not how it came out.
    ['step', 'Starting on the shaders with the vertex stage.'],
  ])
  expect(trail.isOpen).toBe(false)
})

// ------------------------------------------------------------ the highlights

test('work is put to a model as a log divided into stretches, and its reply becomes one update to a stretch', () => {
  const trail = folded(WORKED)
  const job = nextJob(trail)
  expect(job?.ids).toEqual(['p1', 's1', 't4:shot', 's2'])
  expect(job?.prompt).toBe(
    [
      'THE PERSON ASKED:',
      'make the boss fight playable',
      'CLAUDE:',
      '[1]',
      '(before saying anything) [did: 1 read]',
      'said: The encounter script is read. Next the attack patterns. [did: Run the play-mode tests; 1 failed · 1 command · edited boss.cs]',
      'looked at a picture: phase2.png',
      'final answer: The boss fight is playable end to end. Two tests are still flaky.',
    ].join('\n'),
  )
  // The update is tied to where its stretch ended.
  expect(job?.slots.map(item => item.id)).toEqual(['s2'])

  const reply = [
    'Here is the feed:',
    '1|You asked for a playable boss fight. Claude added the attack patterns and it now plays end to end; two tests are still flaky.',
    '1|A second line for the same stretch is one too many.',
    '7|There is no seventh stretch.',
    'done|1|Boss fight playable from start to finish.',
    'done|7|A task in a stretch that is not there',
    'not an update',
  ].join('\n')
  const beats = parseBeats(reply, job!)
  expect(beats.map(beat => [beat.ref, beat.kind, beat.title])).toEqual([
    ['s2', 'summary', 'You asked for a playable boss fight. Claude added the attack patterns and it now plays end to end; two tests are still flaky.'],
    // A big task finished is its own line, for the list of things done.
    ['s2', 'built', 'Boss fight playable from start to finish'],
  ])
  expect(beats[0]).toMatchObject({ id: 'b:s2', anchor: 's2', at: 7000, turn: 1 })
  expect(beats[1]).toMatchObject({ id: 'd:s2:0', anchor: 's2', at: 7000 })

  const told = feedIn(trail, job!, beats)
  expect(told.feed).toHaveLength(2)
  // The feed keeps to the updates; the things done are a list of their own.
  const lines = (mode: 'feed' | 'done') => layout(told, { width: 58, picked: NOBODY, page: 0, mode, zone: 0 }).rows.flatMap(found => (found.kind === 'line' ? [[found.key, found.glyph, found.lines[0]]] : []))
  expect(lines('feed').map(([key]) => key)).toEqual(['b:s2', 't4:shot'])
  expect(lines('done')).toEqual([['d:s2:0', '✓', 'Boss fight playable from start to finish']])
  const task = layout(told, { width: 58, picked: NOBODY, page: 0, mode: 'done', zone: 0 }).rows.find(found => found.kind === 'line')
  expect(task?.kind === 'line' && [task.time, task.pad, task.hasMore]).toEqual(['00:00', 2, false])
  expect(layout(told, { width: 58, picked: NOBODY, page: 0, mode: 'done', zone: 0 }).foot).toBe('1 big task done · quiet since Thu Jan 1 00:00')
  expect(told.items.every(item => item.fed === true && item.more === undefined)).toBe(true)
  // Told once, it is not put to a model again.
  expect(nextJob(told)).toBeNull()
})

test('a question with no work in it needs no model, and a long run is told of a stretch at a time as it goes', () => {
  const chat = folded([
    { t: 'prompt', id: 'p1', at: 1000, text: 'how do I close the pane?' },
    { t: 'say', id: 's1', at: 2000, text: 'Type /trail close, or press its close mark.' },
    { t: 'end', at: 3000 },
  ])
  const job = nextJob(chat)
  expect(job?.prompt).toBe('')
  // The answer is all that happened, so it is the update as it stands.
  expect(job?.local?.map(beat => [beat.kind, beat.title, beat.anchor])).toEqual([['summary', 'Type /trail close, or press its close mark.', 's1']])
  expect(feedIn(chat, job!, []).feed).toHaveLength(1)

  let running = folded([{ t: 'prompt', id: 'p1', at: 1000, text: 'port the renderer' }])
  const step = (index: number) => {
    running = add(running, { t: 'say', id: `s${index}`, at: 2000 + index * 10, text: `Part ${index} of the renderer is ported and compiles.` })
    running = add(running, { t: 'tool', id: `t${index}`, at: 2005 + index * 10, tool: 'Bash', note: `Build part ${index}` })
  }
  for (let index = 0; index < 4; index++) {
    step(index)
    // Too little said yet to make a stretch; and the newest step, still gathering its work, is never told.
    expect(nextJob(running)).toBeNull()
  }
  step(4)
  const first = nextJob(running)!
  expect(first.ids).toEqual(['p1', 's0', 's1', 's2', 's3'])
  expect(first.slots.map(item => item.id)).toEqual(['s3'])
  running = feedIn(running, first, parseBeats('1|You asked for the renderer to be ported. Parts 0 to 3 are ported and compile.', first))
  expect(running.feed.map(beat => beat.ref)).toEqual(['s3'])
  // The run goes on: nothing more to tell until the next stretch is there, and then only that stretch.
  for (let index = 5; index < 8; index++) step(index)
  expect(nextJob(running)).toBeNull()
  step(8)
  const second = nextJob(running)!
  expect(second.ids).toEqual(['p1', 's4', 's5', 's6', 's7'])
  // What was asked is there for what the work is about, marked as told of already.
  expect(second.prompt.split('\n').slice(0, 4)).toEqual(['EARLIER THE PERSON ASKED (already told of: do not repeat it):', 'port the renderer', 'CLAUDE WENT ON:', '[1]'])
  // Steps a model gave nothing readable for are left as steps, not asked about again.
  expect(nextJob(running, new Set(['s4', 's5', 's6', 's7']))).toBeNull()

  // Read back whole, a long turn is one log of several stretches, each with its update.
  let long = folded([{ t: 'prompt', id: 'p1', at: 1000, text: 'port the renderer' }])
  for (let index = 0; index < 9; index++) long = add(add(long, { t: 'say', id: `s${index}`, at: 2000 + index * 10, text: `Part ${index} of the renderer is ported and compiles.` }), { t: 'tool', id: `t${index}`, at: 2005 + index * 10, tool: 'Bash', note: 'build' })
  long = add(long, { t: 'end', at: 5000 })
  const whole = nextJob(long)!
  expect(whole.slots.map(item => item.id)).toEqual(['s3', 's8'])
  expect(parseBeats('1|First half ported.\n2|Second half ported; all nine parts compile.', whole).map(beat => beat.ref)).toEqual(['s3', 's8'])
})

test('what the work leaves waiting on the person is listed apart, until a later log shows it done', () => {
  const RUN = 'Run `gh auth refresh -s workflow` so the packaging branch can be pushed.'
  const trail = folded([
    { t: 'prompt', id: 'p1', at: 1000, text: 'where do the branches stand?' },
    { t: 'say', id: 's1', at: 2000, text: 'PR 7 passed CI and is mergeable. The packaging branch waits on you running `gh auth refresh -s workflow`.' },
    { t: 'end', at: 3000 },
  ])
  // An answer that may leave something with the person is read by a model, though no work was done in it.
  const job = nextJob(trail)!
  expect(job.prompt).toContain('final answer: PR 7 passed CI')
  expect([job.isLatest, job.open, job.local]).toEqual([true, [], undefined])
  const reply = ['1|PR 7 passed CI and is mergeable; the packaging branch is held up.', `wait|1|${RUN}`, 'wait|9|There is no ninth stretch', 'clear|w1'].join('\n')
  const beats = parseBeats(reply, job)
  expect(beats.map(beat => [beat.id, beat.kind, beat.title, beat.anchor])).toEqual([
    ['b:s1', 'summary', 'PR 7 passed CI and is mergeable; the packaging branch is held up.', 's1'],
    ['w:s1:0', 'waiting', RUN, 's1'],
  ])
  // Nothing was named as still waiting, so there is nothing to clear.
  expect(parseCleared(reply, job)).toEqual([])
  let told = feedIn(trail, job, beats)
  const look = { width: 58, picked: NOBODY, page: 0, zone: 0 }
  const lines = (from: typeof told, mode: 'feed' | 'done' | 'questions') => layout(from, { ...look, mode }).rows.flatMap(found => (found.kind === 'line' ? [[found.key, found.glyph, found.tone, found.settles]] : []))
  // It is no update and no task done. It heads the feed, set apart above the latest of it, and has the view of what waits; in both, the way to say it is done.
  expect(layout(told, { ...look, mode: 'feed' }).rows.map(found => (found.kind === 'head' ? found.text : found.kind === 'line' ? found.key : found.kind))).toEqual(['Waiting on you', 'w:s1:0', 'day', 'b:s1'])
  expect(lines(told, 'feed')).toEqual([
    ['w:s1:0', '○', 'ask', 'w:s1:0'],
    ['b:s1', ' ', 'plain', undefined],
  ])
  expect(lines(told, 'done')).toEqual([])
  expect(lines(told, 'questions')).toEqual([['w:s1:0', '○', 'ask', 'w:s1:0']])
  expect(layout(told, { ...look, mode: 'feed' }).foot).toBe('1 update · 1 waiting on you · quiet since Thu Jan 1 00:00')

  // While it waits, every exchange is read by a model, and the log opens with what waits; said again, it is listed once.
  told = (
    [
      { t: 'prompt', id: 'p2', at: 4000, text: 'ok' },
      { t: 'say', id: 's2', at: 5000, text: 'Nothing has changed since.' },
      { t: 'end', at: 6000 },
    ] as TrailEvent[]
  ).reduce(add, told)
  const next = nextJob(told)!
  expect(next.prompt.startsWith(`STILL WAITING ON THE PERSON FROM BEFORE THIS LOG:\nw1: ${RUN}\n\nTHE PERSON ASKED:\nok`)).toBe(true)
  expect(next.open).toEqual(['w:s1:0'])
  told = feedIn(told, next, parseBeats(`1|Nothing changed.\nwait|1|${RUN.toLowerCase()}`, next), [])
  expect(waitsOf(told).map(beat => beat.id)).toEqual(['w:s1:0'])

  // A later log that shows it done clears it by its mark, as of that log's last step.
  told = (
    [
      { t: 'prompt', id: 'p3', at: 7000, text: 'I ran it' },
      { t: 'say', id: 's3', at: 8000, text: 'The packaging branch is pushed.' },
      { t: 'end', at: 9000 },
    ] as TrailEvent[]
  ).reduce(add, told)
  const last = nextJob(told)!
  const done = '1|You ran the command and Claude pushed the packaging branch.\nclear|w1\nclear|w7'
  expect(parseCleared(done, last)).toEqual(['w:s1:0'])
  const after = feedIn(told, last, parseBeats(done, last), parseCleared(done, last))
  expect(after.feed.find(beat => beat.id === 'w:s1:0')?.over).toBe(8000)
  expect(waitsOf(after)).toEqual([])
  expect(layout(after, { ...look, mode: 'questions' }).rows).toEqual([])
  expect(layout(after, { ...look, mode: 'feed' }).rows.some(found => found.kind === 'head')).toBe(false)
  expect(layout(after, { ...look, mode: 'feed' }).foot).toBe('3 updates · quiet since Thu Jan 1 00:00')

  // A log of history, with something already told after it, leaves nothing waiting: that was dealt with long since.
  const two = folded([
    { t: 'prompt', id: 'p1', at: 1000, text: 'which do you want?' },
    { t: 'say', id: 's1', at: 2000, text: 'Tell me which of the two you want.' },
    { t: 'end', at: 3000 },
    { t: 'prompt', id: 'p2', at: 4000, text: 'the first' },
    { t: 'say', id: 's2', at: 5000, text: 'Done with the first.' },
    { t: 'end', at: 6000 },
  ])
  const caughtUp = { ...two, items: two.items.map(item => (item.turn === 2 ? { ...item, fed: true as const } : item)) }
  const old = nextJob(caughtUp)!
  expect([old.ids, old.isLatest]).toEqual([['p1', 's1'], false])
  expect(waitsOf(feedIn(caughtUp, old, parseBeats('1|Claude asked which of the two you wanted.\nwait|1|Say which of the two you want', old)))).toEqual([])
})

test('a trail read back from its transcript keeps the updates and the answers only the mod knew', () => {
  const had = feedIn(folded(WORKED), nextJob(folded(WORKED))!, [{ id: 'b:s2', ref: 's2', turn: 1, at: 7000, kind: 'summary', title: 'The boss fight was made playable.', detail: '', anchor: 's2' }])
  const asked = add(add(had, { t: 'question', id: 'q1', at: 9500, text: 'Ship it?', options: ['Yes', 'No'] }), { t: 'answer', id: 'q1', at: 9600, text: 'Yes' })
  // The transcript has an earlier turn the mod never saw, and the same question, unanswered as far as it can tell.
  const built = folded([{ t: 'prompt', id: 'p0', at: 10, text: 'earlier' }, { t: 'say', id: 's0', at: 20, text: 'An earlier answer nobody summarised.' }, { t: 'end', at: 30 }, ...WORKED, { t: 'question', id: 'q1', at: 9500, text: 'Ship it?', options: ['Yes', 'No'] }])
  const kept = adopt(built, asked)

  expect(kept.feed.map(beat => [beat.title, beat.turn])).toEqual([['The boss fight was made playable.', 2]])
  expect(kept.items.filter(item => item.fed).map(item => item.id)).toEqual(['p1', 's1', 't4:shot', 's2'])
  expect(kept.questions).toMatchObject([{ id: 'q1', answer: 'Yes' }])
  // Asked to tell the latest again, the newest turns are left untold with all they said, and their updates stand.
  const again = adopt(built, asked, true)
  expect(again.items.filter(item => item.fed)).toEqual([])
  expect(again.items.find(item => item.id === 's2')?.more).toBe('The boss fight is playable end to end. Two tests are still flaky.')
  expect(again.feed.map(beat => beat.title)).toEqual(['The boss fight was made playable.'])
  expect(nextJob(again)?.isLatest).toBe(true)
  // A trail told before the mod looked for what waits on the person stays marked so until its latest is told again.
  const { sought: _, ...before } = asked
  expect([asked.sought, adopt(built, asked).sought, adopt(built, before).sought, adopt(built, before, true).sought, mended(JSON.parse(JSON.stringify(before)))?.sought]).toEqual([true, true, undefined, true, undefined])
  // Only the turn nobody summarised is left to tell.
  expect(nextJob(kept)?.ids).toEqual(['p0', 's0'])
})

test('each picture is asked about by what the conversation can tell it by, and the answer becomes its caption', () => {
  const trail = folded([
    { t: 'prompt', id: 'p1', at: Date.parse('2026-10-03T20:35:00Z'), text: 'the highlights view does not make sense as is, it should just be a short summary' },
    { t: 'shot', id: 'p1:1', at: Date.parse('2026-10-03T20:35:00Z'), anchor: 'p1', file: '/shots/a.png', w: 10, h: 10, label: 'You pasted a picture' },
    { t: 'shot', id: 'p1:2', at: Date.parse('2026-10-03T20:35:00Z'), anchor: 'p1', file: '/shots/b.png', w: 10, h: 10, label: 'You pasted a picture' },
    { t: 'shot', id: 't1', at: Date.parse('2026-10-03T20:40:00Z'), anchor: 't1', file: '/shots/c.png', w: 10, h: 10, label: 'pane.png' },
    { t: 'shot', id: 't2:0', at: Date.parse('2026-10-03T20:41:00Z'), anchor: 't2', file: '/shots/d.png', w: 10, h: 10, label: 'Sent you town.png' },
    { t: 'end', at: Date.parse('2026-10-03T20:42:00Z') },
  ])
  const job = captionJob(trail, at => new Date(at).toISOString().slice(11, 16))!
  expect(job.shots.map(shot => shot.id)).toEqual(['p1:1:shot', 'p1:2:shot', 't1:shot', 't2:0:shot'])
  expect(job.prompt.split('\n').filter(line => /^\d\./.test(line))).toEqual([
    '1. a picture the person pasted at 20:35, with their message beginning "the highlights view does not make sense as is, it should just be a short summary" (picture 1 of 2 in that message)',
    '2. a picture the person pasted at 20:35, with their message beginning "the highlights view does not make sense as is, it should just be a short summary" (picture 2 of 2 in that message)',
    '3. the picture pane.png, which you opened at 20:40',
    '4. the picture town.png, which you sent the person at 20:41',
  ])

  const told = parseCaptions(['1|Your screenshot of the highlights view. You said it does not make sense and should be a short summary.', '2|-', '3. The pane as drawn in a preview, to check the picture fits.', 'chatter'].join('\n'), job)
  expect(told).toEqual([
    { id: 'p1:1:shot', text: 'Your screenshot of the highlights view. You said it does not make sense and should be a short summary.' },
    // Not found, or not answered for: asked about, and not asked about again.
    { id: 'p1:2:shot', text: '' },
    { id: 't1:shot', text: 'The pane as drawn in a preview, to check the picture fits.' },
    { id: 't2:0:shot', text: '' },
  ])
  // An answer in no form at all leaves the pictures to be asked about another time.
  expect(parseCaptions('I cannot help with that.', job)).toEqual([])

  const captioned = told.reduce((now, one) => add(now, { t: 'caption', id: one.id, at: 1, text: one.text }), trail)
  expect(captioned.items.filter(item => item.kind === 'shot').map(item => item.shot?.note)).toEqual([told[0]!.text, '', told[2]!.text, ''])
  expect(captionJob(captioned, () => '')).toBeNull()
  // The caption reads under the picture's name, in either view; and it outlives the trail being read back from its transcript.
  const row = layout(captioned, { width: 58, picked: NOBODY, page: 0, mode: 'feed', zone: 0 }).rows.find(found => found.kind === 'line' && found.key === 'p1:1:shot')
  expect(row?.kind === 'line' && [row.lines[0], row.lines.slice(1).join(' ')]).toEqual(['You pasted a picture', told[0]!.text])
  expect(adopt(trail, captioned).items.find(item => item.id === 't1:shot')?.shot?.note).toBe(told[2]!.text)
  // Pictures from before the context was compacted are no longer the conversation's to describe.
  const compacted = add(trail, { t: 'compact', id: 'c1', at: Date.parse('2026-10-03T21:00:00Z') })
  expect(captionJob(compacted, () => '')).toBeNull()
})

test('whatever the work produced is an output: pictures, the videos a command made, files handed over, pages published', () => {
  expect(videosNamed('ffmpeg -y -i frames/%04d.png -o "out/film.mp4" && ls -la ./preview.webm ~/Movies/cut.mov notes.txt')).toEqual(['out/film.mp4', './preview.webm', '~/Movies/cut.mov'])
  expect(videosNamed('wrote /work/render/master_4k.mp4 (212 MB)\nwrote /work/render/master_4k.mp4')).toEqual(['/work/render/master_4k.mp4'])
  expect(videosNamed('npm test')).toEqual([])
  expect([outputType('/a/film.MP4'), outputType('/a/shot.png'), outputType('/a/report.pdf')]).toEqual(['video', 'image', 'file'])
  expect(publishedAt('Published /work/page/index.html at https://claude.ai/artifact/Wi2rD8 (Version 1) Icon: "notebook".')).toBe('https://claude.ai/artifact/Wi2rD8')
  expect(publishedAt('Quickstart. No page was published.')).toBeUndefined()
  expect(tag('/work/render/master_4k.mp4')).toBe(tag('/work/render/master_4k.mp4'))

  const trail = folded([
    { t: 'prompt', id: 'p1', at: 1000, text: 'render the film and publish its page' },
    { t: 'shot', id: 't1', at: 2000, anchor: 't1', file: '/shots/t1.png', w: 720, h: 450, label: 'still_20.png', full: '/shots/t1.full.png' },
    { t: 'say', id: 's1', at: 2500, text: 'The stills look right, so the full render is next.' },
    { t: 'shot', id: 'out:abc:1', at: 3000, anchor: 't2', file: '/shots/ql/film.mp4.png', w: 720, h: 405, label: 'film.mp4', full: '/work/out/film.mp4', type: 'video' },
    { t: 'shot', id: 't3:0', at: 4000, anchor: 't3', file: '', w: 0, h: 0, label: 'Sent you notes.pdf', full: '/work/notes.pdf', type: 'file' },
    { t: 'shot', id: 't4', at: 5000, anchor: 't4', file: '', w: 0, h: 0, label: 'Published index.html', full: 'https://claude.ai/artifact/Wi2rD8', type: 'link' },
    { t: 'end', at: 6000 },
  ])
  const page = layout(trail, { width: 58, picked: NOBODY, page: 0, mode: 'outputs', zone: 0 })
  // Only the outputs, newest first, each with the way to open it; every one that has a picture is drawn.
  expect(page.rows.flatMap(found => (found.kind === 'line' ? [[found.glyph, found.lines[0], found.open]] : []))).toEqual([
    ['↗', 'Published index.html', 'https://claude.ai/artifact/Wi2rD8'],
    ['▤', 'Sent you notes.pdf', '/work/notes.pdf'],
    ['▶', 'film.mp4', '/work/out/film.mp4'],
    ['▣', 'still_20.png', '/shots/t1.full.png'],
  ])
  expect(page.rows.flatMap(found => (found.kind === 'line' && found.picture ? [found.key] : []))).toEqual(['out:abc:1:shot', 't1:shot'])
  expect(page.foot).toBe('4 outputs · quiet since Thu Jan 1 00:00')

  // The outputs are Claude's own: a picture the person pasted, or a file from before the session that Claude only looked at, is not one.
  const shown = folded([
    { t: 'prompt', id: 'p1', at: 1000, text: 'does this look right to you?' },
    { t: 'shot', id: 'p1:0', at: 1000, anchor: 'p1', file: '/shots/pasted.png', w: 10, h: 10, label: 'You pasted a picture', from: 'person' },
    { t: 'shot', id: 't1', at: 2000, anchor: 't1', file: '/shots/ref.png', w: 10, h: 10, label: 'reference.png', from: 'earlier' },
    { t: 'shot', id: 't2', at: 3000, anchor: 't2', file: '/shots/mine.png', w: 10, h: 10, label: 'render.png' },
  ])
  const own = (mode: 'outputs' | 'feed') => layout(shown, { width: 58, picked: NOBODY, page: 0, mode, zone: 0 }).rows.flatMap(found => (found.kind === 'line' && found.open ? [found.lines[0]] : []))
  expect(own('outputs')).toEqual(['render.png'])
  expect(own('feed')).toEqual(['render.png', 'reference.png', 'You pasted a picture'])
  expect(layout(shown, { width: 58, picked: NOBODY, page: 0, mode: 'outputs', zone: 0 }).foot).toBe('1 output · working now')

  // Read back from a transcript: a video is the session's if it was written while the command that names it ran.
  const rows = [
    { type: 'user', uuid: 'u1', timestamp: '2026-10-02T21:00:00.000Z', cwd: '/work', message: { content: 'render it' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-10-02T21:00:01.000Z', cwd: '/work', message: { content: [{ type: 'tool_use', id: 'toolu_r', name: 'Bash', input: { command: './make_film.sh --out out/film.mp4' } }] } },
    { type: 'user', uuid: 'r1', timestamp: '2026-10-02T21:03:00.000Z', cwd: '/work', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_r', content: 'wrote out/film.mp4' }] } },
    { type: 'assistant', uuid: 'a2', timestamp: '2026-10-02T21:03:01.000Z', cwd: '/work', message: { content: [{ type: 'tool_use', id: 'toolu_s', name: 'SendUserFile', input: { files: ['/work/out/film.mp4'] } }] } },
    { type: 'user', uuid: 'r2', timestamp: '2026-10-02T21:03:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: '1 file delivered.' }] }, toolUseResult: { attachments: [{ path: '/work/out/film.mp4', isImage: false }] } },
    { type: 'assistant', uuid: 'a3', timestamp: '2026-10-02T21:03:03.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_p', name: 'Artifact', input: { action: 'publish', file_path: '/work/page/index.html' } }] } },
    { type: 'user', uuid: 'r3', timestamp: '2026-10-02T21:03:04.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_p', content: 'Published /work/page/index.html at https://claude.ai/artifact/Wi2rD8 (Version 1)' }] } },
  ]
  const { events, made, sent } = eventsFromRows(rows.map(line => JSON.stringify(line)))
  expect(made.get('out:toolu_r:/work/out/film.mp4')).toEqual({ path: '/work/out/film.mp4', from: Date.parse('2026-10-02T21:00:01.000Z'), to: Date.parse('2026-10-02T21:03:00.000Z') })
  expect(sent.get('toolu_s:0')).toBe('/work/out/film.mp4')
  // What Claude said as it sent a file is read back as that file's caption.
  const withSaid = eventsFromRows(rows.map(line => JSON.stringify(line.uuid === 'a2' ? { ...line, message: { content: [{ type: 'tool_use', id: 'toolu_s', name: 'SendUserFile', input: { files: ['/work/out/film.mp4'], caption: 'The finished film.' } }] } } : line))).events
  const read = folded(withSaid.map(event => (event.t === 'shot' && event.type !== 'link' ? { ...event, file: '/kept.png', w: 16, h: 9 } : event)))
  const sentPage = layout(read, { width: 58, picked: NOBODY, page: 0, mode: 'sent', zone: 0 })
  expect(sentPage.rows.flatMap(found => (found.kind === 'line' ? [[found.glyph, found.lines.join(' | '), found.open !== undefined, found.picture !== undefined]] : []))).toEqual([
    ['↗', 'Published index.html', true, false],
    ['▶', 'film.mp4 | The finished film.', true, true],
  ])
  expect(sentPage.foot).toBe('2 sent to you · working now')
  expect(events.flatMap(event => (event.t === 'shot' ? [[event.label, event.type, event.full]] : []))).toEqual([
    ['film.mp4', 'video', undefined],
    ['Sent you film.mp4', 'video', undefined],
    ['Published index.html', 'link', 'https://claude.ai/artifact/Wi2rD8'],
  ])
})

// ------------------------------------------------------------ questions

test('a question waits until the person answers it, in the pane or by simply saying something next', () => {
  const waiting = folded([...WORKED, { t: 'question', id: 'q1', at: 9500, text: 'Is this the garage where you put the letter H?', options: ['Yes', 'No', 'Not sure', 'Other', 'A fifth'] }])
  expect(waiting.questions).toMatchObject([{ id: 'q1', options: ['Yes', 'No', 'Not sure', 'Other'] }])
  expect(waiting.questions[0]?.answer).toBeUndefined()

  expect(add(waiting, { t: 'answer', id: 'q1', at: 9600, text: 'Yes' }).questions[0]).toMatchObject({ answer: 'Yes', answeredAt: 9600 })
  // A task finishing in the background is not the person speaking.
  expect(add(waiting, { t: 'prompt', id: 'n1', at: 9700, text: '<task-notification><summary>Build finished</summary></task-notification>' }).questions[0]?.answer).toBeUndefined()
  expect(add(waiting, { t: 'prompt', id: 'p2', at: 9800, text: 'yes that is the one, go ahead' }).questions[0]?.answer).toBe(ANSWERED_THERE)
  expect(add(waiting, { t: 'prompt', id: 'p2', at: 9800, text: paneAnswer('Is this the garage where you put the letter H?', 'No, the other one') }).questions[0]?.answer).toBe('No, the other one')
})

// ------------------------------------------------------------ the page

test('the page reads from the latest back, by the clock: questions waiting, then what each request came to, over what happened, over the request', () => {
  expect(wrap('one two three four five six', 9, 2)).toEqual(['one two', 'three…'])
  expect(wrap('short', 20, 3)).toEqual(['short'])
  expect(pictureBox(1440, 900, 50)).toEqual({ columns: 45, rows: 14 })
  expect(pictureBox(1600, 400, 50)).toEqual({ columns: 50, rows: 6 })
  expect(zoneOf('-1000\n')).toBe(-600)
  expect(zoneOf('+0530')).toBe(330)
  expect(zoneOf('PST')).toBeUndefined()

  const at = (time: string) => Date.parse(`2026-10-03T${time}Z`)
  let trail = folded([
    { t: 'prompt', id: 'p1', at: at('02:30:00'), text: 'make the boss fight playable end to end and show me screenshots as you go please' },
    { t: 'say', id: 's1', at: at('02:31:00'), text: 'The encounter script is read and the attack patterns are next.' },
    { t: 'tool', id: 't0', at: at('02:31:30'), tool: 'Bash', note: 'Run the play-mode tests' },
    { t: 'shot', id: 't1', at: at('02:32:00'), anchor: 't1', file: '/shots/a.png', w: 720, h: 450, label: 'a.png', full: '/shots/a.full.png' },
    { t: 'shot', id: 't2', at: at('02:32:05'), anchor: 't2', file: '/shots/b.png', w: 720, h: 450, label: 'b.png' },
    { t: 'say', id: 's2', at: at('02:39:00'), text: 'The boss fight is playable end to end.' },
    { t: 'end', at: at('02:40:00') },
    { t: 'prompt', id: 'p2', at: at('03:00:00'), text: 'now the victory cutscene' },
    { t: 'say', id: 's3', at: at('03:05:00'), text: 'The cutscene plays after the final blow lands.' },
    { t: 'tool', id: 't5', at: at('03:06:00'), tool: 'Bash', note: 'Play it through' },
  ])
  const look = { width: 48, picked: NOBODY, page: 0, zone: -600 }
  // Each row by what it is; a line that has its picture drawn says so.
  const kinds = (mode: 'feed' | 'steps') => layout(trail, { ...look, mode }).rows.map(found => (found.kind === 'line' ? found.key + (found.picture ? ' +picture' : '') : found.kind))

  // Every step, strictly from the latest back: a request sits under the work it set off.
  expect(kinds('steps')).toEqual(['day', 's3', 'p2', 's2', 't2:shot +picture', 't1:shot', 's1', 'p1'])
  const steps = layout(trail, { ...look, mode: 'steps' })
  expect(steps.rows[0]).toMatchObject({ kind: 'day', text: 'Fri Oct 2' })
  expect(steps.rows.flatMap(found => (found.kind === 'line' ? [found.time] : []))).toEqual(['17:05', '17:00', '16:39', '16:32', '16:32', '16:31', '16:30'])
  const first = steps.rows.find(found => found.kind === 'line' && found.key === 'p1')
  // How long the turn ran is said after what was asked, however long that is.
  expect(first?.kind === 'line' && [first.time, first.glyph, first.lines.length, first.lines.at(-1)?.endsWith('  (10m)'), first.tone]).toEqual(['16:30', '❯', 2, true, 'ask'])
  // Every entry has the same shape in every view: its mark, and its words set in by the mark's width under the first row.
  expect([...new Set(steps.rows.flatMap(found => (found.kind === 'line' ? [found.pad] : [])))]).toEqual([2])
  // Of two pictures taken one after the other the last is drawn; each entry says where its whole picture is.
  expect(steps.rows.flatMap(found => (found.kind === 'line' && found.open ? [found.open] : []))).toEqual(['/shots/b.png', '/shots/a.full.png'])
  expect(steps.foot).toBe('3 steps · working now')

  // The feed is the updates and the pictures, and nothing else: no requests, no steps but the latest still untold.
  expect(kinds('feed')).toEqual(['day', 's3', 't2:shot +picture', 't1:shot'])
  // The running request has said too little to be told yet; the finished one is what there is to tell.
  const job = nextJob(trail)!
  expect(job.ids).toEqual(['p1', 's1', 't1:shot', 't2:shot', 's2'])
  const update = 'You asked for the boss fight to be playable, with screenshots. Claude added the attack patterns and it now plays from the first blow to the last.'
  trail = feedIn(trail, job, [{ id: 'b:s2', ref: 's2', turn: 1, at: at('02:39:00'), kind: 'summary', title: update, detail: '', anchor: 's2' }])
  trail = add(trail, { t: 'question', id: 'q1', at: at('03:07:00'), text: 'Is this the ending you wanted?', options: ['Yes', 'No'], shot: { file: '/shots/q.png', w: 720, h: 450 } })
  // A question waiting is no part of the feed: it has a view of its own.
  expect(kinds('feed')).toEqual(['day', 's3', 'b:s2', 't2:shot +picture', 't1:shot'])
  const feed = layout(trail, { ...look, mode: 'feed' })
  // An update is read whole, with its time and no mark beside it; the step no update tells of yet is one dim line.
  const told = feed.rows.find(found => found.kind === 'line' && found.key === 'b:s2')
  expect(told?.kind === 'line' && [told.time, told.glyph, told.pad, told.tone, told.lines.join(' '), told.target.anchor]).toEqual(['16:39', ' ', 0, 'plain', update, 's2'])
  // An update is set across the pane, no line of it wider than the pane is.
  expect(told?.kind === 'line' && told.lines.every(text => text.length <= 48)).toBe(true)
  const now = feed.rows.find(found => found.kind === 'line' && found.key === 's3')
  expect(now?.kind === 'line' && [now.glyph, now.tone, now.work]).toEqual(['…', 'quiet', ''])
  expect(feed.rows.some(found => found.kind === 'question')).toBe(false)
  expect(feed.foot).toBe('1 update · 1 waiting on you · working now')
  const asking = layout(trail, { ...look, mode: 'questions' })
  expect(asking.rows.map(found => found.kind)).toEqual(['question'])
  const question = asking.rows[0]
  expect(question?.kind === 'question' && [question.lines, question.picture?.columns]).toEqual([['Is this the ending you wanted?'], 45])
  expect(asking.foot).toBe('1 waiting on you · working now')

  // Answered, the question is a thing that happened: told among the steps with what was said, and nothing waits.
  const after = add(trail, { t: 'answer', id: 'q1', at: at('03:08:00'), text: 'Yes' })
  const line = layout(after, { ...look, mode: 'steps' }).rows.find(found => found.kind === 'line' && found.key === 'q:q1')
  expect(line?.kind === 'line' && line.lines).toEqual(['Is this the ending you wanted?', 'You: Yes'])
  expect(layout(after, { ...look, mode: 'questions' }).rows).toEqual([])
  expect(layout(after, { ...look, mode: 'feed' }).rows.some(found => found.kind === 'line' && found.key === 'q:q1')).toBe(false)

  // An entry says nothing of a jump until one is asked for; then that it went, or why it did not.
  const gone = (jump?: string) => layout(trail, { ...look, mode: 'feed', picked: { id: 'b:s2', ...(jump === undefined ? {} : { jump }) } }).rows.find(found => found.kind === 'line' && found.key === 'b:s2')
  expect([gone(), gone(''), gone('none scrolls')].map(found => found?.kind === 'line' && found.note)).toEqual(['', 'the conversation is at this point now', "can't go there: none scrolls"])
  // A picture whose entry was last pressed is drawn, though it is not the last of its run.
  expect(layout(trail, { ...look, mode: 'feed', picked: { id: 't1:shot' } }).rows.filter(found => found.kind === 'line' && found.picture)).toHaveLength(2)
  // A request too long for its rows offers more, and shows all of itself once asked.
  const asked = (isOpen: boolean) => layout(trail, { ...look, mode: 'steps', picked: { id: 'p1', isOpen } }).rows.find(found => found.kind === 'line' && found.key === 'p1')
  const [short, whole] = [asked(false), asked(true)]
  expect(short?.kind === 'line' && [short.hasMore, short.isOpen]).toEqual([false, false])
  expect(whole?.kind === 'line' && whole.lines.join(' ')).toContain('show me screenshots as you go please')
})

test('a long trail pages from the newest back, every line once', () => {
  let trail = emptyTrail()
  for (let turn = 0; turn < 150; turn++) {
    trail = add(trail, { t: 'prompt', id: `p${turn}`, at: 1000 + turn * 100, text: `ask ${turn}` })
    trail = add(trail, { t: 'say', id: `s${turn}`, at: 1050 + turn * 100, text: `Answer number ${turn} is given here in full.` })
    trail = add(trail, { t: 'end', at: 1090 + turn * 100 })
  }
  const keysOf = (page: number) => layout(trail, { width: 58, picked: NOBODY, page, mode: 'steps', zone: 0 }).rows.flatMap(found => (found.kind === 'line' ? [found.key] : []))
  const first = layout(trail, { width: 58, picked: NOBODY, page: 0, mode: 'steps', zone: 0 })
  expect(keysOf(0).slice(0, 2)).toEqual(['s149', 'p149'])
  expect([first.later, first.earlier]).toEqual([0, 180])
  const seen = new Set([...keysOf(0), ...keysOf(1), ...keysOf(2), ...keysOf(3)])
  expect(seen.size).toBe(300)
  expect(keysOf(3).at(-1)).toBe('p0')
})

test('a jump tries the folded run a call sits in, then the row, then the tool call beside it, and stops at the first that moves', async () => {
  const folds = new Map([
    ['toolu_read', 'group-3'],
    ['toolu_beside', 'group-7'],
  ])
  expect(candidates({ anchor: 'row-uuid', alt: 'toolu_beside' }, folds)).toEqual(['row-uuid', 'group-7', 'toolu_beside'])
  expect(candidates({ anchor: 'toolu_read' }, folds)).toEqual(['group-3', 'toolu_read'])
  // An id is never tried twice.
  expect(candidates({ anchor: 'row-uuid', alt: 'row-uuid' }, new Map())).toEqual(['row-uuid'])

  const asked: string[] = []
  const scroll = (moves: (id: string) => string | undefined) => (id: string) => {
    asked.push(id)
    return Promise.resolve(moves(id))
  }
  expect(await reach(['a', 'b', 'c'], scroll(id => (id === 'b' ? undefined : 'no such row')))).toEqual({ why: '', tried: ['a=no such row', 'b=ok'] })
  expect(asked).toEqual(['a', 'b'])
  // Nothing the person did asked for it: no other row will fare better, so the reason is said at once.
  expect((await reach(['a', 'b'], scroll(() => 'not person-initiated'))).tried).toEqual(['a=not person-initiated'])
  expect((await reach(['a', 'b'], scroll(() => 'none scrolls'))).why).toBe('none scrolls')
  expect((await reach([], scroll(() => undefined))).why).toBe('no row is known for this line')
})

// ------------------------------------------------------------ the mod in the engine

test('a turn is recorded, its picture kept, and once it ends a model writes the update the pane shows', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, ran, asked, forked } = engine(on, '1|You asked for the login flow to work end to end. Claude added the session cookie and it now does; every test passes.', '1|The login form after sign-in, opened to check the session cookie held.')

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await appended($.session.append(ask('row-ask', 'make the login flow work end to end')))
  await appended($.session.append(say('row-say', 'The auth module is read. Now the session cookie.')))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_bash', command: 'npm test', description: 'Run the tests' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_read', file_path: '/work/shots/login.png' })
  // A subagent's rows are its own business.
  await appended($.session.append(row('response', 'row-agent', 'I am a subagent and should not be here.', 'agent-1')))

  // While the turn runs there is nothing to tell yet: the feed shows the latest step, the other view all of them.
  await clock.advance(1000)
  const early = await $.ui.mount(pane('terminal'))
  expect(await early.find({ type: 'Text', text: '… The auth module is read. Now the session cookie.' })).toBeDefined()
  expect(await early.find({ key: 'go:row-ask' })).toBeUndefined()
  await early.press({ key: 'tab:steps' })
  expect(await early.find({ type: 'Text', text: '❯ make the login flow work end to end' })).toBeDefined()
  expect(await early.find({ type: 'Text', text: /└ 1 command · 1 read/ })).toBeDefined()
  expect(await early.find({ key: 'go:row-agent' })).toBeUndefined()
  // Every entry has, beside its time, an arrow to its place in the conversation, the same in every view.
  expect((await early.find({ key: 'go:row-ask' }))?.props['label']).toBe('→')
  expect((await early.find({ key: 'go:row-say' }))?.props['label']).toBe('→')
  await early.press({ key: 'tab:feed' })
  await early.unmount()
  expect(asked).toHaveLength(0)

  await appended($.session.append(say('row-done', 'Login works end to end and every test passes.')))
  await $.turn.complete({ answer: 'Login works.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5000)

  // The picture was converted to a PNG of the mod's own beside the trail's file, and copied whole to open.
  const kept = `${DIR}/shots/toolu_read.png`
  expect(ran).toContainEqual(['/usr/bin/sips', '-s', 'format', 'png', '-Z', '720', '/work/shots/login.png', '--out', kept])
  expect(ran).toContainEqual(['/bin/cp', '/work/shots/login.png', `${DIR}/shots/toolu_read.full.png`])
  expect(JSON.parse(files.get(`${DIR}/trail.json`) ?? '{}')).toMatchObject({ v: 5, sid: SID })
  // The model was put the turn as a log, once.
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('THE PERSON ASKED:\nmake the login flow work end to end')
  expect(asked[0]).toContain('[did: Run the tests; 1 command · 1 read]')
  // The conversation was asked what its picture shows, once the turn had ended.
  expect(forked).toHaveLength(1)
  expect(forked[0]).toContain('1. the picture login.png, which you opened at ')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    // The feed is the update and the picture: what was asked and each step are the other view's.
    expect(await ui.find({ type: 'Text', text: 'You asked for the login flow to work end to end. Claude' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /it now does; every test$/ })).toBeDefined()
    // The update's time stands on the row above it, with the way to its place in the conversation.
    expect(await ui.find({ type: 'Text', text: /^\d\d:\d\d$/ })).toBeDefined()
    expect((await ui.find({ key: 'go:b:row-done' }))?.props['label']).toBe('→')
    expect(await ui.find({ key: 'go:row-ask' })).toBeUndefined()
    expect(await ui.find({ key: 'go:row-say' })).toBeUndefined()
    expect((await ui.find({ key: 'open:toolu_read:shot' }))?.props['label']).toBe('[open]')
    expect(await ui.find({ type: 'Text', text: /1 update · quiet since \w+ \w+ \d+ \d\d:\d\d$/ })).toBeDefined()
    expect(await ui.find({ key: 'open:toolu_read:shot' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /The login form after sign-in, opened to check the/ })).toBeDefined()
    const picture = await ui.find({ type: 'Image' })
    if (surface === 'terminal') {
      expect(picture?.props['source']).toEqual({ file: kept, format: 'png' })
      expect(picture?.props['columns']).toBe(45)
      expect(picture?.props['rows']).toBe(14)
    } else expect(picture).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount(pane('terminal'))
  // Opening a picture hands the whole of it to the person's viewer.
  await ui.press({ key: 'open:toolu_read:shot' })
  expect(ran).toContainEqual(['/usr/bin/open', `${DIR}/shots/toolu_read.full.png`])
  // Every step is one key away.
  await ui.press({ key: 'tab:steps' })
  expect(await ui.find({ type: 'Text', text: '• The auth module is read. Now the session cookie.' })).toBeDefined()
  expect(await ui.find({ key: 'go:b:row-done' })).toBeUndefined()
  await ui.press({ key: 'tab:feed' })
  expect(await ui.find({ type: 'Text', text: /^\s*can't go there: / })).toBeUndefined()
  // Going there asks the transcript to move; with none to move here, the entry says why rather than nothing.
  await ui.press({ key: 'go:b:row-done' })
  expect(await ui.find({ type: 'Text', text: /^\s*can't go there: / })).toBeDefined()
  await ui.unmount()
})

test('a video a command makes and a file Claude sends show among the outputs, each with its preview and the way to open it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { ran, made } = engine(on)

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await appended($.session.append(ask('row-ask', 'render the demo and send it to me')))
  // The render writes one video; the other it names was there before and is none of its making.
  made.add('/work/out/demo.mp4')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_render', command: './render.sh --out out/demo.mp4 --like /old/reference.mov', description: 'Render the demo' })
  await $.tool.call({ tool: 'SendUserFile', tool_use_id: 'toolu_send', files: ['/work/out/demo.mp4'], caption: 'The demo, start to finish: 40 seconds.', status: 'normal' })
  await clock.advance(1000)

  const rendered = ran.find(argv => argv[0] === '/usr/bin/qlmanage' && argv[6] === '/work/out/demo.mp4')
  expect(rendered?.slice(0, 5)).toEqual(['/usr/bin/qlmanage', '-t', '-s', '720', '-o'])
  expect(ran.some(argv => argv.includes('/old/reference.mov'))).toBe(false)

  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'tab:outputs' })
  expect((await ui.findAll({ type: 'Text', text: /demo\.mp4/ })).map(found => found.text)).toEqual(['▶ Sent you demo.mp4', '▶ demo.mp4'])
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /2 outputs · working now/ })).toBeDefined()
  // Opening the sent video plays the file itself, where it lies.
  await ui.press({ key: 'open:toolu_send:0:shot' })
  expect(ran).toContainEqual(['/usr/bin/open', '/work/out/demo.mp4'])
  // What Claude sent has a view of its own: the file by its name, what Claude said of it, its preview, the way to open it.
  await ui.press({ key: 'tab:sent' })
  expect((await ui.findAll({ type: 'Text', text: /demo\.mp4/ })).map(found => found.text)).toEqual(['▶ demo.mp4'])
  expect(await ui.find({ type: 'Text', text: /The demo, start to finish: 40 seconds\./ })).toBeDefined()
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /1 sent to you · working now/ })).toBeDefined()
  expect((await ui.find({ key: 'open:toolu_send:0:shot' }))?.props['label']).toBe('[open]')
  expect((await ui.find({ key: 'go:toolu_send:0:shot' }))?.props['label']).toBe('→')
  // The other views are a key away, and the one shown is marked.
  await ui.press({ key: 'tab:done' })
  expect(await ui.find({ type: 'Text', text: /No big task finished yet/ })).toBeDefined()
  expect(await ui.find({ key: 'tab:done' })).toBeUndefined()
  expect(await ui.find({ key: 'tab:outputs' })).toBeDefined()
  await ui.unmount()
})

test('a thing Claude says is waiting on the person gets the tab for what waits, and [done] takes it away', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, '1|You asked where the branches stand. PR 7 is mergeable; the packaging branch is held up.\nwait|1|Run `gh auth refresh -s workflow` so the packaging branch can be pushed', '')

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await appended($.session.append(ask('row-ask', 'where do the branches stand?')))
  await appended($.session.append(say('row-say', 'PR 7 is mergeable. The packaging branch waits on you running `gh auth refresh -s workflow`.')))
  await $.turn.complete({ answer: 'PR 7 is mergeable.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5000)

  const ui = await $.ui.mount(pane('terminal'))
  // It is the first thing the feed says, under a heading of its own, with the way to say it is done.
  expect(await ui.find({ type: 'Text', text: /^Waiting on you ─+$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '○ Run `gh auth refresh -s workflow` so the packaging' })).toBeDefined()
  expect((await ui.find({ key: 'settle:w:row-say:0' }))?.props['label']).toBe('[done]')
  // The tab for what waits is there too, with its count, and the line under the tabs says so.
  expect((await ui.find({ key: 'tab:questions' }))?.props['label']).toBe('1 waiting on you')
  expect(await ui.find({ type: 'Text', text: /^1 update · 1 waiting on you · quiet since / })).toBeDefined()
  await ui.press({ key: 'tab:questions' })
  expect(await ui.find({ type: 'Text', text: /^Waiting on you ─+$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '○ Run `gh auth refresh -s workflow` so the packaging' })).toBeDefined()
  expect((await ui.find({ key: 'settle:w:row-say:0' }))?.props['label']).toBe('[done]')
  expect((await ui.find({ key: 'go:w:row-say:0' }))?.props['label']).toBe('→')
  // Said to be done, it waits no more: the tab goes, and the pane is back at the feed.
  await ui.press({ key: 'settle:w:row-say:0' })
  expect(await ui.find({ key: 'tab:questions' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Waiting on you ─+$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^1 update · quiet since / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'You asked where the branches stand. PR 7 is mergeable;' })).toBeDefined()
  await ui.unmount()
})

test('Claude asks in the pane, under a picture; the answer pressed there goes back as the person’s next message', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { ran, sent } = engine(on)

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await appended($.session.append(ask('row-ask', 'label the garage door')))
  const told = await askInPane($, { tool_use_id: 'toolu_q', question: 'Is this the garage where you put the letter H?', options: ['Yes', 'No'], image: '/work/shots/garage.jpg' })
  expect(String(told.result)).toContain("The question is in the person's Trail pane.")
  expect((await askInPane($, { tool_use_id: 'toolu_bad' })).isError).toBe(true)
  await clock.advance(1000)
  expect(ran).toContainEqual(['/usr/bin/sips', '-s', 'format', 'png', '-Z', '720', '/work/shots/garage.jpg', '--out', `${DIR}/shots/q-toolu_q.png`])

  // The pane has turned to the question: a view of its own, there because something waits.
  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: /^ 1 waiting on you $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Claude is asking you/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Is this the garage where you put the letter H?' })).toBeDefined()
  expect((await ui.find({ type: 'Image' }))?.props['source']).toEqual({ file: `${DIR}/shots/q-toolu_q.png`, format: 'png' })
  expect(await ui.find({ key: 'say:toolu_q' })).toBeDefined()
  // The other views do not show it; its tab stays among theirs while it waits.
  await ui.press({ key: 'tab:feed' })
  expect(await ui.find({ type: 'Text', text: /Claude is asking you/ })).toBeUndefined()
  expect((await ui.find({ key: 'tab:questions' }))?.props['label']).toBe('1 waiting on you')
  await ui.press({ key: 'tab:questions' })

  await ui.press({ key: 'answer:toolu_q:0' })
  expect(sent).toEqual(['About your question in the Trail pane ("Is this the garage where you put the letter H?"): Yes'])
  // Answered, nothing waits: the tab is gone and the pane is back at the feed. What was said is among the steps.
  expect(await ui.find({ type: 'Text', text: /Claude is asking you/ })).toBeUndefined()
  expect(await ui.find({ key: 'tab:questions' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ highlights $/ })).toBeDefined()
  await ui.press({ key: 'tab:steps' })
  expect(await ui.find({ type: 'Text', text: /You: Yes/ })).toBeDefined()
  await ui.unmount()
})

test('a typed answer is sent too, and /trail leaves no line of its own; the trail survives the module starting again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { sent } = engine(on)

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await appended($.session.append(ask('row-ask', 'write the release notes')))
  await appended($.session.append(row('command', 'row-cmd', '<command-name>/trail</command-name><command-args></command-args>')))
  const answer = await $.command.run({ command: 'trail', args: '', origin: PERSON, presentation: { isFullscreen: true, columns: 200 } })
  expect(answer.text).toContain('Trail opened')
  expect((await $.command.run({ command: 'trail', args: 'nonsense', origin: PERSON, presentation: { isFullscreen: true, columns: 200 } })).text).toContain('Usage')
  await askInPane($, { tool_use_id: 'toolu_q', question: 'Which version number?' })
  await clock.advance(1000)

  // session.start is raised again when the module's code reloads; the trail is in the session's state.
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'tab:steps' })
  expect(await ui.find({ key: 'go:row-ask' })).toBeDefined()
  expect(await ui.find({ key: 'go:row-cmd' })).toBeUndefined()
  await ui.press({ key: 'tab:questions' })
  await ui.input({ key: 'say:toolu_q', text: '2.4.0, same as the tag' })
  expect(sent).toEqual(['About your question in the Trail pane ("Which version number?"): 2.4.0, same as the tag'])
  await ui.unmount()
})
