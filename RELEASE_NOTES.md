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

## 0.32.4

- **Fixed: a new discussion went to the archive while Claude started**: leaving a discussion just after its first message, before Claude Code had started its session, listed it as archived until Claude's answer came. It now stays with the active ones.
