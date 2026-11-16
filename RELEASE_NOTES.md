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

## 0.31.0

- **Usage limits are waited out for up to a week**, and the wait survives closing the app. How long to wait is a setting (3 days by default). A continue that came due while the app was closed is not sent behind your back: the discussion is marked, with a notification, until you continue or dismiss it.
- **Background work stopped by a usage limit now resumes on its own** too, instead of the discussion waiting silently until you sent a message.
- **The end of a discussion says when Claude was last heard from**, with how many background tasks are still running, so a quiet discussion is not mistaken for a stuck one.
- **Work Claude takes up by itself shows as busy**, with its Stop button, when it goes on from one task to the next without pausing.
- **Tools have two homes in Settings**: Tools for those every project has, each on or off everywhere, and Project for one folder's own tools.
- **Signing in with your Claude account** accepts the newer kinds of login and no longer fails when the sign-in link arrives in pieces.
- **Lighter startup**: the app asks Claude Code for its models, commands and agents in one go, instead of starting up to four Claude Code processes.
- Deleting a discussion no longer removes part of Claude Code's own records of it; Claude Code clears them on its own schedule, as in a terminal.
- An agent's details no longer show notes meant only for Claude, and the Active / Archived switch in the history is tidier.
- Up-to-date building blocks: nothing the app ships has a known vulnerability.
