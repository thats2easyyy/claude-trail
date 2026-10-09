// Writes the highlights of a kept trail the way the mod does, but from outside a session, to read what a model
// makes of a past session and to tune the prompt:
//   node tools/digest.ts <dir holding trail.json> [model] [most stretches]
// Each stretch is one `claude -p` call. The trail.json is rewritten with the highlights in.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { feedIn, nextJob, parseBeats, SYSTEM } from '../hooks/digest.ts'
import { mended } from '../hooks/trail.ts'

const [where, model = 'haiku', most = '40', show = ''] = process.argv.slice(2)
if (!where) {
  console.error('usage: node tools/digest.ts <dir holding trail.json> [model] [most stretches] [log]')
  process.exit(2)
}
const path = join(where, 'trail.json')
const kept = JSON.parse(readFileSync(path, 'utf8')) as { v: 5; sid: string; trail: unknown }
let trail = mended(kept.trail)
if (!trail) {
  console.error(`${path} holds no trail`)
  process.exit(1)
}

const skipped = new Set<string>()
let calls = 0
for (let job = nextJob(trail, skipped); job && calls < Number(most); job = nextJob(trail, skipped)) {
  let beats = job.prompt ? [] : []
  if (job.prompt) {
    calls++
    if (show === 'log') console.error(`\n----- log ${calls} (${job.prompt.length} chars)\n${job.prompt}\n-----`)
    const reply = execFileSync('claude', ['-p', '--model', model, '--system-prompt', SYSTEM], { input: job.prompt, encoding: 'utf8', timeout: 180_000, maxBuffer: 1 << 24 })
    if (show === 'log') console.error(`----- reply\n${reply}`)
    beats = parseBeats(reply, job)
    if (beats.length === 0) {
      for (const id of job.ids) skipped.add(id)
      console.error(`unreadable reply: ${reply.slice(0, 200)}`)
      continue
    }
  }
  trail = feedIn(trail, job, beats)
  writeFileSync(path, JSON.stringify({ ...kept, trail }))
}
console.log(JSON.stringify({ calls, highlights: trail.feed.length, stepsLeft: trail.items.filter(item => !item.fed && (item.kind === 'step' || item.kind === 'done')).length }))
