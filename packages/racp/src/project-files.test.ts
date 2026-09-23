import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RacpError } from "@pi-desktop/agent-host";
import { createProjectFileService } from "../../host-runtime/src/project-files.js";
import { PROJECT_FILE_TEXT_MAX_BYTES, type ProjectFilesReadResult, type ProjectFilesWriteResult, type ProjectFilesEntryResult } from "@pi-desktop/shared";
import { hashToken, newDeviceToken } from "./auth.js";
import { OWNER_TOKEN, VIEWER_TOKEN, harness, type Harness } from "./test-harness.js";
import { RacpClient } from "./client.js";
import { bindRacpWebSocket, wsClientTransport } from "./ws-binding.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const h of harnesses.splice(0)) h.server.close();
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(port = true) {
  if (!process.env.PI_SCRATCH_DIR) throw new Error("PI_SCRATCH_DIR required");
  const root = await realpath(await mkdtemp(join(process.env.PI_SCRATCH_DIR, "racp-project-files-")));
  dirs.push(root);
  await writeFile(join(root, "a.txt"), "initial");
  const files = createProjectFileService({ projectRoot: async (id) => { if (id !== "7") throw new RacpError("NOT_FOUND", "unknown project"); return root; } });
  const h = await harness({ operations: port ? { files } : {} });
  harnesses.push(h);
  return { h, root, files };
}
const mutation = () => ({ projectId: "7", requestId: randomUUID() });

