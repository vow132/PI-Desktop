import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
  FsEntry,
  FsReadResult,
  RacpProjectSummary,
  RacpSession,
  RemoteHostCapabilities,
  RemoteHostSessionRow,
  RemoteProjectSummary,
} from "@pi-desktop/shared";
import { makeRemoteSessionId } from "./backend-router.js";
import {
  parseRemoteProjectId,
  remoteProjectId,
  type RemoteProjectRecord,
  type RemoteProjectRegistry,
} from "./remote-projects.js";

export type RemoteFileOperation = "list" | "read" | "search" | "write" | "create" | "rename" | "move";
const OPERATIONS = new Set<string>(["list", "read", "search", "write", "create", "rename", "move"]);
const MUTATIONS = new Set<string>(["write", "create", "rename", "move"]);

export type RemoteProjectHost = {
  capabilities: RemoteHostCapabilities;
  request<T>(method: string, params: unknown): Promise<T>;
  registerSession(id: string): Promise<void>;
};
export type RemoteProjectServiceOptions = {
  registry: RemoteProjectRegistry;
  requireHost(hostKey: string): RemoteProjectHost;
  pairedHostKeys(): Promise<string[]>;
};

function refuse(code: string, message: string): never {
  throw Object.assign(new Error(message), { errorCode: code });
}
function summary(record: RemoteProjectRecord): RemoteProjectSummary {
  return { id: remoteProjectId(record.hostKey, record.hostProjectId), ...record };
}
function relativePath(value: unknown, allowRoot: boolean): string {
  const path = value === undefined && allowRoot ? "" : value;
  if (typeof path !== "string" || /[\\\0]/.test(path) || path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").includes("..")) {
    return refuse("INVALID_ARGUMENT", "A workspace-relative path is required.");
  }
  if (!allowRoot && !path) return refuse("INVALID_ARGUMENT", "A file path is required.");
  return path;
}

