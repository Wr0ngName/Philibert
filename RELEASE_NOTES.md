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

- **New: shell commands run in a sandbox**: in a sandboxed discussion, Claude's Bash and PowerShell commands can change files only inside the discussion's folder (and the folders you add in Settings), and reach only the sites you allow — the operating system enforces it. New discussions start sandboxed, except on Windows, where the sandbox first needs `/sandbox install` run once in Claude Code. Each discussion can leave the sandbox from its permissions menu (the shield), which turns red while it is out. On Linux the sandbox needs bubblewrap and socat installed; a discussion that cannot start its sandbox says so instead of running unsandboxed.
- **New: the approval card says how a command will run**: sandboxed (only this folder) or not (anything your account can, anywhere on this computer). Allowing every command of a shell beyond the sandbox — for an unsandboxed session, or saved for the project or everywhere — now takes a second click.
- **New: sites a sandboxed command asks for**: a command wanting to reach a new host asks "Network access: <host>", and can be allowed once, for the session or for the project. Settings → Discussions lists the sites allowed without asking, and other folders sandboxed commands may write to.
- **Fixed: "Allow for this session" allowed more than it said**: allowing one command for the session let every command of that tool run without asking, and revoking a session permission left it in force until the discussion restarted. A session permission now allows exactly what it names, and revoking it takes effect at once. Shell commands also offer "Allow this exact command this session".
- **Fixed: an approval button wrote out a whole command**: when Claude asked to run a command line holding a `*` of its own (a search pattern such as `[^/]*\.md$`), the option allowing only that command in the project wrote the command out again in full. It now reads "Allow this command of the line in project", as for any other command line.
