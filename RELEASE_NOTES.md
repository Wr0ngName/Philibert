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

## 0.32.1

- **Send a task to the background yourself**: while Claude waits on a command or an agent, its details now have "Send to background", next to "Stop task". Claude stops waiting and carries on; the task keeps running in the background tasks list. No need to wait for its timeout any more.
- **Details follow a command into the background**: when a command you are looking at moves to the background, by its timeout or by that button, its details switch to the task view by themselves, where its output is. You no longer have to close and reopen them.
- **Messages to an agent, shown until it reads them**: when Claude sends a message to an agent that is still working, the agent's details show it under its transcript ("1 sent · … reads it at its next step"), as the box above the composer does for yours. Once the agent reads it, it joins the agent's transcript.
- **Fixed: "compacting" shown several times**: a long compaction added a "compacting" line every 30 seconds; it now shows one.
