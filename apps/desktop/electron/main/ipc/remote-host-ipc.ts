/**
 * Renderer IPC for the R2b pairing UX (ADR 0286 §Registry) and the SSH
 * bootstrap (spec `02-architecture/05-remote-agent-control.md` §5.2).
 *
 * Four channels sit between the renderer's Settings page and the remote-hosts
 * boot hook: `list` reports the currently paired hosts with their live status,
 * `pair` exchanges a pasted `ppt1.` pairing token for a durable device token,
 * `bootstrap` installs and pairs a host on a machine the user reaches over
 * SSH, and `remove` closes and forgets one host.
 *
 * The renderer never sees a device token: the pairing exchange, the encrypted
 * write to `<dataDir>/remote-hosts.json`, and every subsequent live connection
 * live inside Electron main. `list` is safe to expose to any renderer surface.
 * The bootstrap channel never sees an SSH secret either — it passes a host,
 * and the system `ssh` client supplies the credentials from the user's own
 * configuration and agent.
 */
import {
  ErrorCodes,
  IPC,
  type RemoteHostBootstrapRequest,
  type RemoteHostBootstrapResult,
  type RemoteHostPairRequest,
  type RemoteHostPairResult,
  type RemoteHostRemoveRequest,
  type RemoteHostSummary,
  type RemoteProjectSummary,
  type RemoteSessionCreateRequest,
} from "@pi-desktop/shared";
import { app } from "electron";
import {
  getActiveRemoteHostsBoot,
  type RemoteHostsBoot,
  type RemoteBrowseResult,
  type RemoteSessionRow,
} from "../bootstrap/remote-hosts.js";
import { exchangePairingToken } from "../remote/racp-remote-host-client.js";
import { parseRemoteSessionId } from "../remote/backend-router.js";
import type { RemoteTerminalManager, RemoteTerminalOpenResult } from "../remote/remote-terminal.js";
import type { IpcRegistrar } from "./types";

