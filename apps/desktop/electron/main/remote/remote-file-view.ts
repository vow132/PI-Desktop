import { randomUUID } from "node:crypto";
import type { PluginViewContrib } from "@pi-desktop/plugin-sdk";
import type { RemoteProjectSummary } from "@pi-desktop/shared";
import type { RemoteFileOperation } from "./remote-project-service";
import {
  fileViewError,
  fileViewFailure,
  fileViewName,
  fileViewPath,
  fileViewPrefs,
  record,
  type FileViewBinding,
} from "./remote-file-view-contract";

export type FileOperation = RemoteFileOperation;
export type RemoteFileViewBoot = {
  getProject(id: string): RemoteProjectSummary | undefined;
  list(): Promise<ReadonlyArray<{
    hostKey: string;
    connected: boolean;
    capabilities?: { projectFiles?: { version: 1; read: boolean; write: boolean } };
  }>>;
  fileOperation(projectId: string, operation: FileOperation, payload: Record<string, unknown>): Promise<unknown>;
};
export type RemoteFileViewInvocation = {
  pluginId: string;
  senderId?: number;
  channel: string;
  payload?: Record<string, unknown>;
  permissions: ReadonlySet<string>;
  views: readonly PluginViewContrib[];
  getSettings(): Promise<Record<string, unknown>>;
  invokePreferences(payload: Record<string, unknown>): Promise<unknown>;
};

type Revision = { version: string; mtimeMs: number; size: number };
type ViewState = { generation: number; revisions: Map<string, Revision>; mutating: boolean };
const MUTATIONS = new Set(["write", "create", "rename", "move"]);
const READS = new Set(["hello", "prefs.get", "list", "read", "search"]);
const MAX_REVISIONS = 128;
const MAX_BYTES = 131072;

/** Host-owned remote workspace adapter. It never falls back to local fs. */
export class RemoteFileViewService {
  private readonly states = new Map<number, ViewState>();
  private readonly bindingForSender: (senderId: number) => FileViewBinding | null;
  private readonly getBoot: () => RemoteFileViewBoot | null;

  constructor(
    bindingForSender: (senderId: number) => FileViewBinding | null,
    getBoot: () => RemoteFileViewBoot | null,
  ) {
    this.bindingForSender = bindingForSender;
    this.getBoot = getBoot;
  }

  release(senderId: number): void { this.states.delete(senderId); }
  dispose(): void { this.states.clear(); }

  /** undefined means an authenticated local view; remote failures are values. */
  intercept(input: RemoteFileViewInvocation): Promise<unknown> | undefined {
    if (input.senderId === undefined) return undefined;
    const binding = this.bindingForSender(input.senderId);
    if (!binding) return Promise.resolve(fileViewFailure(fileViewError("STALE_CONTEXT", "Unknown view sender")));
    if (!binding.remoteProjectId) return undefined;
    // Non-workspace host APIs retain their existing local implementation.
    if (["app.getAppearance", "clipboard.writeText", "ui.showToast", "plugin.getSettings"].includes(input.channel)) return undefined;
    return this.invoke(input, binding, input.senderId);
  }

