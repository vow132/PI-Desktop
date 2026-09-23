/**
 * Boot every paired remote host. Reads the persisted registry, builds a
 * `RemoteHostConnection` per record, opens them, and returns a disposer that
 * `bootstrap/shutdown.ts` calls on quit. An empty registry (the default
 * install with no user pairing) is a full no-op: nothing runs, the router
 * has no remote backends, and every renderer call keeps hitting the local
 * handler byte-for-byte.
 *
 * The transport factory is injected. Production wires it to
 * `wsClientTransport` from `@pi-desktop/racp` (loopback for local dev, the
 * forwarded loopback port for an SSH-bootstrapped host); tests wire the
 * in-memory `MemoryLink` so this boot layer exercises the real `RacpClient`
 * state machine without a socket.
 *
 * Two shapes of paired host live here. A `direct` host stores the URL the user
 * pasted, including a forward they opened themselves. An `ssh` host stores a
 * descriptor instead, and this layer owns a live `ssh -N -L` forward for it
 * (`remote/ssh-tunnel.ts`) — the URL is derived from that forward on every
 * launch, so a restart re-establishes the tunnel before connecting.
 */
import type {
  RemoteHostBootstrapRequest,
  RemoteHostBootstrapResult,
  RemoteHostCapabilities,
  RemoteHostSessionRow,
  RemoteHostSshMetadata,
  RemoteHostSummary,
  RemoteHostTransport,
  RemoteProjectSummary,
} from "@pi-desktop/shared";
import { assertSshArgument } from "../remote/ssh-transport.js";
import { wsClientTransport } from "@pi-desktop/racp";
import type { BackendRouter } from "../remote/backend-router.js";
import { makeRemoteSessionId } from "../remote/backend-router.js";
import { createRacpRemoteHostClient, exchangePairingToken, type RacpRemoteHostClient } from "../remote/racp-remote-host-client.js";
import {
  createSshBootstrap,
  type SshBootstrapDeps,
} from "../remote/ssh-bootstrap.js";
import { createSshTunnelManager, type SshTunnelManager } from "../remote/ssh-tunnel.js";
import {
  createRemoteHostConnection,
  type RemoteHostConnection,
} from "../remote/remote-host-connection.js";
import {
  createRemoteHostRegistry,
  type EncryptionPort,
  type RemoteHostRecord,
  type RemoteHostRegistry,
} from "../remote/remote-host-registry.js";
import {
  createRemoteProjectRegistry,
  type RemoteProjectRegistry,
  type RemoteProjectEncryptionPort,
} from "../remote/remote-projects.js";
import {
  createRemoteTerminalManager,
  type RemoteTerminalManager,
  type RemoteTerminalOpenResult,
} from "../remote/remote-terminal.js";

import { createRemoteProjectService, type RemoteFileOperation } from "../remote/remote-project-service.js";

export type RemoteHostAdapterFactory = (record: RemoteHostRecord) => RacpRemoteHostClient;

/** One directory listing, as the remote folder picker consumes it. */
export type RemoteBrowseResult = {
  path: string;
  parent?: string;
  entries: Array<{ name: string; path: string }>;
};

export type BootRemoteHostsOptions = {
  dataDir: string;
  encryption: EncryptionPort;
  router: BackendRouter;
  emit: (channel: string, payload: unknown) => void;
  /** `connection/initialize` identity forwarded to every paired host. */
  clientInfo: { name: string; version: string };
  /** Optional override; the default uses the real `wsClientTransport`. */
  buildAdapter?: RemoteHostAdapterFactory;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  /** Durable SSH forwards; created on demand when the first SSH host is used. */
  tunnels?: SshTunnelManager;
  /** Overrides for the SSH bootstrap's injected edges (tests only). */
  sshBootstrap?: Partial<SshBootstrapDeps>;
  /** Test seam for the remote-project registry. */
  projects?: RemoteProjectRegistry;
};


export type { RemoteHostSummary };

