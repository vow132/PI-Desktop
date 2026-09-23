import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";

let server, store, api, initial;
let projects, hosts, sessions, calls;
const previousStorage = globalThis.localStorage;
const date = "2026-09-01T00:00:00.000Z";
const host = (hostKey, connected = true) => ({ hostKey, label: `Machine ${hostKey}`, connected });
const project = (id, hostKey = "a") => ({ id, hostKey, hostProjectId: `host-project-${id}`, path: "/same/path", name: `Project ${id}`, createdAt: date, updatedAt: date });
const session = (id, remoteProjectId, hostKey = "a") => ({
  id, source: remoteProjectId ? "remote" : "desktop", remoteProjectId, hostKey: remoteProjectId ? hostKey : undefined,
  title: `Chat ${id}`, projectPath: "/same/path", messageCount: 1, mode: "agent", permissionMode: "ask",
  thinkingLevel: "off", providerId: "remote-provider", modelId: "remote-model", createdAt: date, updatedAt: date,
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const state = () => store.getState();

before(async () => {
  const storage = new Map();
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, esbuild: { jsx: "automatic" },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ useAppStore: store } = await server.ssrLoadModule("/src/stores/app-store.ts"));
  ({ api } = await server.ssrLoadModule("/src/lib/api.ts"));
  initial = { ...store.getInitialState() };
  await i18n.init({ lng: "en", resources: { en: { translation: { remote: { offline: "Offline", online: "Online" } } } } });
});
after(async () => { await server?.close(); globalThis.localStorage = previousStorage; });
beforeEach(async () => {
  projects = []; hosts = [host("a"), host("b")]; sessions = []; calls = [];
  store.setState({ ...initial, workspace: { path: "/same/path", name: "Local" }, activeProjectPath: "/same/path", remoteHosts: hosts, remoteProjects: [], activeRemoteProjectId: null, remoteProjectErrors: {}, remoteProjectPending: {} }, true);
  state().closeRemoteWizard();
  Object.assign(api, {
    listRemoteHosts: async () => ({ hosts }),
    listRemoteProjects: async (key) => ({ projects: key ? projects.filter((p) => p.hostKey === key) : projects }),
    browseRemoteHost: async () => ({ path: "/same/path", entries: [] }),
    registerRemoteProject: async ({ hostKey }) => { const p = project("registered", hostKey); projects = [p]; return { project: p }; },
    createRemoteSession: async ({ hostKey, projectId }) => { calls.push(["create", hostKey, projectId]); const p = projects.find((p) => p.hostProjectId === projectId); const row = session(`created-${calls.length}`, p.id, hostKey); sessions.push(row); return { session: row }; },
    removeRemoteProject: async (id) => { calls.push(["remove", id]); projects = projects.filter((p) => p.id !== id); return { ok: true }; },
    listSessions: async () => ({ sessions }),
    getSession: async (id) => ({ session: { ...sessions.find((s) => s.id === id), messages: [{ id: `message-${id}`, role: "user", content: "Existing message" }] } }),
    setProject: async (path) => { calls.push(["setProject", path]); return { workspace: { path, name: "Local" } }; },
    clearProject: async () => { calls.push(["clearProject"]); },
    getOnboarding: async () => ({}),
    pendingPlans: async () => ({ plans: [] }),
    acknowledgeSessionOutcome: async () => ({}),
  });
  await state().loadRemoteHosts();
});

async function registerFolder() {
  state().openRemoteWizard("a");
  await state().browseRemoteDirectory("a", "/same/path");
  state().selectRemoteWizardPath("/same/path", "Remote folder");
  await state().submitRemoteWizard();
}

test("register folder -> durable row -> remote selection -> file manager without a chat", async () => {
  const workspace = state().workspace;
  await registerFolder();
  assert.equal(state().remoteProjects[0]?.id, "registered");
  assert.equal(state().activeRemoteProjectId, "registered");
  assert.equal(state().activeSessionId, undefined);
  assert.deepEqual(state().messages, []);
  assert.equal(state().remoteWizard.open, false);
  assert.equal(state().workPanelOpen, true);
  assert.equal(state().activeWorkPanelTabId, "plugin:pi.file-manager/manager");
  assert.equal(state().workspace, workspace);
  assert.deepEqual(calls, []);
});

