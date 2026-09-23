import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RacpError, type Principal } from "@pi-desktop/agent-host";
import { PROJECT_FILE_TEXT_MAX_BYTES, PROJECT_FILE_IMAGE_MAX_BYTES, RACP_DEFAULT_LIMITS } from "@pi-desktop/shared";
import { createProjectFileService, type ProjectFileServiceOptions } from "./project-files.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const owner: Principal = { subject: "device-a", roles: ["owner"] };
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(fs.open).mockReset(); await Promise.all(dirs.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))); });
async function fixture(options: Partial<ProjectFileServiceOptions> = {}) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "project-files-")));
  dirs.push(root);
  const files = createProjectFileService({ projectRoot: async (id) => { if (id !== "7") throw new RacpError("NOT_FOUND", "project unknown"); return root; }, ...options });
  return { root, files };
}
const mutation = () => ({ projectId: "7", requestId: randomUUID() });
async function textVersion(files: ReturnType<typeof createProjectFileService>, path = "a.txt") {
  const read = await files.read({ projectId: "7", path });
  if (read.kind !== "text") throw new Error("expected text");
  return read;
}

describe("registered project file service", () => {
  it("supports the user path list -> read -> save -> reread -> create -> rename -> move", async () => {
    const { root, files } = await fixture();
    await fs.writeFile(join(root, "a.txt"), "\ufefffirst\r\nsecond\r\n", { mode: 0o640 });
    const beforeMode = (await fs.stat(join(root, "a.txt"))).mode;
    expect(await files.list({ projectId: "7" })).toMatchObject({ ok: true, path: "", entries: [{ name: "a.txt", path: "a.txt", isDirectory: false }], truncated: false, ignoreActive: false });
    const read = await textVersion(files);
    expect(read).toMatchObject({ text: "first\nsecond\n", eol: "crlf", bom: true });
    expect(read.version).toMatch(/^[a-f0-9]{64}$/);
    const saved = await files.write({ ...mutation(), path: "a.txt", text: "updated\n", expectedVersion: read.version }, owner);
    expect((await textVersion(files)).version).toBe(saved.version);
    expect(await fs.readFile(join(root, "a.txt"), "utf8")).toBe("\ufeffupdated\r\n");
    expect((await fs.stat(join(root, "a.txt"))).mode).toBe(beforeMode);
    const next = await files.write({ ...mutation(), path: "a.txt", text: "lf\r\n", eol: "lf", bom: false, expectedVersion: saved.version }, owner);
    expect(await fs.readFile(join(root, "a.txt"), "utf8")).toBe("lf\n");
    expect(next.version).not.toBe(saved.version);
    expect(await files.create({ ...mutation(), parent: "", name: "folder", isDirectory: true }, owner)).toMatchObject({ entry: { path: "folder", isDirectory: true } });
    await files.create({ ...mutation(), parent: "", name: "new.txt", isDirectory: false }, owner);
    expect(await files.rename({ ...mutation(), path: "new.txt", newName: "renamed.txt" }, owner)).toMatchObject({ entry: { path: "renamed.txt" } });
    expect(await files.move({ ...mutation(), from: "renamed.txt", toDir: "folder" }, owner)).toMatchObject({ entry: { path: "folder/renamed.txt" } });
    expect((await files.search({ projectId: "7", query: "RENAMED" })).matches.map((entry) => entry.path)).toEqual(["folder/renamed.txt"]);
    expect((await files.list({ projectId: "7", path: "folder" })).entries[0]?.path).toBe("folder/renamed.txt");
  });

  it("prevents stale-version data loss, including content changes with restored mtime", async () => {
    const { root, files } = await fixture();
    const path = join(root, "a.txt");
    await fs.writeFile(path, "old");
    const read = await textVersion(files);
    const info = await fs.stat(path);
    await fs.writeFile(path, "new");
    await fs.utimes(path, info.atime, info.mtime);
    const current = await textVersion(files);
    expect(current.version).not.toBe(read.version);
    await expect(files.write({ ...mutation(), path: "a.txt", text: "lost", expectedVersion: read.version }, owner)).rejects.toMatchObject({ code: "CONFLICT", retriable: false });
    const competing = await Promise.allSettled(["one", "two"].map((text) => files.write({ ...mutation(), path: "a.txt", text, expectedVersion: current.version }, owner)));
    expect(competing.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(competing.filter((value) => value.status === "rejected")).toHaveLength(1);
    expect(await fs.readFile(path, "utf8")).toBe("one");
  });

  it("rechecks immediately before replace and cleans the temporary on conflict", async () => {
    const { root, files } = await fixture();
    const path = join(root, "a.txt");
    await fs.writeFile(path, "old");
    const read = await textVersion(files);
    const { open: originalOpen } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[1] === "wx") {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); await fs.writeFile(path, "external edit"); });
      }
      return handle;
    });
    await expect(files.write({ ...mutation(), path: "a.txt", text: "would lose edits", expectedVersion: read.version }, owner)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await fs.readFile(path, "utf8")).toBe("external edit");
    expect(await fs.readdir(root)).toEqual(["a.txt"]);
  });

  it("cleans failed atomic writes without leaking filesystem paths", async () => {
    const { root, files } = await fixture();
    await fs.writeFile(join(root, "a.txt"), "old");
    const read = await textVersion(files);
    const { open: originalOpen } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[1] === "wx") vi.spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error(`disk error at ${root}`), { code: "EIO" }));
      return handle;
    });
    await expect(files.write({ ...mutation(), path: "a.txt", text: "new", expectedVersion: read.version }, owner)).rejects.toMatchObject({ code: "INTERNAL", message: "project file operation failed", details: { fsCode: "EIO" } });
    expect(await fs.readFile(join(root, "a.txt"), "utf8")).toBe("old");
    expect(await fs.readdir(root)).toEqual(["a.txt"]);
  });

  it("rejects a parent switched to a junction before the commit", async () => {
    const { root, files } = await fixture();
    const { root: outside } = await fixture();
    await fs.mkdir(join(root, "folder"));
    await fs.writeFile(join(root, "folder", "a.txt"), "old");
    await fs.writeFile(join(outside, "a.txt"), "outside");
    const read = await textVersion(files, "folder/a.txt");
    const { open: originalOpen } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[1] === "wx") {
        const close = handle.close.bind(handle);
        let switched = false;
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          if (switched) return;
          switched = true;
          await fs.rename(join(root, "folder"), join(root, "original"));
          await fs.symlink(outside, join(root, "folder"), process.platform === "win32" ? "junction" : "dir");
        });
      }
      return handle;
    });
    await expect(files.write({ ...mutation(), path: "folder/a.txt", text: "new", expectedVersion: read.version }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    expect(await fs.readFile(join(outside, "a.txt"), "utf8")).toBe("outside");
    expect(await fs.readdir(outside)).toEqual(["a.txt"]);
    expect(await fs.readFile(join(root, "original", "a.txt"), "utf8")).toBe("old");
  });

  it("does not replay one project's request into another project", async () => {
    const { root } = await fixture();
    const { root: secondRoot } = await fixture();
    const files = createProjectFileService({ projectRoot: async (id) => id === "7" ? root : secondRoot });
    const input = { ...mutation(), parent: "", name: "new.txt", isDirectory: false };
    await files.create(input, owner);
    await files.create({ ...input, projectId: "8" }, owner);
    expect(await fs.readdir(root)).toEqual(["new.txt"]);
    expect(await fs.readdir(secondRoot)).toEqual(["new.txt"]);
  });

  it("deduplicates in-flight and completed mutations by principal, project and body, with expiry", async () => {
    let now = 0;
    const { root, files } = await fixture({ now: () => now });
    const input = { ...mutation(), parent: "", name: "new.txt", isDirectory: false };
    const [a, b] = await Promise.all([files.create(input, owner), files.create({ ...input }, owner)]);
    expect(a).toEqual(b);
    expect(await files.create(input, owner)).toEqual(a);
    await expect(files.create({ ...input, name: "other.txt" }, owner)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(files.create(input, { subject: "device-b", roles: ["owner"] })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(files.create(input, { subject: owner.subject, roles: ["viewer"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(files.create(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await fs.unlink(join(root, "new.txt"));
    expect(await files.create(input, owner)).toEqual(a);
    now = 5 * 60 * 1000 + 1;
    expect(await files.create(input, owner)).toMatchObject({ entry: { path: "new.txt" } });
    expect(await fs.readdir(root)).toEqual(["new.txt"]);
  });

  it("bounds the replay table without evicting unexpired requests", async () => {
    const { files } = await fixture();
    for (let index = 0; index < 1000; index++) {
      await expect(files.create({ projectId: "7", requestId: `bounded-${index}`, parent: "", name: ".env", isDirectory: false }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    }
    await expect(files.create({ ...mutation(), parent: "", name: "valid.txt", isDirectory: false }, owner)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  }, 20000);

  it.each(["../a", "a/../b", "/etc/passwd", "C:/file", "C:file", "\\\\server\\share", "a\\b", "a//b", "a\0b", ".", "a/", "a.txt:stream", "NUL", "a. "])("rejects ambiguous or escaping path %s", async (path) => {
    const { files } = await fixture();
    await expect(files.read({ projectId: "7", path })).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.create({ ...mutation(), parent: path, name: "new", isDirectory: false }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
  });

  it.each([".ssh", ".aws", ".gnupg", ".gpg", ".kube", ".git", ".env", ".env.production", ".environment", "id_rsa.pub", "id_ed25519", "secret.pem", "secret.KEY", "secret.p12", "secret.pfx", ".npmrc", ".netrc"])("denies credentials at every path segment: %s", async (name) => {
    const { root, files } = await fixture();
    await fs.mkdir(join(root, name));
    await fs.writeFile(join(root, name, "secret.txt"), "secret");
    await expect(files.read({ projectId: "7", path: `${name}/secret.txt` })).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.create({ ...mutation(), parent: "", name, isDirectory: false }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    expect((await files.list({ projectId: "7" })).entries).toEqual([]);
    expect((await files.search({ projectId: "7", query: "secret" })).matches).toEqual([]);
  });

  it.each(["credentials.json","credentials.db","credentials.xml","token.json","tokens.json","accessTokens.json","msal_token_cache","application_default_credentials.json","service-account.json","kubeconfig",".docker",".azure","gcloud"])("denies cloud and CI credential material at every path segment: %s", async (name) => {
    const { root, files } = await fixture();
    await fs.mkdir(join(root, name, "nested"), { recursive: true });
    await fs.writeFile(join(root, name, "secret.txt"), "secret");
    const inside = `${name}/secret.txt`;
    await expect(files.list({ projectId: "7", path: name })).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.read({ projectId: "7", path: inside })).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.read({ projectId: "7", path: name })).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.search({ projectId: "7", query: "secret", path: name })).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.write({ ...mutation(), path: inside, text: "x", expectedVersion: "0000000000000000000000000000000000000000000000000000000000000000" }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.create({ ...mutation(), parent: name, name: "new.txt", isDirectory: false }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.create({ ...mutation(), parent: "", name, isDirectory: false }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.rename({ ...mutation(), path: name, newName: "renamed.txt" }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.move({ ...mutation(), from: name, toDir: "" }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    expect((await files.list({ projectId: "7" })).entries).toEqual([]);
    expect((await files.search({ projectId: "7", query: "secret" })).matches).toEqual([]);
    await fs.writeFile(join(root, "note.txt"), "keep");
    expect((await files.read({ projectId: "7", path: "note.txt" })).kind).toBe("text");
  });


  it("denies symlink/junction traversal, hard links, credential subtrees and Host state", async () => {
    const { root } = await fixture();
    const { root: outside } = await fixture();
    await fs.writeFile(join(outside, "secret.txt"), "secret");
    await fs.symlink(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    await fs.link(join(outside, "secret.txt"), join(root, "hard.txt"));
    await fs.mkdir(join(root, "state"));
    await fs.writeFile(join(root, "state", "tokens.json"), "private");
    await fs.mkdir(join(root, "folder", ".ssh"), { recursive: true });
    const files = createProjectFileService({ projectRoot: async () => root, protectedPaths: [join(root, "state")] });
    for (const path of ["link/secret.txt", "hard.txt", "state/tokens.json"]) await expect(files.read({ projectId: "7", path })).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.create({ ...mutation(), parent: "link", name: "new", isDirectory: false }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.rename({ ...mutation(), path: "folder", newName: "other" }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.rename({ ...mutation(), path: "state", newName: "other" }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    expect((await files.list({ projectId: "7" })).entries.map((item) => item.name)).toEqual(["folder"]);
    expect((await files.search({ projectId: "7", query: "secret" })).matches).toEqual([]);
    await files.create({ ...mutation(), parent: "", name: "safe.txt", isDirectory: false }, owner);
    expect(await fs.readFile(join(outside, "secret.txt"), "utf8")).toBe("secret");
    const linkedRoot = createProjectFileService({ projectRoot: async () => join(root, "link") });
    await expect(linkedRoot.list({ projectId: "7" })).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
  });

  it("makes node_modules read-only including directory ancestors", async () => {
    const { root, files } = await fixture();
    await fs.mkdir(join(root, "container", "node_modules"), { recursive: true });
    await fs.writeFile(join(root, "container", "node_modules", "pkg.js"), "text");
    expect(await files.read({ projectId: "7", path: "container/node_modules/pkg.js" })).toMatchObject({ kind: "text" });
    await expect(files.create({ ...mutation(), parent: "container/node_modules", name: "new", isDirectory: false }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.rename({ ...mutation(), path: "container", newName: "renamed" }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
  });

  it("refuses overwrite, root/self moves, descendants and unregistered projects", async () => {
    const { root, files } = await fixture();
    await fs.writeFile(join(root, "a.txt"), "a");
    await fs.writeFile(join(root, "b.txt"), "b");
    await fs.mkdir(join(root, "folder", "nested"), { recursive: true });
    await fs.writeFile(join(root, "folder", "a.txt"), "destination");
    await expect(files.create({ ...mutation(), parent: "", name: "a.txt", isDirectory: false }, owner)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(files.rename({ ...mutation(), path: "a.txt", newName: "b.txt" }, owner)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(files.move({ ...mutation(), from: "a.txt", toDir: "folder" }, owner)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(files.move({ ...mutation(), from: "a.txt", toDir: "" }, owner)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(files.move({ ...mutation(), from: "folder", toDir: "folder/nested" }, owner)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(files.rename({ ...mutation(), path: "", newName: "root" }, owner)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(files.list({ projectId: root })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(files.list({ projectId: "unknown" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(files.read({ projectId: "7", path: "missing" })).rejects.toMatchObject({ code: "REMOTE_PATH_NOT_FOUND", message: "project path not found" });
    expect(await fs.readFile(join(root, "b.txt"), "utf8")).toBe("b");
    expect(await fs.readFile(join(root, "folder", "a.txt"), "utf8")).toBe("destination");
  });

  it("bounds byte counts, assembled EOL/BOM, previews and worst-case encoded text frames", async () => {
    const { root, files } = await fixture();
    await fs.writeFile(join(root, "a.txt"), "a");
    const read = await textVersion(files);
    for (const text of ["界".repeat(PROJECT_FILE_TEXT_MAX_BYTES / 2), "\n".repeat(PROJECT_FILE_TEXT_MAX_BYTES)]) {
      await expect(files.write({ ...mutation(), path: "a.txt", text, eol: "crlf", expectedVersion: read.version }, owner)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    await fs.writeFile(join(root, "large.txt"), Buffer.alloc(PROJECT_FILE_TEXT_MAX_BYTES + 1, 65));
    await fs.writeFile(join(root, "image.png"), Buffer.alloc(PROJECT_FILE_IMAGE_MAX_BYTES, 42));
    await fs.writeFile(join(root, "large.png"), Buffer.alloc(PROJECT_FILE_IMAGE_MAX_BYTES + 1, 42));
    await fs.writeFile(join(root, "binary.bin"), Buffer.from([0, 255, 1]));
    await fs.writeFile(join(root, "data.sqlite"), "not a database");
    expect(await files.read({ projectId: "7", path: "large.txt" })).toMatchObject({ kind: "tooLarge", limit: PROJECT_FILE_TEXT_MAX_BYTES });
    expect(await files.read({ projectId: "7", path: "large.png" })).toMatchObject({ kind: "tooLarge", limit: PROJECT_FILE_IMAGE_MAX_BYTES });
    for (const path of ["binary.bin", "data.sqlite"]) expect(await files.read({ projectId: "7", path })).toMatchObject({ kind: "binary" });
    const image = await files.read({ projectId: "7", path: "image.png" });
    expect(image).toMatchObject({ kind: "image", mime: "image/png" });
    expect(Buffer.byteLength(JSON.stringify(image))).toBeLessThan(RACP_DEFAULT_LIMITS.maxFrameBytes);
    await fs.writeFile(join(root, "escaped.txt"), "\u0001".repeat(PROJECT_FILE_TEXT_MAX_BYTES));
    expect(Buffer.byteLength(JSON.stringify(await files.read({ projectId: "7", path: "escaped.txt" })))).toBeLessThan(RACP_DEFAULT_LIMITS.maxFrameBytes);
  });

  it("bounds lists/search with deterministic numeric paging and no regex interpretation", async () => {
    const { root, files } = await fixture();
    for (let start = 0; start < 1005; start += 100) await Promise.all(Array.from({ length: Math.min(100, 1005 - start) }, (_, offset) => fs.writeFile(join(root, `file-${String(start + offset).padStart(4, "0")}.txt`), "")));
    const list = await files.list({ projectId: "7" });
    expect(list.entries).toHaveLength(1000);
    expect(list.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThan(RACP_DEFAULT_LIMITS.maxFrameBytes);
    const first = await files.search({ projectId: "7", query: "FILE-" });
    expect(first.matches).toHaveLength(200);
    expect(first.cursor).toBe("200");
    const next = await files.search({ projectId: "7", query: "file-", cursor: first.cursor });
    expect(next.matches[0]?.path).toBe("file-0200.txt");
    expect((await files.search({ projectId: "7", query: "[.*" })).matches).toEqual([]);
    await expect(files.search({ projectId: "7", query: "file", cursor: "5001" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  }, 30000);

  it("stops search after at most 5000 scanned entries", async () => {
    const { root, files } = await fixture();
    // Denied names count toward the scan budget too, rather than an unbounded scan.
    for (let start = 0; start < 5001; start += 100) await Promise.all(Array.from({ length: Math.min(100, 5001 - start) }, (_, offset) => fs.writeFile(join(root, `.env.${start + offset}`), "")));
    const result = await files.search({ projectId: "7", query: "env" });
    expect(result).toEqual({ ok: true, matches: [], truncated: true });
  }, 30000);
});
