// What of the mod's kept data is past keeping. Pure: the hooks module lists the folders and removes what this names.
//
// Each session has a folder: its trail (small) and its pictures (nearly all of the size). Three rules, each by age:
// a whole-size copy of a picture goes a week after it was made (the small copy stays, and is what opens then); a
// session's pictures all go once it has been idle a week, since a session picked up again has them made anew from
// its transcript; the whole folder goes when the transcript itself would, after the days Claude Code keeps one.

/** Days a session may be idle before its pictures are let go. */
export const PICTURES_DAYS = 7
/** Days a session's folder is kept when the person's settings do not say how long transcripts are. */
export const KEEP_DAYS = 30
const DAY_MS = 86_400_000
/** A session's folder is named by its id; nothing else in the mod's folder is ever removed. */
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A whole-size copy of a picture, as the mod names one beside its small copy. */
const WHOLE_COPY = /^[A-Za-z0-9_-]+\.full\.[A-Za-z0-9]+$/

export const isSession = (name: string): boolean => SESSION.test(name)

/** One folder in the mod's own: its name, when its trail was last written (0 when that is not known), whether it has pictures. */
export type Kept = { name: string; touchedAt: number; hasShots: boolean }

/** The days a session's folder is kept: as long as Claude Code keeps its transcript (`cleanupPeriodDays`), a month when that is not set. */
export const keepDays = (setting: unknown): number => (typeof setting === 'number' && Number.isFinite(setting) && setting >= 1 ? Math.floor(setting) : KEEP_DAYS)

/**
 * The folders to remove whole, and those to remove only the pictures of.
 * The session asking is never among them, nor is a folder whose age is not
 * known or whose name is not a session's.
 */
export const prunable = (kept: readonly Kept[], now: number, own: string, days: number): { folders: string[]; pictures: string[] } => {
  const folders: string[] = []
  const pictures: string[] = []
  for (const one of kept) {
    if (!SESSION.test(one.name) || one.name === own || one.touchedAt <= 0) continue
    const idle = (now - one.touchedAt) / DAY_MS
    if (idle >= days) folders.push(one.name)
    else if (idle >= Math.min(PICTURES_DAYS, days) && one.hasShots) pictures.push(one.name)
  }
  return { folders, pictures }
}

/**
 * The whole-size copies in one session's pictures that are past keeping: made
 * a week ago or more. Versions before 0.4 copied every picture whole, which
 * was most of what the mod kept; now only a picture that never was a file is
 * copied. Either way the small copy outlives it.
 */
export const staleCopies = (files: readonly { name: string; kind: string; mtimeMs: number }[], now: number): string[] =>
  files.filter(file => file.kind === 'file' && WHOLE_COPY.test(file.name) && file.mtimeMs > 0 && now - file.mtimeMs >= PICTURES_DAYS * DAY_MS).map(file => file.name)

/** A size in bytes as a person reads it: "143 MB". */
export const sized = (kilobytes: number): string => (kilobytes >= 1024 * 1024 ? (kilobytes / 1024 / 1024).toFixed(1) + ' GB' : kilobytes >= 1024 ? Math.round(kilobytes / 1024) + ' MB' : Math.max(0, Math.round(kilobytes)) + ' KB')