test("explicit remote New chat selects without local alignment even for an identical path", async () => {
  projects = [project("p-a")];
  await state().loadRemoteProjects();
  await state().newRemoteProjectSession("p-a");
  assert.equal(state().activeSessionId, sessions[0].id);
  assert.equal(state().activeRemoteProjectId, "p-a");
  assert.deepEqual(calls, [["create", "a", "host-project-p-a"]]);
  assert.equal(state().workspace.name, "Local");
});

test("host identities isolate the same path; project click selects latest associated chat", async () => {
  projects = [project("p-a"), project("p-b", "b")];
  sessions = [session("a-old", "p-a"), { ...session("a-new", "p-a"), updatedAt: "2026-09-20T00:00:00Z" }, session("b-chat", "p-b", "b"), session("local")];
  store.setState({ sessions });
  await state().loadRemoteProjects("a");
  await state().loadRemoteProjects("b");
  assert.equal(state().remoteProjects.length, 2);
  await state().selectRemoteProject("p-a");
  assert.equal(state().activeSessionId, "a-new");
  await state().selectRemoteProject("p-b");
  assert.equal(state().activeSessionId, "b-chat");
  assert.equal(state().activeRemoteProjectId, "p-b");
  assert.deepEqual(calls, []);
});

test("remembered offline and legacy registrations hydrate and never fall back locally", async () => {
  hosts = [host("a", false)]; projects = [project("offline"), project("legacy", "unpaired")];
  await state().loadRemoteHosts(); await state().loadRemoteProjects();
  assert.equal(state().remoteProjects.length, 2);
  await state().selectRemoteProject("offline");
  assert.equal(state().activeRemoteProjectId, "offline");
  await state().newRemoteProjectSession("offline");
  assert.ok(state().remoteProjectErrors.offline);
  assert.deepEqual(calls, []);
});

test("local selection and project activation clear the remote target, including the same path", async () => {
  await registerFolder();
  await state().activateProject("/same/path");
  assert.equal(state().activeRemoteProjectId, null);
  assert.equal(state().workPanelOpen, false);
  await state().selectRemoteProject("registered");
  sessions = [session("local-switch")]; store.setState({ sessions });
  await state().selectSession("local-switch");
  assert.equal(state().activeRemoteProjectId, null);
  assert.equal(state().activeSessionId, "local-switch");
});

test("late browse cannot overwrite a different host or a reopened wizard", async () => {
  const pending = deferred(); api.browseRemoteHost = async () => pending.promise;
  state().openRemoteWizard("a");
  state().closeRemoteWizard();
  api.browseRemoteHost = async () => ({ path: "/new", entries: [] });
  state().openRemoteWizard("b");
  await state().browseRemoteDirectory("b");
  pending.resolve({ path: "/old", entries: [] });
  await pending.promise; await Promise.resolve();
  assert.equal(state().remoteBrowse.path, "/new");
  assert.equal(state().remoteWizard.hostKey, "b");
});

test("registration completion preserves newer navigation and never closes a reopened wizard", async () => {
  const pending = deferred(); api.registerRemoteProject = async () => pending.promise;
  state().openRemoteWizard("a"); state().selectRemoteWizardPath("/same/path", "Picked");
  await state().browseRemoteDirectory("a");
  const submitting = state().submitRemoteWizard();
  await state().activateProject("/elsewhere");
  state().closeRemoteWizard(); state().openRemoteWizard("b");
  pending.resolve({ project: project("late") }); await submitting;
  assert.equal(state().activeRemoteProjectId, null);
  assert.equal(state().workspace.path, "/elsewhere");
  assert.equal(state().remoteWizard.open, true);
  assert.equal(state().remoteWizard.hostKey, "b");
});

