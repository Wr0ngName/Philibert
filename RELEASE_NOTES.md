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

## 0.32.2

- **See when a discussion runs on another system prompt**: a discussion keeps the system prompt it started with, whatever the settings say since. When your system prompt settings (Claude Code's prompt, your instructions, a project's own) no longer match a discussion's, a banner at its top says so. "Review" shows both side by side: continue as is, or start a new discussion on the new prompt when you are ready. Nothing is done to the discussion, so whatever runs in it can finish.
- **Legacy discussions**: a discussion started before this version is marked as such, with a button to open a new one, for the latest settings to apply.
- **Fixed: banner buttons shown as plain text**: the buttons of the warning banners (model switched, usage limit) have their color again.