  private async invoke(input: RemoteFileViewInvocation, binding: FileViewBinding, senderId: number): Promise<unknown> {
    let mutationSent = false;
    let mutationState: ViewState | undefined;
    try {
      const declaration = input.views.find((view) => view.id === binding.viewId)?.workspaceFiles;
      if (binding.pluginId !== input.pluginId || !declaration || declaration.version !== 1 ||
          !input.permissions.has("ui.view") || !input.permissions.has("workspace.remote.read")) {
        throw fileViewError("PERMISSION_DENIED", "Remote file view access denied");
      }
      const boot = this.getBoot();
      const project = boot?.getProject(binding.remoteProjectId!);
      if (!boot || !project) throw fileViewError("NOT_FOUND", "Registered project unavailable");
      const snapshot = { ...project };
      const current = () => {
        const live = this.bindingForSender(senderId);
        const registered = boot.getProject(snapshot.id);
        if (this.getBoot() !== boot || !live || (input.channel !== "workspace.get" && !live.active) ||
            live.pluginId !== binding.pluginId || live.generation !== binding.generation ||
            live.activity !== binding.activity || live.remoteProjectId !== snapshot.id ||
            registered?.path !== snapshot.path || registered.hostProjectId !== snapshot.hostProjectId ||
            registered.hostKey !== snapshot.hostKey) {
          throw fileViewError("STALE_CONTEXT", "Remote view changed");
        }
      };
      current();
      const root = {
        path: snapshot.path,
        name: snapshot.name,
        projectId: snapshot.id,
        roots: [{ path: snapshot.path, name: snapshot.name, primary: true }],
      };
      if (input.channel === "workspace.get") return root;

      const prefix = `${declaration.channelPrefix}.`;
      if (!input.channel.startsWith(prefix)) throw fileViewError("UNSUPPORTED", "Remote channel unavailable");
      const operation = input.channel.slice(prefix.length);
      const payload = record(input.payload);
      if (payload.external === true) throw fileViewError("OUTSIDE_ROOT", "External remote files are not permitted");
      if (operation === "prefs.set") {
        const result = record(await input.invokePreferences({ partial: fileViewPrefs(record(payload.partial), false) }));
        current();
        if (result.ok !== true) throw fileViewError("REMOTE_UNAVAILABLE", "Preferences could not be saved");
        return { ok: true, prefs: fileViewPrefs(result.prefs) };
      }
      if (!READS.has(operation) && !MUTATIONS.has(operation)) throw fileViewError("UNSUPPORTED", "Remote preview or operation unavailable");
      const mutation = MUTATIONS.has(operation);
      if (mutation && !input.permissions.has("workspace.remote.write")) throw fileViewError("PERMISSION_DENIED", "Remote writes have not been approved");

      const host = (await boot.list()).find((candidate) => candidate.hostKey === snapshot.hostKey);
      current();
      if (!host?.connected) throw fileViewError("OFFLINE", "Remote host disconnected");
      const capability = host.capabilities?.projectFiles;
      if (capability?.version !== 1 || !capability.read) throw fileViewError("UNSUPPORTED", "Upgrade the remote host for project file access");
      if (mutation && !capability.write) throw fileViewError("READ_ONLY", "Host does not support remote writes");
      if (operation === "hello" || operation === "prefs.get") {
        const settings = await input.getSettings();
        current();
        return { ok: true, root, limits: { maxReadBytes: MAX_BYTES, maxWriteBytes: MAX_BYTES, maxListEntries: 1000 }, ignoreFiles: [], prefs: fileViewPrefs(settings.fmPrefs) };
      }

      let state = this.states.get(senderId);
      if (!state || state.generation !== binding.generation) {
        state = { generation: binding.generation, revisions: new Map(), mutating: false };
        this.states.set(senderId, state);
      }
      if (state.mutating) throw fileViewError("BUSY", "File change in progress");
      const safePath = (value: unknown, allowRoot = false) => fileViewPath(value, root.path, allowRoot);
      let request: Record<string, unknown>;
      switch (operation) {
        case "list": request = { path: safePath(payload.path ?? "", true) }; break;
        case "read": request = { path: safePath(payload.path) }; break;
        case "search": {
          if (typeof payload.query !== "string" || payload.query.length > 256) throw fileViewError("INVALID_ARGUMENT", "Invalid search");
          const cursor = payload.cursor;
          if (cursor != null && (typeof cursor !== "string" || !/^(0|[1-9][0-9]{0,3})$/.test(cursor))) throw fileViewError("INVALID_ARGUMENT", "Invalid cursor");
          request = { path: safePath(payload.path ?? "", true), query: payload.query, ...(cursor == null ? {} : { cursor }), limit: Math.min(200, Math.max(1, Math.floor(Number(payload.limit) || 200))) };
          break;
        }
        case "write": {
          const relative = safePath(payload.path);
          const revision = state.revisions.get(relative);
          if (!revision) throw fileViewError("READ_ONLY", "Read this file before saving");
          if ((payload.expectedMtimeMs !== undefined && payload.expectedMtimeMs !== revision.mtimeMs) || (payload.expectedSize !== undefined && payload.expectedSize !== revision.size)) throw fileViewError("CONFLICT", "Editor revision does not match the last read");
          if (typeof payload.text !== "string" || Buffer.byteLength(payload.text, "utf8") > MAX_BYTES) throw fileViewError("TOO_LARGE", "Text exceeds the remote write limit");
          request = { path: relative, text: payload.text, expectedVersion: revision.version, ...(payload.eol === "lf" || payload.eol === "crlf" ? { eol: payload.eol } : {}), ...(typeof payload.bom === "boolean" ? { bom: payload.bom } : {}) };
          break;
        }
        case "create":
          if (typeof payload.isDirectory !== "boolean") throw fileViewError("INVALID_ARGUMENT", "Expected file or directory type");
          request = { parent: safePath(payload.parent ?? "", true), name: fileViewName(payload.name), isDirectory: payload.isDirectory };
          break;
        case "rename": request = { path: safePath(payload.path), newName: fileViewName(payload.newName) }; break;
        case "move": request = { from: safePath(payload.from), toDir: safePath(payload.toDir ?? "", true) }; break;
        default: throw fileViewError("UNSUPPORTED", "Unknown remote file operation");
      }

      current();
      if (mutation) {
        state.mutating = true;
        mutationState = state;
        request.requestId = randomUUID();
        mutationSent = true;
      }
      const result = record(await boot.fileOperation(snapshot.id, operation as FileOperation, request));
      current();
      if (result.ok !== true) throw fileViewError(typeof result.code === "string" ? result.code : "REMOTE_UNAVAILABLE", "Remote operation failed");
      if (operation === "read") {
        const relative = String(request.path);
        state.revisions.delete(relative);
        if (typeof result.version === "string" && result.version && typeof result.mtimeMs === "number" && typeof result.size === "number") {
          state.revisions.set(relative, { version: result.version, mtimeMs: result.mtimeMs, size: result.size });
          if (state.revisions.size > MAX_REVISIONS) state.revisions.delete(state.revisions.keys().next().value!);
        }
        const { version: _version, ...visible } = result;
        return visible;
      }
      if (operation === "write") {
        const relative = String(request.path);
        state.revisions.delete(relative);
        if (typeof result.version === "string" && result.version && typeof result.mtimeMs === "number" && typeof result.size === "number") state.revisions.set(relative, { version: result.version, mtimeMs: result.mtimeMs, size: result.size });
        return result;
      }
      if (mutation) state.revisions.clear();
      if (operation === "search") return { ...result, nextCursor: typeof result.cursor === "string" ? result.cursor : null, done: typeof result.cursor !== "string", scanned: 0 };
      return result;
    } catch (error) {
      if (mutationSent) this.states.get(senderId)?.revisions.clear();
      return fileViewFailure(error, mutationSent);
    } finally {
      if (mutationState) mutationState.mutating = false;
    }
  }
}