test("registration and chat failures remain visible without creating a local session", async () => {
  api.registerRemoteProject = async () => { throw new Error("Registration denied"); };
  state().openRemoteWizard("a"); state().selectRemoteWizardPath("/same/path", "Picked");
  await state().browseRemoteDirectory("a");
  await state().submitRemoteWizard();
  assert.equal(state().remoteWizard.open, true);
  assert.equal(state().remoteWizard.error, "Registration denied");
  projects = [project("no-model")]; await state().loadRemoteProjects();
  api.createRemoteSession = async () => { throw new Error("No ready remote model"); };
  await state().newRemoteProjectSession("no-model");
  assert.equal(state().remoteProjectErrors["no-model"], "No ready remote model");
  assert.deepEqual(calls, []);
});

test("remote chat creation is coalesced and cannot steal later navigation", async () => {
  projects = [project("pending")]; await state().loadRemoteProjects();
  const pending = deferred(); let creates = 0;
  api.createRemoteSession = async () => { creates++; return pending.promise; };
  const first = state().newRemoteProjectSession("pending");
  const second = state().newRemoteProjectSession("pending");
  await state().activateProject("/other");
  const row = session("delayed-chat", "pending"); sessions.push(row);
  pending.resolve({ session: row }); await Promise.all([first, second]);
  assert.equal(creates, 1);
  assert.equal(state().workspace.path, "/other");
  assert.equal(state().activeRemoteProjectId, null);
  assert.notEqual(state().activeSessionId, row.id);
});

test("project removal only forgets the registration and stale refresh cannot resurrect it", async () => {
  projects = [project("removed")]; await state().loadRemoteProjects();
  const pending = deferred(); api.listRemoteProjects = async () => pending.promise;
  const loading = state().loadRemoteProjects("a");
  await state().removeRemoteProject("removed");
  pending.resolve({ projects: [project("removed")] }); await loading;
  assert.deepEqual(state().remoteProjects, []);
  assert.deepEqual(calls, [["remove", "removed"]]);
});

test("actual list SSR renders separate host rows, offline metadata and associated sessions", async () => {
  const { RemoteProjectList } = await server.ssrLoadModule("/src/components/projects/RemoteProjectList.tsx");
  const snapshot = { ...state(), remoteProjects: [project("row-a"), project("row-b", "b")], remoteHosts: [host("a"), host("b", false)], sessions: [session("only-a", "row-a"), session("only-b", "row-b", "b")], activeRemoteProjectId: "row-a" };
  Object.assign(store.getInitialState(), snapshot);
  try {
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(RemoteProjectList)));
    assert.match(html, /Project row-a/); assert.match(html, /Project row-b/);
    assert.match(html, /Machine a/); assert.match(html, /Machine b/); assert.match(html, /Offline/);
    assert.match(html, /Chat only-a/); assert.doesNotMatch(html, /Chat only-b/);
    assert.equal((html.match(/data-remote-project=/g) ?? []).length, 2);
  } finally { Object.assign(store.getInitialState(), initial); }
});

test("SSH configuration advances, clears credentials, and registers a folder without a model", async () => {
  state().openRemoteWizard();
  state().goToRemoteWizardStep("config");
  assert.equal(state().remoteWizard.step, "config");
  state().setRemoteWizardField("host", "fixture-host");
  state().setRemoteWizardField("auth", "password");
  state().setRemoteWizardField("secret", "fixture-only");
  api.bootstrapRemoteHost = async (input) => {
    assert.equal(input.host, "fixture-host"); assert.equal(input.password, "fixture-only");
    return { host: host("a"), steps: ["pair"] };
  };
  assert.equal(await state().connectRemoteWizard(), true);
  await state().browseRemoteDirectory("a");
  assert.equal(state().remoteWizard.step, "folder");
  assert.equal(state().remoteWizard.secret, "");
  assert.equal(state().remoteWizard.path, "/same/path");
  await state().submitRemoteWizard();
  assert.equal(state().activeRemoteProjectId, "registered");
  assert.deepEqual(calls, []);
  state().openRemoteWizard(); state().setRemoteWizardField("secret", "fixture-only");
  state().closeRemoteWizard(); assert.equal(state().remoteWizard.secret, "");
});

