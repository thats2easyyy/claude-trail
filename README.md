# Trail

A Claude Code mod for coming back to a long conversation and not knowing what happened. It adds a pane on the right that tells the conversation as an activity feed, newest at the top.

- **highlights**: short updates written as the work goes, with the pictures between them
- **sent**: every file Claude sent you and every page it published, with a thumbnail and `[open]`
- **done**: the big tasks that were finished
- **outputs**: the screenshots, videos, files and links Claude made
- **every step**: one line per step, with what it ran, read and edited
- **waiting on you**: appears only while something waits on you. It lists what the work left for you to do (a command to run, a decision, something to try), each with `[done]`, and any question Claude asked in the pane, which you answer there

Hover an entry and press `→` to jump to that point in the conversation.

## Install

In a terminal session of Claude Code, type:

```
/plugin install trail --marketplace thats2easyyy/claude-trail
```

Answer `y` to add the marketplace, then press Enter to install it for yourself. It is active from then on, in every session.

## Use

| Type | What it does |
| --- | --- |
| `/trail` | Opens the pane |
| `/trail close` | Closes it, and keeps it closed in new sessions until you type `/trail` |
| `/trail rebuild` | Reads the whole conversation again from its transcript, and looks again at the latest of it for what is waiting on you |
| `/trail where` | Says where this session's trail is kept |

In a terminal at least 144 columns wide the pane opens by itself when a session starts. A conversation that began before you installed the mod is read back from its transcript the next time you resume it.

## What to know

- **macOS only.** Thumbnails and `[open]` use `sips`, `qlmanage` and `open`.
- **Pictures draw in Ghostty and kitty.** Other terminals show the file name and `[open]` instead.
- **It makes small model calls.** One after each turn writes the update, and one after a turn with pictures captions them. Both run on the session's own model.
- **Rebuilding needs Node 22.18 or later** on your `PATH`.
- **Its data stays on your machine**, in `~/.claude/trail/<session id>/`. Delete a folder there to forget that session.

## Working on it

```
claude plugin validate .
claude plugin test .
```

To run a working copy instead of the installed one, name its folder in `CLAUDE_CODE_PLUGIN_DIRS` (in the `env` block of `~/.claude/settings.json`) and uninstall the other.
