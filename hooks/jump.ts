// Which transcript row a line jumps to, and what to try when that row will not scroll.
// Pure: the scroll itself is handed in, so the order of tries can be tested without a transcript.

/** The engine's word for a scroll nothing the person did asked for: no other row will fare better. */
const NOT_ASKED = 'not person-initiated'

/**
 * The ids a line's row may answer to, likeliest first. A message's row is
 * drawn under its own id. A tool call's row is too, unless the transcript
 * folded it into a run of calls ("Read 3 files"): then the run's id is the
 * one that scrolls. After those, the same for the tool call beside the row.
 */
export const candidates = (target: { anchor: string; alt?: string }, groupsByCall: ReadonlyMap<string, string>): string[] => {
  const all = [groupsByCall.get(target.anchor), target.anchor, target.alt ? groupsByCall.get(target.alt) : undefined, target.alt]
  return all.filter((id, index): id is string => typeof id === 'string' && id !== '' && all.indexOf(id) === index)
}

export type Reached = {
  /** Why the transcript did not move; '' when it did. */
  why: string
  /** Each id tried and what came of it, for whoever is working on the mod. */
  tried: string[]
}

/** Tries each id in turn until one scrolls; `scroll` resolves why not, or undefined when it moved. */
export const reach = async (ids: readonly string[], scroll: (id: string) => Promise<string | undefined>): Promise<Reached> => {
  const tried: string[] = []
  let why = 'no row is known for this line'
  for (const id of ids) {
    const deny = await scroll(id)
    tried.push(`${id}=${deny ?? 'ok'}`)
    why = deny ?? ''
    if (why === '' || why === NOT_ASKED) break
  }
  return { why, tried }
}
