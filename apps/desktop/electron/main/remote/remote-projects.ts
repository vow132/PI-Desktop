import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Remote-project projections, separate from Rust's local project database. */
export interface RemoteProjectEncryptionPort {
  isAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}
export type RemoteProjectRecord = {
  hostKey: string;
  hostProjectId: string;
  path: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};
type SerializedRecord = {
  hostKey: string;
  hostProjectId: string;
  sealed?: string;
  path?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
};
type SerializedFile = { version: 1; projects: SerializedRecord[] };
export type RemoteProjectRegistryOptions = {
  dataDir: string;
  encryption?: RemoteProjectEncryptionPort;
  fileName?: string;
  log?: (level: "warn" | "error", message: string, data?: unknown) => void;
};
export interface RemoteProjectRegistry {
  list(): Promise<RemoteProjectRecord[]>;
  listForHost(hostKey: string): Promise<RemoteProjectRecord[]>;
  get(id: string): Promise<RemoteProjectRecord | null>;
  upsert(record: RemoteProjectRecord): Promise<void>;
  remove(id: string): Promise<void>;
  removeForHost(hostKey: string): Promise<void>;
}

export function remoteProjectId(hostKey: string, hostProjectId: string): string {
  if (!hostKey || hostKey.includes(":") || !hostProjectId) {
    throw Object.assign(new Error("Invalid remote project identity"), { errorCode: "INVALID_ARGUMENT" });
  }
  return `remote-project:${hostKey}:${hostProjectId}`;
}
export function parseRemoteProjectId(id: string): { hostKey: string; hostProjectId: string } | null {
  if (typeof id !== "string" || !id.startsWith("remote-project:")) return null;
  const rest = id.slice("remote-project:".length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { hostKey: rest.slice(0, separator), hostProjectId: rest.slice(separator + 1) };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function notFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
function validSerialized(value: unknown): value is SerializedRecord {
  return isRecord(value) && typeof value.hostKey === "string" && value.hostKey.length > 0 &&
    !value.hostKey.includes(":") && typeof value.hostProjectId === "string" && value.hostProjectId.length > 0;
}

/**
 * One Main-owned queue serializes read/modify/write transactions. Reads wait for
 * earlier writes, and a failed write does not poison subsequent transactions.
 * Format v1 and sealed/plaintext compatibility are unchanged. A corrupt file
 * is never overwritten as if it were empty; callers retain their previous UI.
 */
export function createRemoteProjectRegistry(options: RemoteProjectRegistryOptions): RemoteProjectRegistry {
  const log = options.log ?? (() => undefined);
  const filePath = join(options.dataDir, options.fileName ?? "remote-projects.json");
  const encryption = options.encryption;
  let pending: Promise<void> = Promise.resolve();
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }
  async function read(): Promise<SerializedFile> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      if (notFound(error)) return { version: 1, projects: [] };
      log("error", "remote project registry could not be read");
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch {
      log("error", "remote project registry contains invalid JSON; preserving file");
      throw new Error("Remote project registry is corrupt; the existing file was preserved.");
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.projects)) {
      throw new Error("Unsupported remote project registry format; the existing file was preserved.");
    }
    const records = parsed.projects.filter(validSerialized);
    if (records.length !== parsed.projects.length) log("warn", "invalid remote project records skipped");
    return { version: 1, projects: records };
  }
  async function persist(file: SerializedFile): Promise<void> {
    await mkdir(options.dataDir, { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => log("warn", "remote project temporary-file cleanup failed"));
      throw error;
    }
  }
  function decode(record: SerializedRecord): RemoteProjectRecord | null {
    let fields: Record<string, unknown> = record;
    if (record.sealed !== undefined) {
      if (!encryption || typeof record.sealed !== "string") {
        log("warn", "sealed remote project unavailable without encryption");
        return null;
      }
      try {
        const value: unknown = JSON.parse(encryption.decryptString(Buffer.from(record.sealed, "base64")));
        if (!isRecord(value)) return null;
        fields = value;
      } catch {
        log("warn", "remote project record could not be decrypted");
        return null;
      }
    }
    if (typeof fields.path !== "string" || !fields.path.startsWith("/") || typeof fields.name !== "string") return null;
    return {
      hostKey: record.hostKey, hostProjectId: record.hostProjectId,
      path: fields.path, name: fields.name,
      createdAt: typeof fields.createdAt === "string" ? fields.createdAt : "",
      updatedAt: typeof fields.updatedAt === "string" ? fields.updatedAt : "",
    };
  }
  async function listAll(): Promise<RemoteProjectRecord[]> {
    return (await read()).projects.map(decode).filter((row): row is RemoteProjectRecord => row !== null);
  }
  async function removeWhere(predicate: (row: SerializedRecord) => boolean): Promise<void> {
    const file = await read();
    const next = file.projects.filter((row) => !predicate(row));
    if (next.length !== file.projects.length) await persist({ version: 1, projects: next });
  }
  return {
    list: () => serialized(listAll),
    listForHost: (hostKey) => serialized(async () => (await listAll()).filter((row) => row.hostKey === hostKey)),
    get: (id) => serialized(async () => {
      const parsed = parseRemoteProjectId(id);
      if (!parsed) return null;
      return (await listAll()).find((row) => row.hostKey === parsed.hostKey && row.hostProjectId === parsed.hostProjectId) ?? null;
    }),
    upsert: (record) => serialized(async () => {
      remoteProjectId(record.hostKey, record.hostProjectId);
      if (!record.path.startsWith("/")) throw new Error("Remote project path must be absolute.");
      const file = await read();
      const other = file.projects.filter((row) => row.hostKey !== record.hostKey || row.hostProjectId !== record.hostProjectId);
      const fields = { path: record.path, name: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt };
      const stored: SerializedRecord = encryption?.isAvailable()
        ? { hostKey: record.hostKey, hostProjectId: record.hostProjectId, sealed: encryption.encryptString(JSON.stringify(fields)).toString("base64") }
        : { hostKey: record.hostKey, hostProjectId: record.hostProjectId, ...fields };
      await persist({ version: 1, projects: [...other, stored] });
    }),
    remove: (id) => serialized(async () => {
      const parsed = parseRemoteProjectId(id);
      if (parsed) await removeWhere((row) => row.hostKey === parsed.hostKey && row.hostProjectId === parsed.hostProjectId);
    }),
    removeForHost: (hostKey) => serialized(() => removeWhere((row) => row.hostKey === hostKey)),
  };
}
