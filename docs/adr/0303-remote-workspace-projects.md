# ADR 0303: Remote workspace — browse a paired SSH host and work on it

- Status: Accepted
- Date: 2026-09-22
- Decision: D460
- Extends: [ADR 0292](0292-ssh-remote-host-bootstrap.md) — the SSH bootstrap
  that makes a host pairable, and
  [ADR 0293](0293-ssh-password-authentication.md) — its password mode
- Related: [ADR 0286](0286-remote-host-desktop-kernel.md) (D449) — the desktop
  kernel whose backend router and namespaced session ids this reuses,
  ADR 0205 (D373),
  `02-architecture/05-remote-agent-control.md` §5.2 and §6.3,
  `03-runtime/19-remote-agent-control-protocol.md` §6.2,
  `06-delivery/07-remote-control-rollout.md` §2 R2b

## Context

ADR 0292 lets the desktop install and pair a `pi-host` on a machine the user
reaches over SSH, and ADR 0286's kernel routes a paired host's sessions through
`RemoteBackend` so a remote session renders like a local one. Pairing is
therefore solved. *Using* a paired host is not.

A user who installs `pi-host` on a cloud VM can see its sessions, but cannot
choose a folder on it. Every path the host accepts is an absolute path on the
remote machine — known for sure by nobody working on a headless box for the
first time — and the desktop offers no way to discover one. The work panel's
file tree, diff, and terminal all key off the *local* workspace, so a remote
session shows nothing to browse and no terminal to open. RACP already carries
the operations this needs: `project/browse` (directories under a path),
`project/register`, `project/list`, and `workspace/list|read|diff` and
`terminal/*`, all specified and implemented by `pi-host`. Nothing on the
desktop calls them.

Three constraints shape the answer:

- The host is authoritative about its own filesystem. It lists directories
  only, filters hidden entries, caps the page, and refuses a path outside the
  user's home. The desktop must not re-derive, cache, or widen any of that,
  and must surface a refusal rather than second-guessing it.
- `project/list` on the host returns `{ id, label, archived }` — never the
  absolute path — and is unreachable while the host is offline. A host's
  projects must stay visible when it is disconnected, which means the desktop
  remembers something.
- The renderer must stay transport-agnostic (spec §3.4). It already never
  parses the `remote:` session id; it must not learn a second one here.

## Decision

1. **The project menu is the entry point.** The 项目 section's `+` control
   opens a source menu with 打开文件夹 and 远程连接, the shape VS Code
   Remote - SSH and zcode already use. 远程连接 opens a wizard: choose a
   paired host, browse its directories, pick a folder, name the project,
   submit. Picking a folder is the whole remote explorer — one listing
   component, one flow, no second surface to keep in sync.

2. **Browsing is a forwarded `project/browse`, owner-only and unmodified.**
   The desktop sends the path exactly as the user navigated it and renders
   what comes back. It holds no allow-list and no local mirror. A relative
   path is rejected at the IPC boundary with `INVALID_ARGUMENT`, because a
   relative path is meaningless on the remote machine and `..` is how a caller
   would otherwise try to walk out of the browsable root; the host enforces the
   root regardless.

3. **The desktop remembers each host's project rows locally.**
   `<dataDir>/remote-projects.json` holds `(hostKey, hostProjectId, path,
   name, createdAt, updatedAt)`, written through the same `EncryptionPort`
   seam as `remote-hosts.json`. The record carries no credential — the device
   token lives in `remote-hosts.json` — so a missing keychain degrades to a
   `0600` plaintext row instead of failing the feature; that is the one
   deliberate difference from the host registry, which hard-fails because it
   guards a token.

   **Rust host-core owns no remote rows.** SQLite is the local authority and
   keeps its meaning: a remote project is not a local path and must not appear
   in a local query, a local archive, or a local backup. ADR 0286's boundary
   holds in the other direction too — the desktop's copy is a projection for
   listing, and the host remains the authority for what exists.

4. **A remote session's `projectPath` is the work panel's root.**
   `projectPath` is absolute on the remote machine; the Files, Review, and
   Terminal surfaces read it and pass the session id with every call. The
   global `workspace` — and every consumer of `workspace.path` — is untouched.
   A remote workspace never becomes "the" workspace, because a workspace that
   can be on another machine would change the meaning of every local cache,
   index, and dialog in the app for a capability most sessions do not use.

5. **Four workspace channels forward; three refuse.**
   `fsList`, `fsRead`, `fsReadImageDataUrl`, and `workspaceDiff` route to
   `workspace/list`, `workspace/read`, and `workspace/diff` when the payload
   names a `remote:` session. `fsReveal`, `fsOpen`, and `fsIndex` answer
   `CAPABILITY_UNAVAILABLE`: they act on *this* machine's shell, editor, and
   index, and silently reporting a path the user never chose is worse than a
   typed refusal the surface can explain. `sessionId` is an optional trailing
   argument on all four, so a local call is byte-for-byte what it was.