test("canceled bootstrap cannot overwrite a reopened wizard", async () => {
  const pending = deferred(); api.bootstrapRemoteHost = async () => pending.promise;
  state().openRemoteWizard(); state().setRemoteWizardField("host", "fixture-host");
  const connecting = state().connectRemoteWizard();
  state().closeRemoteWizard(); state().openRemoteWizard("b");
  await state().browseRemoteDirectory("b");
  pending.resolve({ host: host("a"), steps: ["pair"] });
  assert.equal(await connecting, false);
  assert.equal(state().remoteWizard.hostKey, "b");
  assert.equal(state().remoteWizard.secret, "");
});

test("newer directory reads and local navigation fence late browse results", async () => {
  state().openRemoteWizard("a"); await state().browseRemoteDirectory("a");
  const first = deferred(); const second = deferred();
  api.browseRemoteHost = async (_host, path) => path === "/first" ? first.promise : second.promise;
  const readFirst = state().browseRemoteDirectory("a", "/first");
  const readSecond = state().browseRemoteDirectory("a", "/second");
  second.resolve({ path: "/second", entries: [] }); await readSecond;
  first.resolve({ path: "/first", entries: [] }); await readFirst;
  assert.equal(state().remoteBrowse.path, "/second");
  const late = deferred(); api.browseRemoteHost = async () => late.promise;
  const reading = state().browseRemoteDirectory("a", "/late");
  await state().activateProject("/local-new");
  late.resolve({ path: "/late", entries: [] }); await reading;
  assert.equal(state().remoteBrowse.path, "/second");
  assert.equal(state().workspace.path, "/local-new");
});

test("registration publishes its row before activation and retains visible activation failure", async () => {
  sessions = [session("activation-error", "registered")]; store.setState({ sessions });
  const pending = deferred(); api.getSession = async () => pending.promise;
  state().openRemoteWizard("a"); await state().browseRemoteDirectory("a");
  const submitting = state().submitRemoteWizard();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state().remoteProjects[0]?.id, "registered");
  assert.equal(state().remoteWizard.open, true);
  pending.reject(new Error("Remote transcript unavailable"));
  await submitting;
  assert.equal(state().remoteWizard.open, true);
  assert.equal(state().remoteWizard.error, "Remote transcript unavailable");
});

test("late transcript selection cannot steal local navigation", async () => {
  projects = [project("slow-project")]; sessions = [session("slow-remote", "slow-project")];
  store.setState({ sessions }); await state().loadRemoteProjects();
  const pending = deferred(); api.getSession = async () => pending.promise;
  const selecting = state().selectRemoteProject("slow-project");
  await state().activateProject("/new-local");
  pending.resolve({ session: { ...sessions[0], messages: [] } }); await selecting;
  assert.equal(state().activeRemoteProjectId, null);
  assert.equal(state().activeSessionId, undefined);
  assert.equal(state().workspace.path, "/new-local");
});

test("host-partitioned refreshes preserve active identity and reject older/all/removed-host results", async () => {
  projects = [project("refresh-a"), project("refresh-b", "b")]; await state().loadRemoteProjects();
  await state().selectRemoteProject("refresh-a");
  const old = deferred(); api.listRemoteProjects = async () => old.promise;
  const older = state().loadRemoteProjects();
  api.listRemoteProjects = async () => ({ projects: [{ ...project("refresh-a"), name: "Updated" }] });
  await state().loadRemoteProjects("a");
  old.resolve({ projects }); await older;
  assert.equal(state().remoteProjects.find((p) => p.id === "refresh-a").name, "Updated");
  assert.equal(state().remoteProjects.length, 2);
  assert.equal(state().activeRemoteProjectId, "refresh-a");
  const removed = deferred(); api.listRemoteProjects = async () => removed.promise;
  const loading = state().loadRemoteProjects("b");
  hosts = [host("a")]; await state().loadRemoteHosts();
  removed.resolve({ projects: [project("resurrected", "b")] }); await loading;
  assert.equal(state().remoteProjects.some((p) => p.id === "resurrected"), false);
});

