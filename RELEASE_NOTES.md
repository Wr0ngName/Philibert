# What's new in Philibert

What the release being prepared changes for the people who use it, in plain
words, so an update can be planned. Shown in the app when the update is
offered, and at the top of the release's page, which also lists every change
it is made of (git-cliff, cliff.toml).

The release being prepared only, under its version's heading: replace the
section when starting the next version, before its first candidate, which
shows it too. Earlier notes are in this file at their tag
(`git show v0.31.0:RELEASE_NOTES.md`). Each bullet on one line: the app shows
a line break inside a bullet as one.

## 0.32.3

- **Updates found while Philibert stays open**: it now checks for a new version every day, not only when it starts. Settings › About also has a "Check for updates" button, which says what it found: an update (offered by the banner, as before), none, one already downloading, or why it could not tell.
- **"Restart Now" asks first**: restarting to install an update stops whatever runs, so with a discussion still answering or a background task running it now asks, as quitting does. "Keep working" installs nothing, the banner stays for later; restarting saves your discussions before the update installs.
- **Fixed: Tool Details did not grow with the dialog**: resized, a tool's input and output now take the room the dialog is given, a long output most of it, each scrolling within itself. The same for a command's Task Details.
- **An agent's details say when it was last heard from**: as a discussion ends with "Last received", an agent's transcript now does too, once the agent has ended: the time of its last message, call or result.
- **Fixed: a background agent's work moved the discussion's "Last received"**: each call an agent made, and each update of a running task, counted as something arriving in the discussion. The time now moves only for what reaches the discussion itself: its replies, its own calls and results, and a task it started ending.
- **Fixed: a rewind did not really rewind the conversation**: Claude was still sent the prompt you rewound to, joined to your next message, and carried on with it. Claude now goes on from the turn before it, as if the turns from there on had not happened.
- **Rewound turns stay, greyed**: the turns a rewind goes back over are kept in the discussion, greyed and tagged "Rewound", under a divider saying where it went back to and which files it restored. Claude no longer has them; you can still read them. A rewind of files alone says what it restored in a note at the end of the discussion.