6. **Remote sessions join `session/list` in main, not in the renderer.**
   Each connected host contributes rows with `source: "remote"`, sorted with
   the local and native rows by `updatedAt`. Every surface that lists
   sessions — sidebar, search, tray, command palette — sees one list without
   knowing a remote host exists. A host that is offline contributes nothing,
   which is the pre-change behaviour. A failure in one host's `session/list`
   is caught per host so one unreachable machine cannot empty the list.

7. **A terminal is re-attached, never rebuilt.**
   `terminal/open` returns the host's `terminalId`. Keystrokes travel base64,
   output comes back on `terminal.output`, and an exit lands on
   `terminal.changed` and drops the local mapping. After a transport drop the
   same id is sent again, which makes the host return its bounded replay ring
   rather than spawn a second pty. Losing the id would orphan a process on a
   machine the user may not be able to reach.

8. **Capabilities gate the surface, read from `connection/initialize`.**
   `RacpRemoteHostClient` exposes `initialized()`, and the boot layer derives a
   host's `terminal` and `workspace` flags from it — `workspace` from
   `remoteHostProfile`, since `workspace/*` is part of that profile. A host
   without `node-pty` advertises `terminal: false` and the terminal action is
   hidden rather than offered and failed. A host that never completed a
   handshake advertises nothing, which is exactly what an offline host can
   serve.

## Invariants

- With no host paired, nothing changes: the source menu's 远程连接 opens a
  wizard that explains where hosts come from, every fs and diff call omits
  `sessionId` and runs the existing local handler, `session/list` returns what
  it did before, and no `remote:` id ever resolves.
- A host's browse bounds, hidden-name filter, and entry cap are the host's;
  the desktop neither widens nor caches them.
- No device token, SSH secret, or remote file content crosses into the
  renderer. `RemoteHostSummary` carries `hostKey`, `label`, `url`, connected
  state, transport, capabilities, and version — and never a credential.
- The renderer never parses the `remote:` prefix or a `terminalId`; both are
  resolved in Electron main.
- One host can never open, drive, or close a terminal that belongs to another:
  `open` validates the session's `hostKey` against its own, and input/resize
  resolve the owning host from the terminal id rather than trusting the caller.
- Losing or dropping a host unregisters its sessions and drops its terminals'
  listeners first, so no listener writes to a dead pipe.
- Rust host-core, its schema, and its queries are unchanged by this decision.

## Out of scope

- **WSL and Docker connection types.** The source menu lists SSH hosts only;
  the issue's screenshot shows the three-option end state, but WSL and Docker
  need their own descriptor, bootstrap, and security review, and none of them
  has a recorded request here.
- **The reverse tool relay** (`tools/advertise`, `tool/execute`) — still R2b
  work of its own, unrelated to folder browsing.
- **Provider configuration propagation over the SSH channel**, also still in
  R2b.
- **Remote projects as the global workspace.** Session-scoped is the decision;
  a global switch would need its own ADR and migration for the ~69
  `workspace.path` consumers.
- **A standalone Remote Explorer page.** The wizard's listing is the explorer;
  a second always-on surface duplicates state for no recorded ask.
- **A built-in interactive terminal for local sessions.** Unchanged from ADR
  0108: the local work panel still starts no pty and offers no terminal tab, and
  interactive shell work stays with the user's external terminal. What ships is
  the remote terminal, because the host already runs a pty — see the amendment
  below for its gating. A local one remains separate work.

## Amendment: the remote terminal ships in the renderer

Decision 7 named the work panel's Terminal action as the surface this feature
adds, and that surface now exists: `RemoteTerminalTab` is an xterm terminal
over the RACP `terminal/*` channels the host already served. This records what
landed and narrows two claims; nothing above is withdrawn.

- The tab is a singleton tool tab — `kind: "terminal"`, id `terminal` — in the
  work panel's tab kinds, and both its launcher entry and the tab itself are
  gated on the active session's `source === "remote"`. A local session gets
  neither, so ADR 0108's decision for local sessions stands exactly as
  recorded and E2E-058 keeps its scope: no local pty, no local terminal tab,
  external terminal for local interactive shell work.
- The transport is unchanged. The tab opens with `sessionId`, `cols`, `rows`,
  and the host's `terminalId`; keystrokes leave as base64
  (`sendRemoteTerminalInput`), host bytes are written to the surface from
  `remoteTerminalData`, `resizeRemoteTerminal` follows a `ResizeObserver` plus
  the fit addon, and unmount closes the host pty through
  `closeRemoteTerminal`. The `terminalId` stays a durable handle: a retry after
  a failed open re-attaches with the same id and gets the host's bounded replay
  ring, while a retry after a reported exit opens a new shell.
