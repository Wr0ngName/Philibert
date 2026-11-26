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

## 0.32.5

- **Fixed: an approval button wrote out a whole command**: when Claude asked to run a command line holding a `*` of its own (a search pattern such as `[^/]*\.md$`), the option allowing only that command in the project wrote the command out again in full. It now reads "Allow this command of the line in project", as for any other command line.
