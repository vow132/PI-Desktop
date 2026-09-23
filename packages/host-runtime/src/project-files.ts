import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RacpError, type Principal } from "@pi-desktop/agent-host";
import {
  isProjectFilesInput, PROJECT_FILE_TEXT_MAX_BYTES, PROJECT_FILE_IMAGE_MAX_BYTES,
  PROJECT_FILE_LIST_LIMIT, PROJECT_FILE_SEARCH_LIMIT, PROJECT_FILE_SCAN_LIMIT, PROJECT_FILE_RESPONSE_MAX_BYTES,
  type ProjectFileEntry, type ProjectFilesInputs, type ProjectFilesMethod, type ProjectFilesResults,
  type ProjectFilesReadResult, type ProjectFilesEntryResult, type ProjectFilesWriteResult,
} from "@pi-desktop/shared";

export type ProjectFileServiceOptions = {
  /** Resolve from the current registered-project catalog, never from client paths. */
  projectRoot: (projectId: string) => Promise<string>;
  protectedPaths?: readonly string[];
  now?: () => number;
};
export type ProjectFileService = {
  [K in ProjectFilesMethod]: (input: ProjectFilesInputs[K], principal?: Principal) => Promise<ProjectFilesResults[K]>;
};
type Root = { path: string; registered: string; info: BigIntStats };
type Snapshot = { info: BigIntStats; bytes?: Buffer; version?: string };
type Replay = { digest: string; promise: Promise<unknown>; expires: number };
const DENIED = new Set([
    ".git",
    ".ssh",
    ".aws",
    ".gnupg",
    ".gpg",
    ".kube",
    ".npmrc",
    ".git-credentials",
    ".netrc",
    "_netrc",
    ".docker",
    ".azure",
    "gcloud",
    "credentials",
    "credentials.json",
    "credentials.db",
    "credentials.xml",
    "credentials.dat",
    "token.json",
    "token.db",
    "tokens.json",
    "accesstokens.json",
    "msal_token_cache",
    "application_default_credentials.json",
    "service-account.json",
    "service_account.json",
    "kubeconfig",
]);
const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".bmp": "image/bmp", ".avif": "image/avif" };
const BINARY_EXTENSION = /\.(db|sqlite|sqlite3|pdf|zip|gz|bz2|xz|7z|rar|tar|exe|dll|so|dylib|wasm|woff2?|ttf|otf|mp[34]|m4[av]|mov|webm|wav|ogg|flac|aac|opus)$/i;
const REPLAY_TTL_MS = 5 * 60 * 1000;
const REPLAY_LIMIT = 1000;
function fail(code: import("@pi-desktop/shared").RacpErrorCode, message: string): never { throw new RacpError(code, message, { retriable: false }); }
const within = (root: string, target: string) => { const rel = relative(root, target); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const stamp = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(":");
const mtime = (info: BigIntStats) => Number(info.mtimeNs) / 1e6;
const contentVersion = (bytes: Buffer, info: BigIntStats) => createHash("sha256").update(stamp(info)).update("\0").update(bytes).digest("hex");
function denied(segment: string, mutation: boolean): boolean {
  const lower = segment.toLowerCase();
  return DENIED.has(lower) || lower.startsWith(".env") || lower.startsWith(".pi-file-") ||
    /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)/.test(lower) || /\.(pem|key|p12|pfx|keystore|jks)$/.test(lower) || (mutation && lower === "node_modules");
}
function safePath(path: string, mutation = false, allowRoot = true): string {
  if ((!allowRoot && !path) || path.length > 1024 || /[\\\x00-\x1f\x7f:*?"<>|]/.test(path) || path.startsWith("/") || path.startsWith("~")) fail("REMOTE_PATH_FORBIDDEN", "invalid project-relative path");
  if (path === "" && allowRoot) return path;
  for (const segment of path.split("/")) {
    if (!segment || segment === "." || segment === ".." || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment) || denied(segment, mutation)) fail("REMOTE_PATH_FORBIDDEN", "protected project path");
  }
  return path;
}
function safeName(name: string): string {
  if (name.includes("/")) fail("INVALID_ARGUMENT", "name must be a single path segment");
  return safePath(name, true, false);
}
function fsError(error: unknown): never {
  if (error instanceof RacpError) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") fail("REMOTE_PATH_NOT_FOUND", "project path not found");
  if (code === "EEXIST" || code === "ENOTEMPTY") fail("CONFLICT", "destination already exists");
  if (code === "EACCES" || code === "EPERM") fail("REMOTE_PATH_FORBIDDEN", "project path is not accessible");
  // Never forward Node's absolute-path-bearing error messages to a client.
  throw new RacpError("INTERNAL", "project file operation failed", { retriable: false, details: { fsCode: code ?? "UNKNOWN" } });
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code === "ENOENT" || code === "ELOOP") return false; throw error; }
}
function textOf(bytes: Buffer): { text: string; eol: "lf" | "crlf"; bom: boolean } | null {
  if (bytes.includes(0)) return null;
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
  const bom = raw.startsWith("\ufeff");
  if (bom) raw = raw.slice(1);
  return { text: raw.replace(/\r\n/g, "\n"), eol: raw.includes("\r\n") ? "crlf" : "lf", bom };
}
function toRead(path: string, snapshot: Snapshot): ProjectFilesReadResult {
  const base = { ok: true as const, path, size: Number(snapshot.info.size), mtimeMs: mtime(snapshot.info) };
  const mime = IMAGE_MIME[extname(path).toLowerCase()];
  if (!snapshot.bytes || !snapshot.version) return { ...base, kind: "tooLarge", limit: mime ? PROJECT_FILE_IMAGE_MAX_BYTES : PROJECT_FILE_TEXT_MAX_BYTES };
  const version = snapshot.version;
  if (mime) return { ...base, version, kind: "image", mime, dataUri: `data:${mime};base64,${snapshot.bytes.toString("base64")}` };
  const text = textOf(snapshot.bytes);
  if (!text || BINARY_EXTENSION.test(path)) return { ...base, version, kind: "binary" };
  return { ...base, version, kind: "text", ...text };
}