- xterm is now a renderer dependency of `@pi-desktop/desktop`
  (`@xterm/xterm`, `@xterm/addon-fit`), bundled by Vite into the renderer. No
  PTY native module is packaged locally, because the pty runs on the host;
  ADR 0108's removal of the *local* terminal dependency still holds.
- Capability derivation is unchanged: `RemoteHostCapabilities.terminal` comes
  from `connection/initialize`, so a host whose `pi-host` was built without
  `node-pty` still advertises `terminal: false`
  (E2E-REMOTE-HOST-terminal-replay).

## Alternatives considered

- **Reuse the local folder picker with a remote flag.** Rejected: the local
  picker enumerates the local filesystem through Electron's dialog, so it
  cannot list a remote path at all. Browsing has to go through the host.
- **Put remote projects in Rust host-core.** Rejected: a remote absolute path
  is not a local one, and storing it locally would make SQLite queries, the
  archive, and backups answer with paths this machine may never see. The
  desktop-side registry keeps the local store honest and needs no migration.
- **Mirror the host's project list in main with no local file.** Rejected:
  `project/list` has no path, so an offline host would show rows with no
  folder and no way to pick one. Remembering the path locally is what makes a
  host useful while it is disconnected.
- **Route fs calls through a single `workspace/*` channel with a mode
  argument.** Rejected: it would change one existing local contract instead of
  adding an optional routing field, and every local caller would move to the
  new shape for no gain.
- **Have the renderer merge remote sessions.** Rejected: the sidebar, search,
  tray, and command palette each list sessions, and four merges would drift.
  One merge in `sessionList` is one source of truth.
- **Rebuild the terminal on reconnect.** Rejected: a second pty is a second
  process on a remote machine, and the host already exposes the replay ring
  that makes re-attach the cheaper and safer path.

## Testing

`apps/desktop/test/remote-projects-registry.test.mjs` covers the registry's
upsert / list / `listForHost` / `get` / `remove` / `removeForHost`, the corrupt
and missing-file degradation, the sealed-record decrypt path, and a `hostKey`
containing `:`.

`apps/desktop/test/remote-host-browse.test.mjs` covers
`browse` → `project/browse` with the path passed through, `AGENT_UNAVAILABLE`
for a host that is not connected, `registerProject` → `project/register` with
the remembered path, `listProjects` merging live rows with remembered ones and
dropping rows the host no longer has, `listSessions` / `createSession` shape,
and a host-side `REMOTE_PATH_FORBIDDEN` surfacing with its code intact.

`apps/desktop/test/remote-backend-workspace.test.mjs` covers
`fsList` / `fsRead` / `fsReadImageDataUrl` / `workspaceDiff` forwarding with
the host session id derived from the namespaced one, the three refused
channels, and a local call still returning `ROUTE_LOCAL`.

`apps/desktop/test/remote-terminal.test.mjs` covers the call sequence, the
`terminal.output` → IPC event translation, re-attach by the same id after a
drop, exit dropping the mapping, and `closeAll` releasing the listener.

`apps/desktop/test/session-list-remote-merge.test.mjs` covers the merge order,
the `source: "remote"` row shape, and the empty-host case being identical to
the pre-change output.

`apps/desktop/test/project-create-remote-source.test.mjs` pins the source
menu's two entries, the wizard's call into the api surface, and the styles
that carry the token contract.

`apps/desktop/test/message-image-display.test.mjs` is amended for the widened
`fsReadImageDataUrl` signature, which is the one existing contract that moved.

Remaining remote suites — `remote-host-registry`,
`remote-host-connection`, `boot-remote-hosts`, `racp-remote-host-client`,
`pairing-boot-add-remove`, `rpc-lifecycle-contract`,
`settings-remote-hosts`, `settings-developer-only-destinations` — stay green
unmodified except for two fixtures that gained the adapter's `initialized()`
accessor and the host summary's new fields, which the tests now assert.

E2E-REMOTE-HOST-project-source-and-browse, E2E-REMOTE-HOST-workspace-reads, and E2E-REMOTE-HOST-terminal-replay in
`06-delivery/04-e2e-test-plan.md` require the approved Linux SSH harness and
are recorded as such; they have not run in this environment.

## Consequences

- A paired host becomes usable: pick a folder, and agent turns, files, diff,
  and a terminal run there, inside the session's own root.
- The local path is unchanged for the default install — an empty remote
  registry is a full no-op — so the blast radius of this decision is bounded
  by "the user paired a host".
- The desktop holds a second small encrypted-at-rest file. It is a projection,
  not an authority; deleting it loses listing convenience, never data.
- `fsReveal`, `fsOpen`, and `fsIndex` now refuse on a remote session instead
  of silently acting locally. That is a behaviour change for those three
  channels on remote sessions only, and it is the correct one: the alternative
  was reporting a path on the wrong machine.
- A future Wizard/Docker source has a clear insertion point — the source
  menu's list of hosts — without touching the browsing, session, or terminal
  seams.
