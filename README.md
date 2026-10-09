# Trail

A Claude Code mod for coming back to a long conversation and not knowing what happened. It adds a pane on the right that tells the conversation as an activity feed, newest at the top, and puts anything waiting on you first.

```
 highlights   sent  done  outputs  every step
12 updates · 1 waiting on you · quiet since Fri Oct 9 16:13

Waiting on you ───────────────────────────────────

16:10  [done]
○ Run `gh auth refresh -s workflow` so the release
  branch can be pushed.

Fri Oct 9 ────────────────────────────────────────

16:10
The release build passed its checks and the pull
request is open. The installer branch is committed
but can't be pushed until you refresh your GitHub
login.

15:42  [open]
▣ settings-screen.png
  The settings screen after the layout fix, opened
  to check the spacing.
```

The pane has these views:

- **highlights**: short updates written as the work goes, with the pictures between them. What is waiting on you is pinned at the top
- **sent**: every file Claude sent you and every page it published, with a thumbnail and `[open]`
- **done**: the big tasks that were finished
- **outputs**: the screenshots, videos, files and links Claude made
- **every step**: one line per step, with what it ran, read and edited
- **waiting on you**: appears only while something waits on you. It lists what the work left for you to do (a command to run, a decision, something to try), each with `[done]`, and any question Claude asked in the pane, which you answer there

Hover an entry and press `→` to jump to that point in the conversation.

## Requirements

- Claude Code 2.1.290 or later
- macOS (thumbnails and `[open]` use `sips`, `qlmanage` and `open`)
- Node 22.18 or later on your `PATH`, used to read a conversation back from its transcript

Pictures draw in Ghostty and kitty. Other terminals show the file name and `[open]` instead.

## Install

In a terminal session of Claude Code, type:

```
/plugin install trail --marketplace thats2easyyy/claude-trail
```

Answer `y` to add the marketplace, then press Enter to install it for yourself. It is active from then on, in every session.

To get a newer version later, run `claude plugin update trail@claude-trail` in your shell and restart Claude Code.

## Use

| Type | What it does |
| --- | --- |
| `/trail` | Opens the pane |
| `/trail close` | Closes it, and keeps it closed in new sessions until you type `/trail` |
| `/trail off` | Stops the model calls in every session (see below). `/trail on` resumes them |
| `/trail rebuild` | Reads the whole conversation again from its transcript, and looks again at the latest of it for what is waiting on you |
| `/trail where` | Says where this session's trail is kept and how much disk the mod is using |

In a terminal at least 144 columns wide the pane opens by itself when a session starts. A conversation that began before you installed the mod is read back from its transcript the next time you resume it.

## What it costs

The mod makes small model calls on the session's own model: one after each turn to write the update, and one after a turn with pictures to caption them. Noting each step costs nothing.

`/trail off` stops the model calls everywhere while the steps are still noted. `/trail on` turns them back on and writes updates for what happened meanwhile.

## What it keeps on disk

Everything stays on your machine, in `~/.claude/trail/<session id>/`.

- **Per conversation:** its trail (a few kilobytes) and one small copy of each picture, 720 pixels wide. `[open]` opens the original file where it lies; if that file is gone or has changed since, it opens the small copy.
- **Full-size copies are deleted a week after they are made:** a picture that never was a file (one you pasted, a browser screenshot) is also copied whole, so there is something to open. After 7 days only its small copy remains.
- **Pictures are deleted after a week of quiet:** once a conversation has been idle for 7 days its pictures go. Resume it and the most recent ones are made again from its transcript.
- **Everything is deleted with the transcript:** a conversation's folder is removed once it has been idle for as long as Claude Code keeps transcripts (`cleanupPeriodDays` in your settings, 30 days by default).

The cleanup runs once a day, from whichever session starts first. Delete a folder there by hand to forget a conversation sooner.

## Working on it

```
claude plugin validate .
claude plugin test .
```

To run a working copy instead of the installed one, name its folder in `CLAUDE_CODE_PLUGIN_DIRS` (in the `env` block of `~/.claude/settings.json`) and uninstall the other.

## Licence

MIT. See [LICENSE](LICENSE).