/** One service per Host: bounded replay and project serialization survive connection changes.
 * Disconnect does not roll back a committed mutation; refresh rather than auto-retry.
 * Node has no portable openat/renameat2: revalidation narrows, but cannot eliminate,
 * races with unrelated local processes changing directories between filesystem calls.
 */
export function createProjectFileService(options: ProjectFileServiceOptions): ProjectFileService {
  const now = options.now ?? Date.now;
  const replay = new Map<string, Replay>();
  const queues = new Map<string, Promise<void>>();
  const protectedPaths = (options.protectedPaths ?? []).map((path) => resolve(path));

  async function checkProtected(path: string, mutation: boolean): Promise<void> {
    for (const protectedPath of protectedPaths) {
      let canonical = protectedPath;
      try { canonical = await realpath(protectedPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (within(protectedPath, path) || within(canonical, path) || (mutation && (within(path, protectedPath) || within(path, canonical)))) fail("REMOTE_PATH_FORBIDDEN", "Host data is protected");
    }
  }
  async function rootFor(projectId: string): Promise<Root> {
    const registered = resolve(await options.projectRoot(projectId));
    if (registered.split(/[\\/]/).some((part) => denied(part, false))) fail("REMOTE_PATH_FORBIDDEN", "protected project root");
    const info = await lstat(registered, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) fail("REMOTE_PATH_FORBIDDEN", "project root must be a real directory");
    const path = await realpath(registered);
    if (path.split(/[\\/]/).some((part) => denied(part, false))) fail("REMOTE_PATH_FORBIDDEN", "protected project root");
    await checkProtected(path, false);
    return { registered, path, info };
  }
  async function checked(root: Root, rel: string, mutation = false, allowMissing = false): Promise<string> {
    safePath(rel, mutation);
    if (mutation && root.path.split(/[\\/]/).some((part) => denied(part, true))) fail("REMOTE_PATH_FORBIDDEN", "read-only project root");
    const current = await lstat(root.registered, { bigint: true });
    if (current.isSymbolicLink() || !sameIdentity(root.info, current) || await realpath(root.registered) !== root.path) fail("CONFLICT", "project root changed; refresh required");
    let target = root.path;
    const parts = rel.split("/").filter(Boolean);
    for (const [index, part] of parts.entries()) {
      target = join(target, part);
      const last = index === parts.length - 1;
      if (allowMissing && last && !await exists(target)) break;
      const info = await lstat(target, { bigint: true });
      if (info.isSymbolicLink()) fail("REMOTE_PATH_FORBIDDEN", "symbolic links are not supported");
      if (!last && !info.isDirectory()) fail("REMOTE_PATH_NOT_FOUND", "parent directory not found");
      if (info.isFile() && info.nlink > 1n) fail("REMOTE_PATH_FORBIDDEN", "hard-linked files are not supported");
      const canonical = await realpath(target);
      await checkProtected(canonical, mutation);
      safePath(relative(root.path, canonical).split(sep).join("/"), mutation);
    await checkProtected(target, mutation);
    }
    await checkProtected(target, false);
    return target;
  }
  async function snapshot(root: Root, rel: string): Promise<Snapshot> {
    const path = await checked(root, safePath(rel, false, false));
    const before = await lstat(path, { bigint: true });
    if (!before.isFile()) fail("INVALID_ARGUMENT", "path must be a regular file");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.nlink > 1n || !sameIdentity(before, info)) fail("CONFLICT", "file changed; refresh required");
      const limit = IMAGE_MIME[extname(rel).toLowerCase()] ? PROJECT_FILE_IMAGE_MAX_BYTES : PROJECT_FILE_TEXT_MAX_BYTES;
      if (info.size > BigInt(limit)) return { info };
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      await checked(root, rel);
      if (stamp(info) !== stamp(after) || BigInt(length) !== info.size || !sameIdentity(info, await lstat(path, { bigint: true }))) fail("CONFLICT", "file changed while reading; refresh required");
      const bytes = buffer.subarray(0, length);
      return { info, bytes, version: contentVersion(bytes, info) };
    } finally { await handle.close(); }
  }
  async function entry(root: Root, path: string): Promise<ProjectFileEntry> {
    const target = await checked(root, path);
    const info = await lstat(target, { bigint: true });
    if (!info.isFile() && !info.isDirectory()) fail("REMOTE_PATH_FORBIDDEN", "special files are not supported");
    return { name: basename(path), path, isDirectory: info.isDirectory(), size: Number(info.size), mtimeMs: mtime(info) };
  }
  async function scan(root: Root, start: string, recursive: boolean): Promise<{ entries: ProjectFileEntry[]; truncated: boolean }> {
    const pending = [safePath(start)];
    const entries: ProjectFileEntry[] = [];
    let scanned = 0;
    while (pending.length) {
      const dir = pending.shift()!;
      const directory = await opendir(await checked(root, dir));
      const children: string[] = [];
      for await (const item of directory) {
        scanned += 1;
        const rel = dir ? `${dir}/${item.name}` : item.name;
        try {
          if (!item.isSymbolicLink()) {
            const value = await entry(root, rel);
            entries.push(value);
            if (recursive && value.isDirectory) children.push(rel);
          }
        } catch (error) {
          // Hidden/protected and concurrently removed children are not exposed.
          const code = error instanceof RacpError ? error.code : (error as NodeJS.ErrnoException).code;
          if (!["REMOTE_PATH_FORBIDDEN", "REMOTE_PATH_NOT_FOUND", "ENOENT"].includes(code ?? "")) throw error;
        }
        if (scanned >= PROJECT_FILE_SCAN_LIMIT) return { entries: entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), truncated: true };
      }
      pending.push(...children.sort());
    }
    return { entries: entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), truncated: false };
  }
  function bounded(entries: ProjectFileEntry[], limit: number): ProjectFileEntry[] {
    let bytes = 2048;
    const result: ProjectFileEntry[] = [];
    for (const value of entries) {
      bytes += Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
      if (bytes > PROJECT_FILE_RESPONSE_MAX_BYTES || result.length >= limit) break;
      result.push(value);
    }
    return result;
  }
  function validate<K extends ProjectFilesMethod>(method: K, input: unknown): asserts input is ProjectFilesInputs[K] {
    if (!isProjectFilesInput(method, input)) fail("INVALID_ARGUMENT", "invalid project-file params");
  }
  function mutate<K extends "write" | "create" | "rename" | "move">(method: K, input: ProjectFilesInputs[K], principal: Principal | undefined, action: (root: Root) => Promise<ProjectFilesResults[K]>): Promise<ProjectFilesResults[K]> {
    validate(method, input);
    if (!principal?.subject || !principal.roles.includes("owner")) fail("FORBIDDEN", "project-file mutations require an authenticated owner");
    const key = JSON.stringify([principal.subject, input.projectId, input.requestId]);
    const digest = createHash("sha256").update(JSON.stringify([method, Object.entries(input).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
    for (const [oldKey, value] of replay) if (value.expires <= now()) replay.delete(oldKey);
    const previous = replay.get(key);
    if (previous) {
      if (previous.digest !== digest) fail("CONFLICT", "requestId was already used with different arguments");
      return previous.promise as Promise<ProjectFilesResults[K]>; // Same method and validated body digest.
    }
    if (replay.size >= REPLAY_LIMIT) fail("RATE_LIMITED", "project-file replay capacity reached; refresh before retrying later");
    const pending = queues.get(input.projectId) ?? Promise.resolve();
    const promise = pending.then(async () => action(await rootFor(input.projectId))).catch(fsError);
    const settled = promise.then(() => undefined, () => undefined);
    queues.set(input.projectId, settled);
    const record: Replay = { digest, promise, expires: Infinity };
    replay.set(key, record);
    void settled.then(() => {
      record.expires = now() + REPLAY_TTL_MS;
      if (queues.get(input.projectId) === settled) queues.delete(input.projectId);
    });
    return promise;
  }
  async function relocate(root: Root, from: string, to: string): Promise<ProjectFilesEntryResult> {
    safePath(from, true, false); safePath(to, true, false);
    // Renaming an ancestor of Host state is also a mutation of that state.
    await checkProtected(join(root.path, from), true);
    const source = await checked(root, from, true);
    const info = await lstat(source, { bigint: true });
    if (!info.isFile() && !info.isDirectory()) fail("INVALID_ARGUMENT", "only regular files and directories can be moved");
    if (info.isDirectory()) {
      const pending = [from];
      let scanned = 0;
      while (pending.length) {
        const dir = pending.pop()!;
        for await (const item of await opendir(await checked(root, dir, true))) {
          if (++scanned > PROJECT_FILE_SCAN_LIMIT) fail("INVALID_ARGUMENT", "directory is too large to safely relocate");
          const child = `${dir}/${item.name}`;
          await checked(root, child, true);
          if (item.isDirectory()) pending.push(child);
        }
      }
    }
    const target = await checked(root, to, true, true);
    if (source === target || (info.isDirectory() && within(source, target))) fail("INVALID_ARGUMENT", "cannot move a path into itself");
    if (await exists(target)) fail("CONFLICT", "destination already exists");
    await checked(root, from, true); await checked(root, to, true, true);
    if (!sameIdentity(info, await lstat(source, { bigint: true }))) fail("CONFLICT", "source changed; refresh required");
    if (await exists(target)) fail("CONFLICT", "destination already exists");
    await rename(source, target);
    return { ok: true, entry: await entry(root, to) };
  }
  return {
    async list(input) {
      validate("list", input);
      try {
        const path = input.path ?? "";
        const result = await scan(await rootFor(input.projectId), path, false);
        const entries = bounded(result.entries, PROJECT_FILE_LIST_LIMIT);
        return { ok: true, path, entries, truncated: result.truncated || entries.length < result.entries.length, ignoreActive: false };
      } catch (error) { return fsError(error); }
    },
    async read(input) {
      validate("read", input);
      try { return toRead(input.path, await snapshot(await rootFor(input.projectId), input.path)); } catch (error) { return fsError(error); }
    },
    async search(input) {
      validate("search", input);
      try {
        const root = await rootFor(input.projectId);
        const cursor = Number(input.cursor ?? 0);
        if (cursor > PROJECT_FILE_SCAN_LIMIT) fail("INVALID_ARGUMENT", "search cursor is out of range");
        const needle = input.query.trim().toLowerCase();
        const result = await scan(root, input.path ?? "", true);
        const all = needle ? result.entries.filter((value) => value.name.toLowerCase().includes(needle)) : [];
        const matches = bounded(all.slice(cursor), input.limit ?? PROJECT_FILE_SEARCH_LIMIT);
        const next = cursor + matches.length;
        return { ok: true, matches, ...(next < all.length ? { cursor: String(next) } : {}), truncated: result.truncated || next < all.length };
      } catch (error) { return fsError(error); }
    },
    async write(input, principal) {
      return mutate("write", input, principal, async (root): Promise<ProjectFilesWriteResult> => {
        safePath(input.path, true, false);
        const current = await snapshot(root, input.path);
        const read = toRead(input.path, current);
        if (read.kind !== "text") fail("INVALID_ARGUMENT", "only bounded UTF-8 text can be edited");
        if (read.version !== input.expectedVersion) fail("CONFLICT", "file changed; reread before saving");
        const normalized = input.text.replace(/\r\n|\r/g, "\n");
        const text = (input.eol ?? read.eol) === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
        const bytes = Buffer.from(`${(input.bom ?? read.bom) ? "\ufeff" : ""}${text}`, "utf8");
        if (Buffer.byteLength(input.text, "utf8") > PROJECT_FILE_TEXT_MAX_BYTES || bytes.length > PROJECT_FILE_TEXT_MAX_BYTES || !textOf(bytes)) fail("INVALID_ARGUMENT", "text exceeds the UTF-8 limit or contains binary data");
        const target = await checked(root, input.path, true);
        const temporary = join(dirname(target), `.pi-file-${randomUUID()}.tmp`);
        let committed = false;
        const handle = await open(temporary, "wx", Number(current.info.mode & 0o777n));
        try {
          await handle.writeFile(bytes);
          await handle.chmod(Number(current.info.mode & 0o777n));
          await handle.sync();
          await handle.close();
          await checked(root, input.path, true);
          if ((await snapshot(root, input.path)).version !== input.expectedVersion) fail("CONFLICT", "file changed before save; reread required");
          await checked(root, input.path, true);
          await rename(temporary, target);
          committed = true;
          const saved = await snapshot(root, input.path);
          if (!saved.bytes?.equals(bytes) || !saved.version) fail("CONFLICT", "file changed after save; refresh required");
          return { ok: true, path: input.path, size: bytes.length, mtimeMs: mtime(saved.info), version: saved.version };
        } finally {
          await handle.close();
          if (!committed) {
            const parent = input.path.includes("/") ? input.path.slice(0, input.path.lastIndexOf("/")) : "";
            await checked(root, parent, true);
            await unlink(temporary);
          }
        }
      });
    },
    async create(input, principal) {
      return mutate("create", input, principal, async (root) => {
        const parent = safePath(input.parent, true);
        const name = safeName(input.name);
        const path = parent ? `${parent}/${name}` : name;
        const target = await checked(root, path, true, true);
        await checked(root, parent, true);
        if (input.isDirectory) await mkdir(target);
        else { const handle = await open(target, "wx", 0o666); try { await handle.sync(); } finally { await handle.close(); } }
        return { ok: true as const, entry: await entry(root, path) };
      });
    },
    async rename(input, principal) {
      return mutate("rename", input, principal, async (root) => {
        safePath(input.path, true, false);
        const parent = input.path.includes("/") ? input.path.slice(0, input.path.lastIndexOf("/")) : "";
        const name = safeName(input.newName);
        return relocate(root, input.path, parent ? `${parent}/${name}` : name);
      });
    },
    async move(input, principal) {
      return mutate("move", input, principal, async (root) => {
        safePath(input.from, true, false); safePath(input.toDir, true);
        return relocate(root, input.from, input.toDir ? `${input.toDir}/${basename(input.from)}` : basename(input.from));
      });
    },
  };
}