export interface RemoteHostsBoot {
  /** Read registry, connect every host, register their sessions. Returns
   * the number of hosts that finished `open()` without throwing. */
  open(): Promise<number>;
  /** Close every open connection. Idempotent; safe to call before `open`. */
  closeAll(): Promise<void>;
  /** Every paired host with its live connection state; safe from the renderer. */
  list(): Promise<RemoteHostSummary[]>;
  /** Persist a paired record, then open one live connection for it. */
  addHost(record: RemoteHostRecord): Promise<RemoteHostSummary>;
  /**
   * Install and pair a `pi-host` over SSH and bring it online (spec §5.2).
   * The forward the bootstrap opened is adopted rather than reopened, so
   * pairing pays for exactly one tunnel.
   */
  bootstrapHost(request: RemoteHostBootstrapRequest): Promise<RemoteHostBootstrapResult>;
  /** Close and unregister the host, then remove it from the registry. */
  removeHost(hostKey: string): Promise<void>;
  /**
   * List the directories under a remote path, for the remote folder picker.
   * Forwarded as the owner-only `project/browse`; the host applies its own
   * bounds, hidden-name filter, and entry cap.
   */
  browse(hostKey: string, path?: string): Promise<RemoteBrowseResult>;
  /**
   * Projects of one host. The host's `project/list` row carries no path, so
   * the desktop's remembered projection fills it in — and keeps the host
   * listed while it is offline.
   */
  listProjects(hostKey?: string): Promise<RemoteProjectSummary[]>;
  getProject(id: string): RemoteProjectSummary | undefined;
  fileOperation(id: string, operation: RemoteFileOperation, payload: Record<string, unknown>): Promise<unknown>;
  /** Register a remote directory as a project on the host and remember it. */
  registerProject(
    hostKey: string,
    input: { path: string; name?: string },
  ): Promise<RemoteProjectSummary>;
  /** Forget only the desktop registration; never delete remote files. */
  removeProject(id: string): Promise<void>;
  /** Sessions of one host, as the merged desktop session list renders them. */
  listSessions(hostKey: string): Promise<RemoteSessionRow[]>;
  createSession(
    hostKey: string,
    input: {
      projectId: string;
      title?: string;
      mode?: string;
      permissionMode?: string;
      providerId?: string;
      modelId?: string;
      thinkingLevel?: string;
    },
  ): Promise<RemoteSessionRow>;
  /** The terminal manager of a live host, or null when it is not connected. */
  terminal(hostKey: string): RemoteTerminalManager | null;
  /**
   * The terminal manager that owns `terminalId`, or null when no live host
   * has it open. Input and resize carry only the terminal id, so the host is
   * resolved from it rather than trusted from the caller.
   */
  terminalForId(terminalId: string): RemoteTerminalManager | null;
  /** The underlying registry, exposed for pairing flows that write directly. */
  readonly registry: RemoteHostRegistry;
};

/**
 * One remote session as the renderer's session list consumes it. The shape
 * lives in `@pi-desktop/shared` so main and the renderer cannot drift on a
 * field the router resolves on the way through.
 */
export type RemoteSessionRow = RemoteHostSessionRow;

/**
 * Single-slot registry so `bootstrap/shutdown.ts` can wait on the same boot
 * `startup.ts` created without expanding `index.ts` past its 1500-LOC ceiling.
 * The shutdown handler reads this on `before-quit` — never earlier — so the
 * ordering is: register the ref during startup, close during shutdown.
 */
let activeRemoteHostsBoot: RemoteHostsBoot | null = null;

export function setActiveRemoteHostsBoot(boot: RemoteHostsBoot | null): void {
  activeRemoteHostsBoot = boot;
}

export function getActiveRemoteHostsBoot(): RemoteHostsBoot | null {
  return activeRemoteHostsBoot;
}

/** Record metadata keys; `metadata` is the registry's forward-compatible slot. */
const TRANSPORT_KEY = "transport";
const SSH_KEY = "ssh";

/**
 * Read the SSH descriptor out of a record, or `null` for a `direct` host. The
 * shape is re-checked on read because `remote-hosts.json` is user-editable and
 * a malformed descriptor must degrade to "not an SSH host", never to a spawn
 * with garbage arguments.
 */
/**
 * A descriptor field that is safe to place in the `ssh` argv, or `null`. It
 * reuses the transport's own rule so the renderer path and the on-disk path
 * cannot drift apart.
 */
function safeSshField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return assertSshArgument(value, "ssh field");
  } catch {
    return null;
  }
}

/** `ssh -p` value, or `null` when absent or out of range. */
function safeSshPort(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535) {
    return value;
  }
  return null;
}