/** Registered remote-project identity and routing; never activates a local path. */
export function createRemoteProjectService(options: RemoteProjectServiceOptions) {
  const { registry, requireHost } = options;
  const projection = new Map<string, RemoteProjectSummary>();
  let revision = 0;
  const lookupProject = async (id: string): Promise<RemoteProjectSummary | undefined> => {
    const record = await registry.get(id);
    if (!record) return undefined;
    if (!(await options.pairedHostKeys()).includes(record.hostKey)) return undefined;
    return summary(record);
  };
  const requireProject = async (id: string): Promise<RemoteProjectSummary> => {
    return (await lookupProject(id)) ?? refuse("NOT_FOUND", "The remote project is no longer registered.");
  };
  const sessionRow = (hostKey: string, session: RacpSession, records: RemoteProjectRecord[]): RemoteHostSessionRow => {
    const project = records.find((row) => row.hostProjectId === session.projectId);
    return {
      id: makeRemoteSessionId(hostKey, session.id), hostKey,
      ...(project ? { remoteProjectId: remoteProjectId(hostKey, project.hostProjectId) } : {}),
      title: session.title, projectPath: project?.path ?? "", source: "remote",
      mode: session.mode, permissionMode: session.permissionMode,
      createdAt: session.createdAt, updatedAt: session.updatedAt,
    };
  };

  return {
    getProject(id: string): RemoteProjectSummary | undefined {
      const project = projection.get(id);
      return project ? { ...project } : undefined;
    },
    invalidateHost(hostKey: string): void {
      revision += 1;
      for (const [id, project] of projection) if (project.hostKey === hostKey) projection.delete(id);
    },
    async listProjects(hostKey?: string): Promise<RemoteProjectSummary[]> {
      const started = revision;
      const paired = new Set(await options.pairedHostKeys());
      const records = hostKey === undefined ? await registry.list() : await registry.listForHost(hostKey);
      // The remembered registration is the navigation source of truth, including
      // offline/empty projects. Never invent roots from path-less project/list.
      const result = records.filter((row) => paired.has(row.hostKey)).map(summary);
      if (started === revision) {
        for (const [id, project] of projection) {
          if (hostKey === undefined || project.hostKey === hostKey || !paired.has(project.hostKey)) projection.delete(id);
        }
        for (const project of result) projection.set(project.id, project);
      }
      return result;
    },
    async registerProject(hostKey: string, input: { path: string; name?: string }): Promise<RemoteProjectSummary> {
      const host = requireHost(hostKey);
      const response = await host.request<RacpProjectSummary & { path: string }>("project/register", { path: input.path });
      if (!response?.id || typeof response.path !== "string" || !response.path.startsWith("/")) {
        return refuse("INTERNAL", "The remote host returned an invalid project registration.");
      }
      if (!(await options.pairedHostKeys()).includes(hostKey)) {
        return refuse("AGENT_UNAVAILABLE", "The remote host was removed during registration.");
      }
      const previous = await registry.get(remoteProjectId(hostKey, response.id));
      const now = new Date().toISOString();
      const record: RemoteProjectRecord = {
        hostKey, hostProjectId: response.id, path: response.path,
        name: input.name?.trim() || previous?.name || response.label || posix.basename(response.path),
        createdAt: previous?.createdAt ?? now, updatedAt: now,
      };
      await registry.upsert(record);
      const result = summary(record);
      revision += 1;
      projection.set(result.id, result);
      return result;
    },
    async removeProject(id: string): Promise<void> {
      if (!parseRemoteProjectId(id)) return refuse("INVALID_ARGUMENT", "Invalid remote project identity.");
      // Forgetting a desktop workspace never removes remote files or the host's
      // registered project. It also works while the host is offline.
      await registry.remove(id);
      revision += 1;
      projection.delete(id);
    },
    async listSessions(hostKey: string): Promise<RemoteHostSessionRow[]> {
      const host = requireHost(hostKey);
      const response = await host.request<{ sessions: RacpSession[] }>("session/list", {});
      const records = await registry.listForHost(hostKey);
      return (response.sessions ?? []).map((session) => sessionRow(hostKey, session, records));
    },
    async createSession(hostKey: string, input: {
      projectId: string; title?: string; mode?: string; permissionMode?: string;
      providerId?: string; modelId?: string; thinkingLevel?: string;
    }): Promise<RemoteHostSessionRow> {
      const project = await requireProject(remoteProjectId(hostKey, input.projectId));
      const host = requireHost(hostKey);
      const response = await host.request<{ session: RacpSession }>("session/create", { ...input, projectId: project.hostProjectId });
      if (!response.session?.id || response.session.projectId !== project.hostProjectId) {
        return refuse("INTERNAL", "The remote host returned a session outside the selected project.");
      }
      await host.registerSession(response.session.id);
      return sessionRow(hostKey, response.session, [project]);
    },
    async fileOperation(id: string, operation: RemoteFileOperation, payload: Record<string, unknown>): Promise<unknown> {
      if (!OPERATIONS.has(operation)) return refuse("INVALID_ARGUMENT", "Unsupported project file operation.");
      const project = await requireProject(id);
      const host = requireHost(project.hostKey);
      const capabilities = host.capabilities.projectFiles;
      const mutation = MUTATIONS.has(operation);
      if (capabilities?.version === 1 && capabilities.read) {
        if (mutation && !capabilities.write) return refuse("CAPABILITY_UNAVAILABLE", "This remote workspace is read-only.");
        // Request identity is authoritative here; payload cannot select a host,
        // arbitrary root, or another registered project. Never retry a mutation
        // after a network failure: it may already have committed on the host.
        return host.request(`project/files/${operation}`, {
          ...payload,
          ...(mutation ? { requestId: typeof payload.requestId === "string" ? payload.requestId : randomUUID() } : {}),
          projectId: project.hostProjectId,
        });
      }
      if (mutation || operation === "search") {
        return refuse("CAPABILITY_UNAVAILABLE", "Upgrade pi-host to enable remote file editing. This host supports read-only browsing.");
      }
      // Compatibility with the existing session-rooted read profile. A host
      // without a session for this project must upgrade; do not create chats
      // merely to browse, and never substitute the desktop's local workspace.
      const response = await host.request<{ sessions: RacpSession[] }>("session/list", {});
      const session = response.sessions.find((row) => row.projectId === project.hostProjectId);
      if (!session) return refuse("CAPABILITY_UNAVAILABLE", "Upgrade pi-host to browse this project without creating a session.");
      const rel = relativePath(payload.path, operation === "list");
      if (operation === "list") {
        const result = await host.request<{ entries: FsEntry[] }>("workspace/list", { sessionId: session.id, path: rel });
        return { ok: true, path: rel, entries: result.entries.map((entry) => ({
          name: entry.name, path: rel ? `${rel}/${entry.name}` : entry.name,
          isDirectory: entry.kind === "dir", size: entry.size,
        })), truncated: false, ignoreActive: false, readOnly: true };
      }
      const result = await host.request<FsReadResult>("workspace/read", { sessionId: session.id, path: rel });
      const base = { ok: true, path: rel, size: result.size, readOnly: true };
      if (result.kind === "text") return { ...base, kind: "text", text: result.content ?? "", eol: "lf", bom: false };
      if (result.kind === "image") return { ...base, kind: "image", dataUri: result.dataUrl };
      if (result.kind === "tooLarge") return { ...base, kind: "tooLarge", limit: 128 * 1024 };
      return { ...base, kind: "binary" };
    },
  };
}
