import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "remote-file-view-test-"));
process.env.PI_DESKTOP_DATA_DIR = join(temporary, "data");
// Native Electron is an external boundary. All view lifecycle, sender
// authentication, runtime dispatch and adapter code below is production code.
const electron = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from "node:events";
  export const shell = {};
  export const Menu = {};
  export const systemPreferences = {};
  export const ipcMain = Object.assign(new EventEmitter(), {
    handlers: new Map(), handle(name, fn) { this.handlers.set(name, fn); },
  });
  export const session = { fromPartition() { return {
    webRequest: { onBeforeRequest() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
  }; } };
  export class BrowserWindow {}
  export class WebContentsView {
    static instances = [];
    constructor() {
      this.webContents = Object.assign(new EventEmitter(), {
        id: WebContentsView.instances.length + 1, closed: false, messages: [], loads: 0,
        isDestroyed() { return this.closed; },
        close() { this.closed = true; this.emit("destroyed"); },
        loadURL(url) { this.url = url; this.loads++; this.emit("did-finish-load"); return Promise.resolve(); },
        setWindowOpenHandler() {}, send(...args) { this.messages.push(args); },
      });
      WebContentsView.instances.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
  }
`)}`;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "electron") return { url: electron, shortCircuit: true };
  if (specifier === "@pi-desktop/plugin-sdk") return { url: new URL("../../../packages/plugin-sdk/src/index.ts", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
// Bundler supplies __dirname in production main; no real browser is started here.
globalThis.__dirname = join(root, "apps/desktop/electron/main");
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { PluginPanelHost } = await import("../electron/main/plugin-panel-host.ts");
const { PluginViewHost } = await import("../electron/main/plugin-view-host.ts");
const { RemoteFileViewService } = await import("../electron/main/remote/remote-file-view.ts");
const { WebContentsView, ipcMain } = await import("electron");

const pluginPath = join(root, "apps/desktop/resources/plugins/pi.file-manager");
const permissions = ["ui.view", "fs.read", "workspace.remote.read", "workspace.remote.write"];
const project = (id) => ({ id, hostKey: `host-${id}`, hostProjectId: "same-project-id", path: "/srv/project", name: id, createdAt: "", updatedAt: "" });
const entry = (path, isDirectory = false) => ({ name: posix.basename(path), path, isDirectory, size: 1, mtimeMs: 1 });

function fakeTransport() {
  const projects = new Map(["A", "B"].map((id) => [id, project(id)]));
  const hosts = new Map(["A", "B"].map((id) => [id, { hostKey: `host-${id}`, connected: true, capabilities: { projectFiles: { version: 1, read: true, write: true } } }]));
  const files = new Map(["A", "B"].map((id) => [id, new Map([["same.txt", { text: id, version: `${id}-1`, size: 1, mtimeMs: 1 }]])]));
  const calls = [];
  let clock = 1;
  const boot = {
    role: "owner", error: null, pending: null,
    getProject: (id) => projects.get(id),
    list: async () => [...hosts.values()],
    async fileOperation(id, op, input) {
      calls.push({ id, op, input });
      if (boot.pending) await boot.pending;
      if (boot.error) throw Object.assign(new Error("never echo ssh://user:secret@host"), { code: boot.error });
      const tree = files.get(id);
      const mutations = ["write", "create", "rename", "move"];
      if (mutations.includes(op) && boot.role !== "owner") throw Object.assign(new Error("owner required"), { code: "FORBIDDEN" });
      const metadata = tree.get(input.path);
      if (op === "list") return { ok: true, path: input.path, entries: [...tree.keys()].map((path) => entry(path)), truncated: false, ignoreActive: false };
      if (op === "read") return { ok: true, path: input.path, kind: "text", ...metadata, eol: "lf", bom: false };
      if (op === "write") {
        if (input.expectedVersion !== metadata.version) throw Object.assign(new Error("conflict"), { code: "CONFLICT" });
        const next = { text: input.text, version: `${id}-${++clock}`, size: Buffer.byteLength(input.text), mtimeMs: clock };
        tree.set(input.path, next);
        return { ok: true, path: input.path, version: next.version, mtimeMs: next.mtimeMs, size: next.size };
      }
      if (op === "search") return { ok: true, matches: [entry("same.txt")], truncated: true, cursor: "1" };
      const target = op === "create" ? posix.join(input.parent, input.name) : op === "rename" ? posix.join(posix.dirname(input.path), input.newName) : posix.join(input.toDir, posix.basename(input.from));
      if (op !== "create") tree.delete(input.path ?? input.from);
      tree.set(target, { text: "", version: "new", size: 0, mtimeMs: ++clock });
      return { ok: true, entry: entry(target, input.isDirectory) };
    },
  };
  return { boot, projects, hosts, files, calls };
}

async function harness(t) {
  const transport = fakeTransport();
  const viewHost = new PluginViewHost();
  const children = [];
  viewHost.setWindow({ isDestroyed: () => false, contentView: {
    children, addChildView: (view) => children.push(view), removeChildView: (view) => children.splice(children.indexOf(view), 1),
  } });
  const adapter = new RemoteFileViewService((id) => viewHost.bindingForSender(id), () => transport.boot);
  viewHost.onDestroy = (id) => adapter.release(id);
  const local = join(temporary, `local-${WebContentsView.instances.length}`);
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, "same.txt"), "local-marker");
  let localCalls = 0;
  const runtime = new PluginRuntime({
    hostEntry: join(root, "apps/desktop/electron/main/plugin-host-process.mjs"),
    spawnProcess: ({ entry: hostEntry }) => {
      const child = fork(hostEntry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return { postMessage: (message) => { if (child.connected) child.send(message); },
        onMessage: (fn) => child.on("message", fn), onExit: (fn) => child.on("exit", (code) => fn(code ?? 0)), kill: () => child.kill() };
    },
    getWorkspacePath: () => { localCalls++; return local; },
    remoteFileView: (input) => adapter.intercept(input),
    onPluginUnload: (id) => viewHost.closePlugin(id),
  });
  const panelHost = new PluginPanelHost((...args) => runtime.invokePanelBridge(...args));
  panelHost.addSenderResolver((id) => viewHost.pluginIdForSender(id));
  await runtime.loadFromPath(pluginPath, permissions);
  t.after(async () => { await runtime.unload("pi.file-manager"); viewHost.dispose(); adapter.dispose(); });
  const open = (id) => {
    viewHost.open({ pluginId: "pi.file-manager", viewId: "manager", remoteProjectId: id,
      workspaceFiles: true, locale: "en", theme: "light", htmlPath: join(pluginPath, "views/index.html") });
    viewHost.setVisible("pi.file-manager", "manager", true);
    return children[0].webContents;
  };
  const call = (wc, channel, payload = {}) => ipcMain.handlers.get("pi-plugin-panel-invoke")({ sender: wc }, channel, payload);
  return { ...transport, runtime, adapter, viewHost, open, call, local, localCalls: () => localCalls };
}

test("real view bridge user path: hello, list, read, save, create, rename and move", async (t) => {
  const h = await harness(t);
  const wc = h.open("A");
  const hello = await h.call(wc, "fm.hello");
  assert.equal(hello.ok, true);
  assert.equal(hello.root.path, "/srv/project");
  assert.equal(hello.root.projectId, "A");
  assert.equal(hello.limits.maxWriteBytes, 131072);
  assert.equal(hello.prefs.splitRatio, 0.32);
  assert.deepEqual(hello.prefs.projectRoots, {});
  assert.equal((await h.call(wc, "fm.list")).entries[0].path, "same.txt");
  const read = await h.call(wc, "fm.read", { path: "same.txt" });
  assert.equal(read.text, "A");
  assert.equal(read.version, undefined);
  assert.equal((await h.call(wc, "fm.write", { path: "same.txt", text: "edited", expectedMtimeMs: read.mtimeMs, expectedSize: read.size, projectId: "B" })).ok, true);
  assert.equal(h.calls.at(-1).input.expectedVersion, "A-1");
  assert.equal(h.files.get("A").get("same.txt").text, "edited");
  assert.equal(h.files.get("B").get("same.txt").text, "B");
  assert.equal((await h.call(wc, "fm.create", { parent: "", name: "new.txt", isDirectory: false })).entry.path, "new.txt");
  assert.equal((await h.call(wc, "fm.rename", { path: "new.txt", newName: "renamed.txt" })).entry.path, "renamed.txt");
  assert.equal((await h.call(wc, "fm.move", { from: "renamed.txt", toDir: "folder" })).entry.path, "folder/renamed.txt");
  const search = await h.call(wc, "fm.search", { query: "same" });
  assert.equal(search.nextCursor, "1");
  assert.equal(search.done, false);
  const ids = h.calls.filter((call) => call.input.requestId).map((call) => call.input.requestId);
  assert.equal(new Set(ids).size, 4);
  assert.equal(h.localCalls(), 0);
  assert.equal(readFileSync(join(h.local, "same.txt"), "utf8"), "local-marker");
});

test("project A/B with identical POSIX roots retain separate editor pages and revision caches", async (t) => {
  const h = await harness(t);
  const a = h.open("A");
  await h.call(a, "fm.read", { path: "same.txt" });
  a.unsavedBuffer = "unsaved A";
  const b = h.open("B");
  assert.notEqual(a.id, b.id);
  assert.equal((await h.call(a, "fm.write", { path: "same.txt", text: "wrong" })).code, "STALE_CONTEXT");
  // The bundle polls workspace.get while hidden. A stable descriptor must not
  // become null/local and trigger its editor-reset callback.
  assert.equal((await h.call(a, "workspace.get")).projectId, "A");
  assert.equal((await h.call(b, "fm.write", { path: "same.txt", text: "no read" })).code, "READ_ONLY");
  assert.equal((await h.call(b, "fm.read", { path: "same.txt" })).text, "B");
  assert.equal((await h.call(b, "fm.write", { path: "same.txt", text: "B edit" })).ok, true);
  assert.equal(h.open("A"), a);
  assert.equal(a.unsavedBuffer, "unsaved A");
  assert.equal(a.loads, 1);
  assert.equal((await h.call(a, "fm.write", { path: "same.txt", text: a.unsavedBuffer })).ok, true);
  assert.equal(h.calls.at(-1).input.expectedVersion, "A-1");
  h.viewHost.broadcast("workspace:changed", { path: h.local });
  assert.equal(a.messages.some(([channel]) => channel.endsWith("workspace:changed")), false);
  await assert.rejects(h.call({ id: 999999 }, "fm.read", { path: "same.txt" }), /invalid panel invoker/);
});

test("permissions, unsupported hosts, offline state and remote-only channels never reach local files", async (t) => {
  const h = await harness(t);
  const a = h.open("A");
  const loaded = h.runtime.getLoaded("pi.file-manager");
  loaded.permissions.delete("workspace.remote.read");
  assert.equal((await h.call(a, "fm.list")).code, "PERMISSION_DENIED");
  loaded.permissions.add("workspace.remote.read");
  loaded.permissions.delete("workspace.remote.write");
  assert.equal((await h.call(a, "fm.create", { name: "x", isDirectory: false })).code, "PERMISSION_DENIED");
  loaded.permissions.add("workspace.remote.write");
  const contribution = loaded.manifest.contributes.views[0];
  const declared = contribution.workspaceFiles;
  delete contribution.workspaceFiles;
  assert.equal((await h.call(a, "fm.list")).code, "PERMISSION_DENIED");
  contribution.workspaceFiles = declared;
  h.hosts.get("A").capabilities = {};
  assert.equal((await h.call(a, "fm.hello")).code, "UNSUPPORTED");
  h.hosts.get("A").connected = false;
  assert.equal((await h.call(a, "fm.read", { path: "same.txt" })).code, "OFFLINE");
  for (const channel of ["fm.sqlite.open", "fs.openDefault", "fs.reveal", "fs.readText", "fs.writeText", "unknown.read"]) {
    assert.equal((await h.call(a, channel, { path: "same.txt" })).code, "UNSUPPORTED");
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.localCalls(), 0);
});

test("path escapes/external flags are refused and settings cannot choose a project or root", async (t) => {
  const h = await harness(t);
  const a = h.open("A");
  for (const path of ["../same.txt", "sub/../../same.txt", "/srv/project-other/same.txt", "C:\\same.txt", "file:///etc/passwd"]) {
    assert.equal((await h.call(a, "fm.read", { path })).ok, false);
  }
  assert.equal((await h.call(a, "fm.read", { path: "same.txt", external: true })).code, "OUTSIDE_ROOT");
  assert.equal(h.calls.length, 0);
  const prefs = await h.call(a, "fm.prefs.set", { partial: { mdPreview: true, projectRoots: { "p:A": h.local }, projectId: "B" } });
  assert.equal(prefs.ok, true);
  assert.equal(prefs.prefs.mdPreview, true);
  assert.deepEqual(prefs.prefs.projectRoots, {});
  assert.equal((await h.call(a, "fm.prefs.get")).prefs.mdPreview, true);
  assert.equal(h.localCalls(), 0);
  assert.equal((await h.call(a, "fm.read", { path: "/srv/project/same.txt" })).text, "A");
  assert.equal(h.calls.at(-1).input.path, "same.txt");
});

test("opaque versions block stale/force writes, role denial, timeout replay and cache reuse after rename", async (t) => {
  const h = await harness(t);
  const a = h.open("A");
  await h.call(a, "fm.read", { path: "same.txt" });
  assert.equal((await h.call(a, "fm.write", { path: "same.txt", text: "bad", expectedSize: 999 })).code, "CONFLICT");
  assert.equal(h.calls.filter((call) => call.op === "write").length, 0);
  h.files.get("A").get("same.txt").version = "external-change";
  assert.equal((await h.call(a, "fm.write", { path: "same.txt", text: "bad", force: true })).code, "CONFLICT");
  assert.equal((await h.call(a, "fm.write", { path: "same.txt", text: "force" })).code, "READ_ONLY");
  await h.call(a, "fm.read", { path: "same.txt" });
  h.boot.role = "observer";
  assert.equal((await h.call(a, "fm.write", { path: "same.txt", text: "observer" })).code, "FORBIDDEN");
  h.boot.role = "owner";
  await h.call(a, "fm.read", { path: "same.txt" });
  h.boot.error = "TIMEOUT";
  const before = h.calls.length;
  const result = await h.call(a, "fm.write", { path: "same.txt", text: "timeout" });
  assert.equal(result.code, "OUTCOME_UNKNOWN");
  assert.match(result.message, /Reload before retrying/);
  assert.doesNotMatch(result.message, /secret|ssh/);
  assert.equal(h.calls.length, before + 1);
  h.boot.error = null;
  assert.equal((await h.call(a, "fm.write", { path: "same.txt", text: "retry" })).code, "READ_ONLY");
  await h.call(a, "fm.read", { path: "same.txt" });
  await h.call(a, "fm.rename", { path: "same.txt", newName: "moved.txt" });
  assert.equal((await h.call(a, "fm.write", { path: "moved.txt", text: "old buffer" })).code, "READ_ONLY");
  assert.equal(h.localCalls(), 0);
});

test("stale in-flight replies are discarded after hide/restore and unload cleans sender authority", async (t) => {
  const h = await harness(t);
  const a = h.open("A");
  let release;
  h.boot.pending = new Promise((resolve) => { release = resolve; });
  const pending = h.call(a, "fm.read", { path: "same.txt" });
  await new Promise(setImmediate);
  h.open("B");
  h.open("A");
  release();
  assert.equal((await pending).code, "STALE_CONTEXT");
  h.boot.pending = null;
  assert.equal((await h.call(a, "fm.write", { path: "same.txt", text: "stale" })).code, "READ_ONLY");
  await h.runtime.unload("pi.file-manager");
  assert.equal(a.closed, true);
  assert.equal(h.viewHost.bindingForSender(a.id), null);
  await assert.rejects(h.call(a, "fm.read", { path: "same.txt" }), /invalid panel invoker/);
});

test("bounded preserved contexts refuse eviction and local fm behavior is unchanged", async (t) => {
  const h = await harness(t);
  const local = h.open(undefined);
  assert.equal((await h.call(local, "fm.hello")).root.path, h.local);
  const original = await h.call(local, "fm.read", { path: "same.txt" });
  assert.equal(original.text, "local-marker");
  assert.equal((await h.call(local, "fm.write", { path: "same.txt", text: "local saved", expectedMtimeMs: original.mtimeMs, expectedSize: original.size })).ok, true);
  assert.equal(readFileSync(join(h.local, "same.txt"), "utf8"), "local saved");
  assert.equal(h.calls.length, 0);
  for (let i = 0; i < 15; i++) h.open(`context-${i}`);
  assert.throws(() => h.open("overflow"), /FILE_VIEW_LIMIT/);
  assert.equal(local.closed, false);
  assert.equal(h.open(undefined), local);
});

test.after(() => rmSync(temporary, { recursive: true, force: true }));