export function sshMetadataOf(record: RemoteHostRecord): RemoteHostSshMetadata | null {
  const metadata = record.metadata;
  if (!metadata || metadata[TRANSPORT_KEY] !== "ssh") return null;
  const ssh = metadata[SSH_KEY];
  if (typeof ssh !== "object" || ssh === null) return null;
  const candidate = ssh as Partial<RemoteHostSshMetadata>;
  // `remote-hosts.json` is user-editable and every one of these values reaches
  // the `ssh` command line, where a leading `-` is read as an option
  // (`-oProxyCommand=…`) rather than as a destination. A record that fails the
  // check is not an SSH host at all — never a spawn with junk argv.
  const host = safeSshField(candidate.host);
  if (host === null) return null;
  const user = candidate.user === undefined ? null : safeSshField(candidate.user);
  if (user === null && candidate.user !== undefined) return null;
  const identityFile =
    candidate.identityFile === undefined ? null : safeSshField(candidate.identityFile);
  if (identityFile === null && candidate.identityFile !== undefined) return null;
  const port = candidate.port === undefined ? null : safeSshPort(candidate.port);
  if (port === null && candidate.port !== undefined) return null;
  if (
    typeof candidate.remotePort !== "number" ||
    !Number.isInteger(candidate.remotePort) ||
    candidate.remotePort <= 0 ||
    candidate.remotePort > 65_535
  ) {
    return null;
  }
  return {
    host,
    ...(port !== null ? { port } : {}),
    ...(user !== null ? { user } : {}),
    ...(identityFile !== null ? { identityFile } : {}),
    // Anything that is not the literal `"password"` reads back as a key
    // descriptor, so records written before this field existed are unchanged —
    // on disk and in memory alike.
    ...(candidate.auth === "password" ? { auth: "password" as const } : {}),
    remotePort: candidate.remotePort,
    version: typeof candidate.version === "string" ? candidate.version : "",
  };
}

/** The registry record for a bootstrapped host. */
export function sshHostRecord(input: {
  hostKey: string;
  label: string;
  url: string;
  deviceToken: string;
  ssh: RemoteHostSshMetadata;
  /** Login password for a host that uses one; the registry encrypts it. */
  sshSecret?: string;
}): RemoteHostRecord {
  return {
    hostKey: input.hostKey,
    label: input.label,
    url: input.url,
    deviceToken: input.deviceToken,
    ...(input.sshSecret ? { sshSecret: input.sshSecret } : {}),
    metadata: { [TRANSPORT_KEY]: "ssh", [SSH_KEY]: input.ssh },
  };
}

export function transportOf(record: RemoteHostRecord): RemoteHostTransport {
  return sshMetadataOf(record) ? "ssh" : "direct";
}

type OpenHost = {
  hostKey: string;
  adapter: RacpRemoteHostClient;
  connection: RemoteHostConnection;
  /** The URL this host is live on, which for an SSH host is the forward's. */
  url: string;
  /** Terminals of this host; created with the connection, dropped with it. */
  terminal: RemoteTerminalManager;
  /** What `connection/initialize` negotiated, for capability-gated UI. */
  capabilities: RemoteHostCapabilities;
  /** The host's own release version, or "" when it did not report one. */
  version: string;
};

