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

## 0.31.2

- **Project settings stand apart**: Settings lists the general settings first, then each of your projects under its own name, so it is always clear whether a setting applies everywhere or to one project only.
- **One click to a project's settings**: the gear next to the folder at the top of the files panel opens the settings of that project; clicking the folder's path still changes the folder.
- **Only the projects you work in**: the projects listed are those with a discussion that is not archived, the one you are in first, marked "Current project"; a project whose discussions are all archived comes back once you bring one back.
- **Fixed: opening a discussion could move it to another folder**: a discussion Claude had not answered yet was saved in the folder you opened it from, instead of its own.
