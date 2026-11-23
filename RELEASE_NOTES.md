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

## 0.32.0

- **Claude works as in Claude Code, in your git repositories**: Philibert used to start Claude with no system prompt beyond one line; in a folder that is a git repository, Claude now gets Claude Code's own, with its guidance on tools, git, tasks and answers. Elsewhere it still does not. Choose "Always" or "Never" in Settings → Discussions → Instructions, or for one project in its settings.
- **Your own instructions to Claude**: write instructions for every discussion in Settings → Discussions, and for one project in its settings; they are told to Claude after the system prompt. Changes apply to the discussions you start afterwards.
- **Fixed: the model line on every message**: with no model pinned, each message you sent repeated "Model: … (chosen by Claude Code)" in the discussion; it is said once, when Claude starts, above its reply instead of between an empty reply and a second one.
- **Fixed: gaps in the sides of Claude's replies**: the border of a reply broke under its header and above its spinner; it now runs unbroken.
- **Project settings stand apart**: Settings lists the general settings first, then each of your projects under its own name, so it is always clear whether a setting applies everywhere or to one project only.
- **One click to a project's settings**: the gear next to the folder at the top of the files panel opens the settings of that project; clicking the folder's path still changes the folder.
- **Only the projects you work in**: the projects listed are those with a discussion that is not archived, the one you are in first, marked "Current project"; a project whose discussions are all archived comes back once you bring one back.
- **Fixed: opening a discussion could move it to another folder**: a discussion Claude had not answered yet was saved in the folder you opened it from, instead of its own.