export function createRemoteHostsBoot(
  options: BootRemoteHostsOptions,
): RemoteHostsBoot {
  const log = options.log ?? (() => undefined);
  const buildAdapter: RemoteHostAdapterFactory =
    options.buildAdapter ??
    ((record) =>
      createRacpRemoteHostClient({
        transport: wsClientTransport({ url: record.url, token: record.deviceToken }),
        clientInfo: options.clientInfo,
        log: (level, message, data) => log(level, message, data),
      }));

  const registry = createRemoteHostRegistry({
    dataDir: options.dataDir,
    encryption: options.encryption,
    log: (level, message, data) => log(level, message, data),
  });

  const tunnels =
    options.tunnels ??
    createSshTunnelManager({ log: (level, message, data) => log(level, message, data) });

  const projects: RemoteProjectRegistry =
    options.projects ??
    createRemoteProjectRegistry({
      dataDir: options.dataDir,
      // The same `safeStorage` port the host registry uses: a remote project
      // row is not a secret, so a host without a keychain still records it in
      // plaintext rather than failing the feature.
      encryption: options.encryption as RemoteProjectEncryptionPort,
      log: (level, message, data) => log(level, message, data),
    });

  const bootstrap = createSshBootstrap({
    version: options.clientInfo.version,
    exchangePairing: ({ url, pairingToken, label }) =>
      exchangePairingToken({
        url,
        pairingToken,
        label,
        clientInfo: options.clientInfo,
        log: (level, message, data) => log(level, message, data),
      }),
    log: (level, message, data) => log(level, message, data),
    ...options.sshBootstrap,
  });

  const opened: OpenHost[] = [];

  /** Bring one record online: build adapter, connect, register the router
   * backends. Failure is thrown so the caller can decide (boot logs & skips;
   * a live pair-then-add refuses to persist a token that cannot be used). */
  const openHost = async (record: RemoteHostRecord): Promise<OpenHost> => {
    const ssh = sshMetadataOf(record);
    // An SSH host is only reachable while its forward is up; opening one here
    // — rather than trusting the stored URL — is what makes a restart work.
    const url = ssh
      ? (await tunnels.open(record.hostKey, ssh, record.sshSecret)).url
      : record.url;
    try {
      const adapter = buildAdapter({ ...record, url });
      await adapter.connect();
      const connection = createRemoteHostConnection({
        hostKey: record.hostKey,
        client: adapter.client,
        router: options.router,
        emit: options.emit,
        log: (level, message, data) => log(level, message, data),
      });
      try {
        await connection.open();
      } catch (error) {
        // A connection that failed to open leaves the adapter live; close it
        // before re-throwing so the ws socket does not leak.
        await adapter.close().catch(() => undefined);
        throw error;
      }
      const terminal = createRemoteTerminalManager({
        hostKey: record.hostKey,
        // The manager only needs the request surface and the raw event
        // stream, both of which the adapter's client already exposes.
        client: {
          request: (method, params) => adapter.client.request(method, params),
          subscribe: (listener) => adapter.client.subscribe(listener),
        },
        emit: options.emit,
        log: (level, message, data) => log(level, message, data),
      });
      return {
        hostKey: record.hostKey,
        adapter,
        connection,
        url,
        terminal,
        capabilities: capabilitiesOf(adapter),
        version: versionOf(adapter),
      };
    } catch (error) {
      // The host is not online, so nothing needs this forward; drop it rather
      // than leave an idle ssh process behind.
      if (ssh) await tunnels.close(record.hostKey).catch(() => undefined);
      throw error;
    }
  };

  const closeHost = async (host: OpenHost): Promise<void> => {
    // Terminals first: they own the only renderer-facing listeners this host
    // has, and a live listener after close would keep writing to a dead pipe.
    host.terminal.closeAll();
    try {
      await host.connection.close();
    } catch (error) {
      log("warn", `remote host ${host.hostKey} connection close threw`, {
        error: String(error),
      });
    }
    try {
      await host.adapter.close();
    } catch (error) {
      log("warn", `remote host ${host.hostKey} adapter close threw`, {
        error: String(error),
      });
    }
    await tunnels.close(host.hostKey).catch((error: unknown) => {
      log("warn", `remote host ${host.hostKey} forward close threw`, {
        error: String(error),
      });
    });
  };

  /** Drop a live connection for one host key, if there is one. */
  const closeLive = async (hostKey: string): Promise<void> => {
    const index = opened.findIndex((host) => host.hostKey === hostKey);
    if (index < 0) return;
    const [host] = opened.splice(index, 1);
    if (host) await closeHost(host);
  };

  /**
   * The live host for `hostKey`, or `AGENT_UNAVAILABLE` when it is not
   * connected. Every remote operation below needs a live connection, and a
   * typed failure lets the caller tell "host offline" from a host-side
   * rejection.
   */
  const requireLive = (hostKey: string): OpenHost => {
    const host = opened.find((candidate) => candidate.hostKey === hostKey);
    if (!host) {
      throw Object.assign(
        new Error(`remote host ${hostKey} is not connected`),
        { errorCode: "AGENT_UNAVAILABLE" },
      );
    }
    return host;
  };
  const isConnected = (hostKey: string): boolean =>
    opened.some((host) => host.hostKey === hostKey);
  /**
   * Capabilities the host negotiated, or an all-false row before it reports.
   * `workspace` is derived from the remote-host profile rather than a flag of
   * its own, because `workspace/list|read|diff` are part of that profile.
   */
  const capabilitiesOf = (adapter: RacpRemoteHostClient): RemoteHostCapabilities => {
    const capabilities = adapter.initialized()?.capabilities;
    return {
      terminal: capabilities?.terminal === true,
      workspace: capabilities?.remoteHostProfile === true,
      ...(capabilities?.toolRelay === true ? { toolRelay: true } : {}),
      ...(capabilities?.projectFiles ? { projectFiles: capabilities.projectFiles } : {}),
    };
  };

  const versionOf = (adapter: RacpRemoteHostClient): string =>
    adapter.initialized()?.server.version ?? "";

  const summaryOf = (record: RemoteHostRecord): RemoteHostSummary => {
    const live = opened.find((host) => host.hostKey === record.hostKey);
    return {
      hostKey: record.hostKey,
      label: record.label,
      url: live?.url ?? record.url,
      connected: live !== undefined,
      transport: transportOf(record),
      // A host that never finished a handshake advertises nothing, which is
      // exactly what an offline host can serve.
      capabilities: live?.capabilities ?? {
        terminal: false,
        workspace: false,
      },
      version: live?.version ?? "",
    };
  };

  const addHost = async (record: RemoteHostRecord): Promise<RemoteHostSummary> => {
    // Persist before opening so a crash between the two leaves a record the
    // next boot can retry; a failed open is surfaced but the row stays.
    await registry.upsert(record);
    // Replace any prior live connection under the same hostKey (a re-pair
    // rotates the device token but the routing key stays stable).
    await closeLive(record.hostKey);
    try {
      const host = await openHost(record);
      opened.push(host);
      return { ...summaryOf(record), connected: true };
    } catch (error) {
      log("warn", `remote host ${record.hostKey} paired but failed to open`, {
        error: String(error),
      });
      return { ...summaryOf(record), connected: false };
    }
  };

  const projectService = createRemoteProjectService({
    registry: projects,
    pairedHostKeys: async () => (await registry.list()).map((record) => record.hostKey),
    requireHost: (hostKey) => {
      const host = requireLive(hostKey);
      return {
        capabilities: host.capabilities,
        request: (method, params) => host.adapter.client.request(method, params),
        registerSession: (id) => host.connection.registerSession(id),
      };
    },
  });

  return {
    registry,
    async open() {
      let records: RemoteHostRecord[];
      try {
        records = await registry.list();
      } catch (error) {
        log("error", "remote host registry read failed; skipping remote boot", {
          error: String(error),
        });
        return 0;
      }
      if (records.length === 0) return 0;

      let successes = 0;
      // Sequential connects: an early host's failure is logged and skipped
      // rather than aborting the rest. Parallelism buys nothing when each
      // host serves its own set of sessions.
      for (const record of records) {
        try {
          const host = await openHost(record);
          opened.push(host);
          successes += 1;
        } catch (error) {
          log("warn", `remote host ${record.hostKey} failed to open; leaving it disconnected`, {
            error: String(error),
          });
        }
      }
      return successes;
    },
    async closeAll() {
      // Snapshot and clear first so a re-entrant close finds nothing to do.
      const hosts = opened.splice(0, opened.length);
      await Promise.allSettled(hosts.map((host) => closeHost(host)));
      // A tunnel can outlive its connection when the connect failed; sweep it.
      await tunnels.dispose();
    },
    async list() {
      const records = await registry.list();
      return records.map(summaryOf);
    },
    addHost,
    async bootstrapHost(request) {
      const outcome = await bootstrap.bootstrap(request);
      // A re-pair under the same key must release the previous live
      // connection — and with it the previous forward — before the new
      // forward is adopted. Otherwise adopting would evict the very forward
      // the bootstrap just opened for us.
      await closeLive(outcome.hostKey);
      // Adopt before persisting: the forward is already live and the device
      // token only works over it.
      await tunnels.adopt(outcome.hostKey, outcome.ssh, outcome.forward);
      const host = await addHost(
        sshHostRecord({
          hostKey: outcome.hostKey,
          label: outcome.label,
          url: outcome.url,
          deviceToken: outcome.deviceToken,
          ssh: outcome.ssh,
          ...(outcome.sshSecret ? { sshSecret: outcome.sshSecret } : {}),
        }),
      );
      return { host, ssh: outcome.ssh, steps: outcome.steps };
    },
    async removeHost(hostKey) {
      await closeLive(hostKey);
      // A paired host that never came online still owns a tunnel slot.
      await tunnels.close(hostKey);
      await registry.remove(hostKey);
      // The host's projects are meaningless without it, and leaving them
      // would show folders the user can no longer reach.
      await projects.removeForHost(hostKey);
      projectService.invalidateHost(hostKey);
    },
    async browse(hostKey, path) {
      const host = requireLive(hostKey);
      // `project/browse` is owner-only: the desktop device holds owner for a
      // host it paired itself, and the host still enforces its own bounds.
      return host.adapter.client.request<RemoteBrowseResult>("project/browse", {
        ...(path ? { path } : {}),
      });
    },
    ...projectService,
    terminal(hostKey) {
      return opened.find((host) => host.hostKey === hostKey)?.terminal ?? null;
    },
    terminalForId(terminalId) {
      return opened.find((host) => host.terminal.owns(terminalId))?.terminal ?? null;
    },
  };
}