test("local New chat cannot reuse an empty remote session sharing its path", async () => {
  await registerFolder();
  sessions = [{ ...session("empty-remote", "registered"), messageCount: 0 }]; store.setState({ sessions });
  api.createSession = async () => {
    calls.push(["local-create"]);
    const row = { ...session("new-local"), messageCount: 0, messages: [] }; sessions.push(row);
    return { session: row };
  };
  await state().newSession();
  assert.equal(state().activeRemoteProjectId, null);
  assert.equal(state().activeSessionId, "new-local");
  assert.deepEqual(calls, [["local-create"]]);
});

test("draft submission on a remote project cannot materialize locally, even on failure", async () => {
  const { materializeDraftSession } = await server.ssrLoadModule("/src/stores/app-store.ts");
  await registerFolder();
  api.createSession = async () => { assert.fail("No local fallback"); };
  api.createRemoteSession = async () => { throw new Error("No remote model configured"); };
  await assert.rejects(materializeDraftSession(), /No remote model configured/);
  assert.equal(state().activeRemoteProjectId, "registered");
  assert.equal(state().activeSessionId, undefined);
  assert.deepEqual(calls, []);
});

test("local indexes exclude remote paths and same-path remote session counts", async () => {
  const { collectSessionProjects } = await server.ssrLoadModule("/src/lib/session-projects.ts");
  const { relatedProjectSessions } = await server.ssrLoadModule("/src/lib/project-archive.ts");
  const remote = session("index-remote", "index-project");
  assert.deepEqual(collectSessionProjects([remote]), []);
  const local = session("index-local");
  assert.deepEqual(relatedProjectSessions([remote, local], { path: "/same/path", roots: [{ path: "/same/path" }] }).map((s) => s.id), ["index-local"]);
});

test("offline project root remains remote after session refresh drops its session", async () => {
  const { activeSessionRoot } = await server.ssrLoadModule("/src/stores/slices/remote-slice.ts");
  projects = [project("root-project")]; sessions = [session("root-session", "root-project")];
  store.setState({ sessions }); await state().loadRemoteProjects(); await state().selectSession("root-session");
  sessions = []; await state().refreshSessions();
  assert.deepEqual(activeSessionRoot(state()), { path: "/same/path", remote: true, remoteProjectId: "root-project" });
  assert.equal(state().workspace.name, "Local");
});

test("file viewer routing passes the opaque remote session and refuses a project-only local fallback", async () => {
  const { listTargetDirectory, readTargetFile } = await server.ssrLoadModule("/src/lib/remote-file-access.ts");
  api.fsList = async (...args) => { calls.push(["list", ...args]); return { entries: [] }; };
  api.fsRead = async (...args) => { calls.push(["read", ...args]); return { kind: "text", content: "fixture" }; };
  await listTargetDirectory({ remote: true, sessionId: "opaque-session" }, "src");
  await readTargetFile({ remote: true, sessionId: "opaque-session" }, "src/index.ts", "text/plain");
  assert.deepEqual(calls, [["list", "src", "opaque-session"], ["read", "src/index.ts", "text/plain", "opaque-session"]]);
  assert.throws(() => listTargetDirectory({ remote: true }, "src"));
  assert.throws(() => readTargetFile({ remote: true }, "src/index.ts"));
  assert.equal(calls.length, 2);
  await listTargetDirectory({ remote: false }, "");
  assert.deepEqual(calls[2], ["list", "", undefined]);
});

test("remote draft submission creates a remote chat and returns its id", async () => {
  const { materializeDraftSession } = await server.ssrLoadModule("/src/stores/app-store.ts");
  await registerFolder();
  assert.equal(await materializeDraftSession(), sessions[0].id);
  assert.equal(state().activeRemoteProjectId, "registered");
  assert.deepEqual(calls, [["create", "a", "host-project-registered"]]);
});

test("an offline session selection reports failure without touching the local workspace", async () => {
  sessions = [session("offline-session", "offline-project")];
  store.setState({ sessions, remoteHosts: [host("a", false)] });
  api.getSession = async () => assert.fail("Offline selection should not load a local detail");
  await assert.rejects(state().selectSession("offline-session"), /Offline/);
  assert.equal(state().activeSessionId, undefined);
  assert.deepEqual(calls, []);
});