export type RegisterRemoteHostIpcOptions = {
  registrar: IpcRegistrar;
  /**
   * Optional overrides for tests. Production reads the boot singleton set by
   * `bootstrap/startup.ts` (so no new field flows through `index.ts`) and
   * derives `clientInfo` from Electron's app name/version.
   */
  getRemoteHostsBoot?: () => RemoteHostsBoot | null;
  clientInfo?: { name: string; version: string };
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

function requireBoot(boot: RemoteHostsBoot | null): RemoteHostsBoot {
  if (!boot) {
    throw Object.assign(new Error("remote hosts are not ready yet"), {
      errorCode: ErrorCodes.AGENT_UNAVAILABLE,
    });
  }
  return boot;
}

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function invalid(message: string, field?: string): Error {
  return Object.assign(new Error(message), {
    errorCode: ErrorCodes.INVALID_ARGUMENT,
    ...(field ? { field } : {}),
  });
}

/**
 * Derive a routing key from a URL and a label when the renderer did not
 * supply one. The URL's hostname keeps the key readable in logs; the label's
 * ASCII-safe slug disambiguates two hosts on the same machine (e.g., a WSL
 * and a native install of `pi-host` on `localhost`).
/**
 * Host key of a namespaced remote session id, or null when the id is not one.
 * A terminal call names its host through the session it belongs to, so the
 * renderer can never address a host it did not name.
 */
function remoteSessionHostKey(sessionId: string): string | null {
  if (!sessionId) return null;
  return parseRemoteSessionId(sessionId)?.hostKey ?? null;
}

/** Geometry is clamped here, so the host's own bounds are never the last word. */
function clampGeometry(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

/**
 * Resolve a `terminalId` to the manager that owns it. Terminal ids are host
 * -scoped, so every live host is asked rather than trusting the caller; a
 * value no host knows is `AGENT_UNAVAILABLE`, never a silent no-op.
 */
function requireTerminal(boot: RemoteHostsBoot, terminalId: string): RemoteTerminalManager {
  if (!terminalId) throw invalid("terminalId is required", "terminalId");
  const manager = boot.terminalForId(terminalId);
  if (!manager) {
    throw Object.assign(new Error("terminal is not open on any remote host"), {
      errorCode: ErrorCodes.AGENT_UNAVAILABLE,
    });
  }
  return manager;
}
function synthesizeHostKey(url: string, label: string): string {
  let hostname = "host";
  try {
    hostname = new URL(url).hostname || hostname;
  } catch {
    /* keep the fallback */
  }
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug ? `${hostname}-${slug}` : hostname;
}

export function registerRemoteHostIpc(options: RegisterRemoteHostIpcOptions): void {
  const { registrar } = options;
  const getRemoteHostsBoot = options.getRemoteHostsBoot ?? getActiveRemoteHostsBoot;
  const clientInfo =
    options.clientInfo ?? { name: app.getName(), version: app.getVersion() };
  const log = options.log ?? (() => undefined);

  registrar.handle(
    IPC.invoke.remoteHostBrowse,
    async (request: { hostKey?: string; path?: string }): Promise<RemoteBrowseResult> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const hostKey = trim(request?.hostKey);
      if (!hostKey) throw invalid("hostKey is required", "hostKey");
      // A relative path is meaningless on the remote machine: the host's
      // browse canonicalizes what it is given, and `..` is how a caller would
      // otherwise try to walk out of the user's home.
      const path = trim(request?.path);
      if (path && !path.startsWith("/")) {
        throw invalid("path must be absolute on the remote host", "path");
      }
      return boot.browse(hostKey, path || undefined);
    },
  );

  registrar.handle(
    IPC.invoke.remoteHostProjectList,
    async (request?: { hostKey?: string }): Promise<{ projects: RemoteProjectSummary[] }> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const hostKey = trim(request?.hostKey);
      return { projects: await boot.listProjects(hostKey || undefined) };
    },
  );

  registrar.handle(
    IPC.invoke.remoteHostProjectRegister,
    async (
      request: { hostKey?: string; path?: string; name?: string },
    ): Promise<{ project: RemoteProjectSummary }> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const hostKey = trim(request?.hostKey);
      if (!hostKey) throw invalid("hostKey is required", "hostKey");
      const path = trim(request?.path);
      if (!path.startsWith("/")) {
        throw invalid("path must be absolute on the remote host", "path");
      }
      return { project: await boot.registerProject(hostKey, { path, name: request?.name }) };
    },
  );

  registrar.handle(
    IPC.invoke.remoteHostProjectRemove,
    async (request: { id?: string }): Promise<{ ok: true }> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const id = trim(request?.id);
      if (!id) throw invalid("id is required", "id");
      await boot.removeProject(id);
      return { ok: true };
    },
  );

  registrar.handle(
    IPC.invoke.remoteHostSessionList,
    async (request: { hostKey?: string }): Promise<{ sessions: RemoteSessionRow[] }> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const hostKey = trim(request?.hostKey);
      if (!hostKey) throw invalid("hostKey is required", "hostKey");
      return { sessions: await boot.listSessions(hostKey) };
    },
  );

  registrar.handle(
    IPC.invoke.remoteHostSessionCreate,
    async (request: RemoteSessionCreateRequest): Promise<{ session: RemoteSessionRow }> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const hostKey = trim(request?.hostKey);
      if (!hostKey) throw invalid("hostKey is required", "hostKey");
      const projectId = trim(request?.projectId);
      if (!projectId) throw invalid("projectId is required", "projectId");
      return { session: await boot.createSession(hostKey, { ...request, projectId }) };
    },
  );

  registrar.handle(
    IPC.invoke.remoteTerminalOpen,
    async (request: {
      sessionId?: string;
      cols?: number;
      rows?: number;
      terminalId?: string;
    }): Promise<RemoteTerminalOpenResult> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const sessionId = trim(request?.sessionId);
      const hostKey = remoteSessionHostKey(sessionId);
      if (!hostKey) throw invalid("sessionId must name a remote session", "sessionId");
      const terminal = boot.terminal(hostKey);
      if (!terminal) {
        throw Object.assign(new Error(`remote host ${hostKey} is not connected`), {
          errorCode: ErrorCodes.AGENT_UNAVAILABLE,
        });
      }
      return terminal.open(sessionId, {
        cols: clampGeometry(request?.cols, 80),
        rows: clampGeometry(request?.rows, 24),
        ...(trim(request?.terminalId) ? { terminalId: trim(request.terminalId) } : {}),
      });
    },
  );

  registrar.handle(
    IPC.invoke.remoteTerminalInput,
    async (request: { terminalId?: string; data?: string }): Promise<{ ok: true }> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const terminal = requireTerminal(boot, trim(request?.terminalId));
      await terminal.input(trim(request?.terminalId), String(request?.data ?? ""));
      return { ok: true };
    },
  );

  registrar.handle(
    IPC.invoke.remoteTerminalResize,
    async (request: { terminalId?: string; cols?: number; rows?: number }): Promise<{ ok: true }> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const terminal = requireTerminal(boot, trim(request?.terminalId));
      await terminal.resize(
        trim(request?.terminalId),
        clampGeometry(request?.cols, 80),
        clampGeometry(request?.rows, 24),
      );
      return { ok: true };
    },
  );

  registrar.handle(
    IPC.invoke.remoteTerminalClose,
    async (request: { terminalId?: string }): Promise<{ ok: true }> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const terminal = requireTerminal(boot, trim(request?.terminalId));
      await terminal.close(trim(request?.terminalId));
      return { ok: true };
    },
  );
  registrar.handle(
    IPC.invoke.remoteHostList,
    async (): Promise<{ hosts: RemoteHostSummary[] }> => {
      const boot = requireBoot(getRemoteHostsBoot());
      return { hosts: await boot.list() };
    },
  );

  registrar.handle(
    IPC.invoke.remoteHostPair,
    async (request: RemoteHostPairRequest): Promise<RemoteHostPairResult> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const url = trim(request?.url);
      const pairingToken = trim(request?.pairingToken);
      const label = trim(request?.label) || "desktop";
      if (!url || !pairingToken) {
        throw invalid("url and pairingToken are required");
      }
      const hostKey = trim(request?.hostKey) || synthesizeHostKey(url, label);
      if (hostKey.includes(":")) {
        throw invalid("hostKey must not contain ':'", "hostKey");
      }

      // Pair on a throwaway connection whose transport authenticates with the
      // single-use pairing token; call `connection/pair` for the device token,
      // then close it. The durable connection reopens under the device token
      // via `boot.addHost` below.
      const deviceToken = await exchangePairingToken({
        url,
        pairingToken,
        label,
        clientInfo,
        log: (level, message, data) => log(level, message, data),
      });

      const summary = await boot.addHost({ hostKey, label, url, deviceToken });
      return { host: summary };
    },
  );

  registrar.handle(
    IPC.invoke.remoteHostBootstrap,
    async (request: RemoteHostBootstrapRequest): Promise<RemoteHostBootstrapResult> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const host = trim(request?.host);
      if (!host) throw invalid("host is required", "host");
      const label = trim(request?.label) || host;
      // The descriptor's own validation (empty and leading-dash fields, port
      // range) lives with the bootstrap, which is the only place that knows
      // how the values reach the `ssh` command line.
      return await boot.bootstrapHost({ ...request, host, label });
    },
  );

  registrar.handle(
    IPC.invoke.remoteHostRemove,
    async (request: RemoteHostRemoveRequest): Promise<{ ok: true }> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const hostKey = trim(request?.hostKey);
      if (!hostKey) {
        throw invalid("hostKey is required", "hostKey");
      }
      await boot.removeHost(hostKey);
      return { ok: true };
    },
  );
}
