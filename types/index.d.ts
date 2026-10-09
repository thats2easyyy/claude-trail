/** The work done under one step: what was called, what was edited, what failed. */
export type Work = {
  cmds: number
  reads: number
  edits: number
  agents: number
  other: number
  fails: number
  /** Basenames written or edited, oldest first, a few at most. */
  files: string[]
  /** How many more files were edited than `files` names, and which (a few at most), so one edited twice counts once. */
  moreFiles: number
  extra: string[]
  /** What the latest call said it was doing. */
  now: string
  /** What the calls said they were doing, oldest first, a few at most: what a highlight is written from. */
  notes: string[]
}

/** What an output is: a picture (when nothing says otherwise), a video, some other file handed over, or a page published. */
export type OutputType = 'image' | 'video' | 'file' | 'link'

/**
 * Something the work produced or looked at, kept for the trail: a small PNG
 * of the mod's own to draw in the pane (a video's or a document's is its
 * preview; `file` is empty where there is none), its shape, and the whole
 * thing to open: a file's path, or a page's address. `note` is its caption,
 * what it shows and what it was about: absent until the conversation has been
 * asked, empty when it had nothing to say.
 */
export type Shot = { file: string; w: number; h: number; full?: string; note?: string; type?: OutputType; from?: Source }

/**
 * Where a picture came from when it is not Claude's own work: the `person`
 * pasted it, or it is a file from `earlier` than the session that Claude only
 * looked at. Absent, it is something the session made, sent or published.
 */
export type Source = 'person' | 'earlier'

/**
 * What a step is: the person's `ask`, a `step` the model narrated, the turn's
 * `done` line, a picture (`shot`), the engine's `recap` of where things
 * stand, or a mark where the context was compacted.
 */
export type ItemKind = 'ask' | 'step' | 'done' | 'shot' | 'recap' | 'compact'

/** One thing the conversation holds, as it happened: the layer the highlights are written from, and shown under them on request. */
export type Item = {
  /** Unique in the trail. */
  id: string
  /** The transcript row a click scrolls to: the row's id, or a tool call's. */
  anchor: string
  /** A tool call beside the row, tried when the row itself will not scroll. */
  alt?: string
  kind: ItemKind
  /** Milliseconds since the epoch. */
  at: number
  turn: number
  line: string
  /** More of what was said than its first sentence, kept until a highlight has been written from it. */
  more?: string
  work?: Work
  shot?: Shot
  /** On an ask: how long its turn ran, once it has ended. */
  ms?: number
  /** A highlight has been written that covers this. */
  fed?: true
}

/**
 * An update of the feed is a `summary`: a short account of a stretch of work.
 * A big task brought to a finish is `built`: it is what the list of things
 * done holds. The other kinds are from when the feed listed single things
 * that happened: something `built` or changed,
 * something `found` out, something `decided`, a `problem` met, one `fixed`,
 * something `checked` and how it came out, something `asked` of the person
 * (it waits on them), or a plain `note`. A `summary` is not one thing but
 * what a whole request came to, in a few sentences. Something `waiting` is
 * not a telling at all: it is a thing the work left for the person to do,
 * listed apart until it is done.
 */
export type BeatKind = 'summary' | 'built' | 'waiting' | 'found' | 'decided' | 'problem' | 'fixed' | 'checked' | 'asked' | 'note'

/** One update of the feed: what was done in a stretch of work and what came of it, in a few sentences, tied to the row where the stretch ended. */
export type Beat = {
  id: string
  /** The step it tells of. */
  ref: string
  turn: number
  /** When the step it tells of happened. */
  at: number
  kind: BeatKind
  /** The update's text. */
  title: string
  /** More of it, where an older kind kept a headline apart from its telling. */
  detail: string
  /** The transcript row a click scrolls to, and a tool call beside it. */
  anchor: string
  alt?: string
  /** Of something waiting on the person: when it stopped waiting, done or no longer needed. Absent while it waits. */
  over?: number
}

/**
 * Something Claude asked the person in the pane, with the picture it is about
 * when there is one. It waits there until answered; the answer goes back to
 * the conversation as the person's next message.
 */
export type Question = {
  /** The tool call that asked it, which is also the transcript row a click scrolls to. */
  id: string
  at: number
  text: string
  /** Answers offered as buttons; the person may always type their own. */
  options: string[]
  shot?: Shot
  answer?: string
  answeredAt?: number
}

export type Trail = {
  items: Item[]
  /** The feed's updates, oldest first. */
  feed: Beat[]
  questions: Question[]
  turn: number
  /** A turn is running. */
  isOpen: boolean
  /** The newest ask has seen no turn end yet, so work that follows is its own. */
  isFresh: boolean
  /** The latest tool call's id. */
  lastTool: string
  /** When the latest thing happened: where a turn that was never seen to end is taken to have stopped. */
  lastAt: number
  /** Tool calls already counted, newest last: an event seen twice counts once. */
  recent: string[]
}

/** The trail as kept in the session's state and in its file; `v` is the shape's, so one kept by older code is read back from the transcript instead. */
export type Saved = { v: 5; sid: string; trail: Trail }

/**
 * The entry the person last pressed an action of. `isOpen`: they asked for
 * more of it, and it shows all it has. `jump` is what came of going to it in
 * the conversation: absent until they ask, '' once it landed, else why it did
 * not.
 */
export type Picked = { id: string; jump?: string; isOpen?: boolean }

/**
 * What the pane lists: the feed of updates (its highlights), what Claude
 * sent the person (files it handed over, pages it published), the big tasks
 * done, everything the work produced, every step as it happened, or what
 * waits on the person (`questions`: the questions Claude put to them in the
 * pane and the things the work left for them to do), which is a view only
 * while something does.
 */
export type Mode = 'feed' | 'sent' | 'done' | 'outputs' | 'steps' | 'questions'

declare module 'claude-code' {
  interface PluginState {
    trail: {
      saved: Saved
      picked: Picked
      /** How many pages back from the newest lines the pane shows. */
      page: number
      mode: Mode
      /** How the writing of updates is going, when there is something to say about it. */
      status: string
    }
  }
}
