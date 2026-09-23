import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createRemoteProjectRegistry, remoteProjectId } = await import("../electron/main/remote/remote-projects.ts");
const { createRemoteProjectService } = await import("../electron/main/remote/remote-project-service.ts");
const now = "2026-09-22T00:00:00Z";
const row = (hostKey, project = "project") => ({ hostKey, hostProjectId: project, path: "/srv/app", name: "App", createdAt: now, updatedAt: now });
const remoteSession = { id: "session", projectId: "project", title: "Remote", mode: "agent", permissionMode: "ask", updatedAt: now, createdAt: now };
async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "remote-project-flow-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const registry = createRemoteProjectRegistry({ dataDir });
  const calls = [];
  let connected = true;
  let hosts = ["a", "b"];
  let capabilities = { terminal: true, workspace: true, projectFiles: { version: 1, read: true, write: true } };
  const options = {
    registry,
    pairedHostKeys: async () => hosts,
    requireHost(hostKey) {
      if (!connected) throw Object.assign(new Error("Host offline"), { errorCode: "AGENT_UNAVAILABLE" });
      return {
        capabilities,
        async registerSession(id) { calls.push({ hostKey, method: "registerBackend", id }); },
        async request(method, params) {
          calls.push({ hostKey, method, params });
          if (overrides.request) return overrides.request(method, params);
          if (method === "project/register") return { id: "project", label: "App", path: "/srv/app" };
          if (method === "session/create") return { session: remoteSession };
          if (method === "session/list") return { sessions: [remoteSession] };
          if (method === "workspace/list") return { entries: [{ name: "src", kind: "dir", size: 0 }] };
          if (method === "workspace/read") return { kind: "text", size: 5, content: "hello" };
          return { ok: true, version: "v1" };
        },
      };
    },
  };
  return { registry, service: createRemoteProjectService(options), options, calls,
    offline: () => { connected = false; }, removeHosts: () => { hosts = []; },
    oldHost: () => { capabilities = { terminal: false, workspace: true }; },
    readOnly: () => { capabilities.projectFiles.write = false; },
  };
}

test("register folder, reload project list, create remote session and route files to that project", async (t) => {
  const f = await fixture(t);
  const project = await f.service.registerProject("a", { path: "/srv/app", name: "My remote app" });
  const restarted = createRemoteProjectService(f.options);
  assert.deepEqual(await restarted.listProjects(), [project]);
  const session = await restarted.createSession("a", { projectId: project.hostProjectId });
  assert.equal(session.source, "remote");
  assert.equal(session.remoteProjectId, project.id);
  assert.equal(session.projectPath, "/srv/app");
  await restarted.fileOperation(project.id, "read", { path: "src/app.ts" });
  await restarted.fileOperation(project.id, "write", { path: "src/app.ts", text: "new", expectedVersion: "v1" });
  const writes = f.calls.filter(call => call.method === "project/files/write");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].hostKey, "a");
  assert.equal(writes[0].params.projectId, "project");
  assert.match(writes[0].params.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(f.calls.some(call => call.method === "registerBackend" && call.id === "session"), true);
});

test("same path on different hosts stays distinct, offline projects remain visible", async (t) => {
  const f = await fixture(t);
  const a = await f.service.registerProject("a", { path: "/srv/app" });
  const b = await f.service.registerProject("b", { path: "/srv/app" });
  assert.notEqual(a.id, b.id);
  f.offline();
  assert.equal((await f.service.listProjects()).length, 2);
  await assert.rejects(f.service.fileOperation(b.id, "list", {}), { errorCode: "AGENT_UNAVAILABLE" });
  const before = f.calls.length;
  await f.service.removeProject(a.id);
  assert.equal(f.calls.length, before, "forgetting never sends a remote deletion");
  assert.deepEqual((await f.service.listProjects()).map(project => project.id), [b.id]);
});

test("payload cannot override a registered project's host or project identity", async (t) => {
  const f = await fixture(t);
  await f.registry.upsert(row("a"));
  await f.service.fileOperation(remoteProjectId("a", "project"), "read", { path: "x", projectId: "other", hostKey: "b" });
  const call = f.calls.at(-1);
  assert.equal(call.hostKey, "a");
  assert.equal(call.params.projectId, "project");
  await assert.rejects(f.service.fileOperation(remoteProjectId("a", "unknown"), "read", { path: "x" }), { errorCode: "NOT_FOUND" });
});

test("older hosts get session-rooted read-only access but never mutation fallback", async (t) => {
  const f = await fixture(t);
  await f.registry.upsert(row("a")); f.oldHost();
  const id = remoteProjectId("a", "project");
  const list = await f.service.fileOperation(id, "list", { path: "" });
  assert.equal(list.readOnly, true);
  assert.deepEqual(list.entries[0], { name: "src", path: "src", isDirectory: true, size: 0 });
  const read = await f.service.fileOperation(id, "read", { path: "hello.txt" });
  assert.equal(read.text, "hello"); assert.equal(read.readOnly, true);
  await assert.rejects(f.service.fileOperation(id, "write", { path: "hello.txt", text: "oops" }), { errorCode: "CAPABILITY_UNAVAILABLE" });
  assert.equal(f.calls.some(call => call.method.endsWith("/write")), false);
});

test("removed hosts and read-only capabilities cannot mutate a workspace", async (t) => {
  const f = await fixture(t); await f.registry.upsert(row("a"));
  f.readOnly();
  await assert.rejects(f.service.fileOperation(remoteProjectId("a", "project"), "create", { parent: "", name: "x" }), { errorCode: "CAPABILITY_UNAVAILABLE" });
  f.removeHosts();
  assert.deepEqual(await f.service.listProjects(), []);
  assert.equal(await f.service.getProject(remoteProjectId("a", "project")), undefined);
});

test("mutation timeout is surfaced without a hidden retry", async (t) => {
  const f = await fixture(t, { request: async () => { throw Object.assign(new Error("Disconnected after possible commit"), { errorCode: "TIMEOUT" }); } });
  await f.registry.upsert(row("a"));
  await assert.rejects(f.service.fileOperation(remoteProjectId("a", "project"), "rename", { path: "a", newName: "b" }), { errorCode: "TIMEOUT" });
  assert.equal(f.calls.length, 1);
});
