# Trail

A Claude Code mod for coming back to a long conversation and not knowing what happened. It adds a pane on the right that lists what was done, newest at the top, and keeps a separate list of anything waiting on you.

```
 1 waiting on you   highlights   outputs  every prompt
12 updates · 1 waiting on you · quiet since Fri Oct 9 16:13

Fri Oct 9 ────────────────────────────────────────

16:10
• Opened the release pull request
• Release build passing its checks

15:42
• Fixed the settings screen layout
• Found the spacing bug in the sidebar
```

The pane has these views:

- **highlights**: what was done, as a few short actions for each stretch of work, newest first
- **outputs**: the screenshots, videos, files and links Claude made or sent you, each by name with `[open]`. One you have not opened yet is in bold; once opened it is dimmed
- **every prompt**: each thing you asked, newest first
- **waiting on you**: appears only while something waits on you. It lists what the work left for you to do (a command to run, a decision, something to try), each with `[done]`. Under each is what you need to do it: the command, with `[copy]`, and any link, with `[open]`. A pull request named by number gets its link. Commands are only ever copied, never run. Questions Claude asked in the pane are here too, and you answer them there

Nothing is drawn in the pane and nothing is copied: a picture or a file is named, described in a line, and opened where it lies.

Hover an entry and press `→` to jump to that point in the conversation.

## Requirements

- Claude Code 2.1.290 or later
- macOS (`[open]` uses `open`)
- Node 22.18 or later on your `PATH`, used to read a conversation back from its transcript

## Install

In a terminal session of Claude Code, type:

```
/plugin install trail --marketplace thats2easyyy/claude-trail
```

Answer `y` to add the marketplace, then press Enter to install it for yourself. It is active from then on, in every session.

To get a newer version later, run `claude plugin update trail@claude-trail` in your shell and restart Claude Code. A session that is already open keeps the version it started with.

## Use

| Type | What it does |
| --- | --- |
| `/trail` | Opens the pane and writes the latest updates |
| `/trail close` | Closes it, and keeps it closed in new sessions until you type `/trail`. A closed pane uses no tokens |
| `/trail describe` | Asks the conversation what its recent pictures show (expensive: see what it costs) |
| `/trail rebuild` | Reads the whole conversation again from its transcript, and looks again at the latest of it for what is waiting on you |
| `/trail where` | Says where this session's trail is kept and how much disk the mod is using |

In a terminal at least 144 columns wide the pane opens by itself when a session starts. A conversation that began before you installed the mod is read back from its transcript the next time you resume it.

## What it costs

**Nothing while the pane is closed.** The mod notes each step as it happens, which is free, and asks no model for anything.

**While the pane is showing**, it makes one kind of model call, on the session's own model:

- **The update, after each turn.** One small call (around 2,000 tokens) writes the update, spots anything waiting on you, and describes the turn's pictures and files from what the conversation said about them.

That is the only call it makes by itself.

**When you open the pane later**, one call writes the latest of what you missed, including what is waiting on you. Anything further back stays unsummarised until you press `[summarise]`.

`/trail describe` asks the conversation itself what its recent pictures show. That gives a better description, but it re-reads the whole conversation, which in a long one is hundreds of thousands of tokens, so it only ever happens when you type it.

A session nobody is at (`claude -p`, a script) is ignored entirely.

## What it keeps on disk

One small file per conversation, in `~/.claude/trail/<session id>/`: its trail, a few kilobytes of text. No pictures or copies of files are kept.

A conversation's folder is removed once it has been idle for as long as Claude Code keeps transcripts (`cleanupPeriodDays` in your settings, 30 days by default). Versions before 0.5 kept copies of pictures there; those are removed once a conversation has been idle a day. The cleanup runs once a day, from whichever session starts first.

## Working on it

```
claude plugin validate .
claude plugin test .
```

To run a working copy instead of the installed one, name its folder in `CLAUDE_CODE_PLUGIN_DIRS` (in the `env` block of `~/.claude/settings.json`) and uninstall the other.

## Licence

MIT. See [LICENSE](LICENSE).
