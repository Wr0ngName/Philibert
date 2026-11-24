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