describe("project files over the real RACP dispatch and filesystem", () => {
  it("negotiates an additive capability and preserves old workspace list/read shapes", async () => {
    const { h } = await fixture(false);
    const { client } = await h.connect(OWNER_TOKEN);
    expect(client.initialized?.protocolVersion).toBe("1.0");
    expect(client.initialized?.capabilities.projectFiles).toBeUndefined();
    expect(await client.request("workspace/list", { sessionId: "s1", path: "" })).toEqual({ entries: [{ name: "README.md", kind: "file", size: 12 }] });
    expect(await client.request("workspace/read", { sessionId: "s1", path: "a.txt" })).toEqual({ kind: "text", content: "hello", size: 5 });
    for (const method of ["list", "read", "search", "write", "create", "rename", "move"]) {
      await expect(client.request(`project/files/${method}`, { projectId: "7" })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    }
    await client.close();
  });

  it("runs the entire registered-project user path with real files and reconnect-safe replay", async () => {
    const { h, root } = await fixture();
    let { client } = await h.connect(OWNER_TOKEN);
    expect(client.initialized?.capabilities.projectFiles).toEqual({ version: 1, read: true, write: true });
    expect(await client.request("project/files/list", { projectId: "7" })).toMatchObject({ ok: true, entries: [{ path: "a.txt" }] });
    const read = await client.request<ProjectFilesReadResult>("project/files/read", { projectId: "7", path: "a.txt" });
    if (read.kind !== "text") throw new Error("expected text");
    const input = { ...mutation(), path: "a.txt", text: "changed\n", expectedVersion: read.version };
    const saved = await client.request<ProjectFilesWriteResult>("project/files/write", input);
    expect(await client.request("project/files/read", { projectId: "7", path: "a.txt" })).toMatchObject({ kind: "text", text: "changed\n", version: saved.version });
    await client.close();
    ({ client } = await h.connect(OWNER_TOKEN));
    expect(await client.request("project/files/write", input)).toEqual(saved);
    await expect(client.request("project/files/write", { ...input, text: "different" })).rejects.toMatchObject({ code: "CONFLICT" });
    await client.request("project/files/create", { ...mutation(), parent: "", name: "folder", isDirectory: true });
    const create = { ...mutation(), parent: "", name: "new.txt", isDirectory: false };
    const [a, b] = await Promise.all([client.request("project/files/create", create), client.request("project/files/create", create)]);
    expect(a).toEqual(b);
    await client.request("project/files/rename", { ...mutation(), path: "new.txt", newName: "renamed.txt" });
    await client.request("project/files/move", { ...mutation(), from: "renamed.txt", toDir: "folder" });
    expect(await client.request("project/files/search", { projectId: "7", query: "RENAMED" })).toMatchObject({ ok: true, matches: [{ path: "folder/renamed.txt" }], truncated: false });
    expect(await readFile(join(root, "folder", "renamed.txt"), "utf8")).toBe("");
    expect(await client.request("project/files/read", { projectId: "7", path: "a.txt" })).toMatchObject({ text: "changed\n" });
    await client.close();
  });

  it("authorizes viewers only for reads and denies every mutation to non-owners", async () => {
    const { h, root } = await fixture();
    for (const role of ["viewer", "controller", "approver"] as const) {
      const token = role === "viewer" ? VIEWER_TOKEN : newDeviceToken();
      if (role !== "viewer") await h.store.saveDevice({ deviceId: `device-${role}`, label: role, roles: [role], tokenHash: hashToken(token), createdAt: new Date(0).toISOString() });
      const { client } = await h.connect(token);
      for (const method of ["write", "create", "rename", "move"]) await expect(client.request(`project/files/${method}`, { projectId: "7" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      if (role === "viewer") {
        expect(await client.request("project/files/list", { projectId: "7" })).toMatchObject({ ok: true });
        expect(await client.request("project/files/read", { projectId: "7", path: "a.txt" })).toMatchObject({ text: "initial" });
        expect(await client.request("project/files/search", { projectId: "7", query: "a" })).toMatchObject({ matches: [{ path: "a.txt" }] });
      }
      await client.close();
    }
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("initial");
  });

  it("rejects invalid params, traversal and unknown projects through typed wire errors", async () => {
    const { h } = await fixture();
    const { client } = await h.connect(OWNER_TOKEN);
    const input = { ...mutation(), path: "a.txt", text: "new", expectedVersion: "abc" };
    for (const params of [{ ...input, requestId: undefined }, { ...input, expectedVersion: undefined }, { ...input, force: true }, { ...input, text: "x".repeat(PROJECT_FILE_TEXT_MAX_BYTES + 1) }]) {
      await expect(client.request("project/files/write", params)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    await expect(client.request("project/files/list", { root: "/home", projectId: "7" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(client.request("project/files/list", { projectId: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.request("project/files/read", { projectId: "7", path: "../secret" })).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(client.request("project/files/delete", { projectId: "7", path: "a.txt" })).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    h.server.capabilities.projectFiles = { version: 1, read: true, write: false };
    await expect(client.request("project/files/write", input)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await client.close();
  });

  it("keeps worst-case encoded read and write frames below the negotiated limit", async () => {
    const { h, root } = await fixture();
    await writeFile(join(root, "a.txt"), "\u0001".repeat(PROJECT_FILE_TEXT_MAX_BYTES));
    const { client, link } = await h.connect(OWNER_TOKEN);
    const read = await client.request<ProjectFilesReadResult>("project/files/read", { projectId: "7", path: "a.txt" });
    if (read.kind !== "text") throw new Error("expected text");
    await client.request("project/files/write", { ...mutation(), path: "a.txt", text: read.text, expectedVersion: read.version });
    for (const frame of [...link().toClient, ...link().toServer]) expect(Buffer.byteLength(frame)).toBeLessThan(h.server.limits.maxFrameBytes);
    await client.close();
  });

  it("does not retry a timed-out mutation and reports a committed result on refresh", async () => {
    const { root, files } = await fixture();
    const committed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const h = await harness({ operations: { files: { ...files, async create(input, principal) {
      const result = await files.create(input, principal);
      committed.resolve();
      await release.promise;
      return result;
    } } } });
    harnesses.push(h);
    const { client, link } = await h.connect(OWNER_TOKEN, { requestTimeoutMs: 1000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const input = { ...mutation(), parent: "", name: "committed.txt", isDirectory: false };
    const pending = client.request<ProjectFilesEntryResult>("project/files/create", input);
    const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await committed.promise;
    await vi.advanceTimersByTimeAsync(1001);
    await rejected;
    release.resolve();
    vi.useRealTimers();
    expect(await client.request("project/files/list", { projectId: "7" })).toMatchObject({ entries: [{ path: "a.txt" }, { path: "committed.txt" }] });
    expect(link().toServer.filter((frame) => JSON.parse(frame).method === "project/files/create")).toHaveLength(1);
    expect(await readFile(join(root, "committed.txt"), "utf8")).toBe("");
    await client.close();
  });

  it("never emits an oversized frame: the connection is closed instead of a too-large response", async () => {
    const { h, root } = await fixture(false);
    const big = await harness({ operations: { files: createProjectFileService({ projectRoot: async (id) => { if (id !== "7") throw new RacpError("NOT_FOUND", "unknown project"); return root; } }) }, limits: { maxFrameBytes: 2048 } });
    harnesses.push(big);
    await writeFile(join(root, "a.txt"), "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    const { client, link } = await big.connect(OWNER_TOKEN);
    const before = link().toClient.length;
    const closed = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!big.server.connectionCount()) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
      timer.unref?.();
    });
    await expect(client.request("project/files/read", { projectId: "7", path: "a.txt" })).rejects.toThrow();
    await closed;
    const after = link().toClient.slice(before);
    for (const frame of after) expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(2048);
    expect(link().closeCodes.map((entry) => entry.code)).toContain(1009);
    await client.close();
  });

  it("serves the project-file lifecycle over an authenticated loopback WebSocket", async () => {
    const { h, root } = await fixture();
    const binding = await bindRacpWebSocket({ server: h.server, authenticator: h.authenticator, port: 0, log: () => undefined });
    const client = new RacpClient({
      transport: wsClientTransport({ url: `ws://127.0.0.1:${binding.address.port}/v1/racp/ws`, token: OWNER_TOKEN }),
      client: { name: "project-file-integration", version: "1" },
    });
    try {
      expect((await client.connect()).capabilities.projectFiles).toEqual({ version: 1, read: true, write: true });
      expect(await client.request("project/files/list", { projectId: "7" })).toMatchObject({ entries: [{ path: "a.txt" }] });
      const read = await client.request<ProjectFilesReadResult>("project/files/read", { projectId: "7", path: "a.txt" });
      if (read.kind !== "text") throw new Error("expected text");
      await client.request("project/files/write", { ...mutation(), path: "a.txt", text: "socket edit", expectedVersion: read.version });
      await client.request("project/files/create", { ...mutation(), parent: "", name: "folder", isDirectory: true });
      await client.request("project/files/create", { ...mutation(), parent: "", name: "new.txt", isDirectory: false });
      await client.request("project/files/rename", { ...mutation(), path: "new.txt", newName: "renamed.txt" });
      await client.request("project/files/move", { ...mutation(), from: "renamed.txt", toDir: "folder" });
      expect(await client.request("project/files/search", { projectId: "7", query: "renamed" })).toMatchObject({ matches: [{ path: "folder/renamed.txt" }] });
      expect(await readFile(join(root, "a.txt"), "utf8")).toBe("socket edit");
      expect(await client.request("project/files/read", { projectId: "7", path: "folder/renamed.txt" })).toMatchObject({ kind: "text", text: "" });
    } finally {
      await client.close();
      await binding.close();
    }
  });
});
