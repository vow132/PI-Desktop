# Unreleased changes

- A stored hosted web-search record that cannot be replayed no longer fails every
  later request in that conversation: the message continues without search replay,
  so histories written before the contract change stay usable.

- Hosted web search now has a complete replay and estimation contract, including
  tool/Task continuation and restart recovery. Context rebuilding preserves
  system-prefix semantics, and structured local preparation failures no longer
  masquerade as retryable provider failures. Existing search histories need no migration.

- The Composer reasoning slider now moves smoothly to clicked or
  keyboard-selected levels, follows dragging immediately, and respects
  reduced-motion settings. Rapid clicks redirect the animation; failed saves
  restore the confirmed selection. Opening the menu no longer leaves a
  press-animation offset that jumps on the first selection.
- The reasoning slider's filled track covers the entire starting dot, so
  its left cap no longer leaves a gray half-dot exposed.
- Hovering a reasoning stop or its label highlights the corresponding label.
  Only unfilled dots brighten and enlarge; filled dots and the current thumb
  keep their appearance.

- Remote workspaces: the Projects section's + control now lists both a local
  project and a remote host. The 远程主机 entry opens a four-step wizard (choose
  method, fill in SSH host/port/user/credential, connect, pick a folder) that
  drives the existing SSH bootstrap. A registered remote project keeps its own
  identity in the sidebar, so a remote session never reuses a local project row
  or the global workspace root.

- The built-in file manager can browse, read, edit, save, create, rename and move
  files on a paired remote project through the additive project/files/* RACP
  operations. A host that predates this capability presents an explicit read-only
  view instead of silently falling back to the local filesystem.

- Remote hosts' file access now refuses cloud and CI credential material at every
  path segment (credentials.json, 	oken.json, .docker, .azure, gcloud,
  and similar), and the RACP server closes a connection rather than framing a
  reply larger than the negotiated frame limit.

- A remote session gains a terminal tab driven by the paired host's own pty.

- Platform status: the remote workspace flow is verified end to end on Windows.
  macOS installers are not produced by this change and still need a macOS run of
  pnpm --filter @pi-desktop/desktop run dist:mac.
