/**
 * Remote terminals for one paired host: the desktop half of RACP
 * `terminal/*` (spec §6.2). A pty runs on the remote machine inside the
 * session's root; this module owns the desktop side of that pipe — opening
 * and re-attaching, forwarding keystrokes, translating the host's
 * `terminal.output` / `terminal.changed` events into renderer IPC events.
 *
 * Two rules shape the implementation:
 *
 * 1. **A terminal is re-attached, never rebuilt.** The `terminalId` the host
 *    hands back is the durable handle. After an SSH drop the same id is sent
 *    again with `terminal/open`, which makes the host return its bounded
 *    replay ring instead of spawning a second shell. Losing the id would
 *    orphan a process on a machine the user may not be able to reach.
 * 2. **Ownership is the host's.** This manager never spawns a process,
 *    resolves a cwd, or reads the remote filesystem; it only speaks RACP.
 */
import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type { RacpEventEnvelope } from "@pi-desktop/shared";

import { parseRemoteSessionId } from "./backend-router.js";

/** The RACP request surface this manager needs; kept minimal for testing. */
export type RemoteTerminalClient = {
  request<T>(method: string, params?: unknown): Promise<T>;
  /** Raw RACP envelopes from the host's event stream. */
  subscribe(listener: (envelope: RacpEventEnvelope) => void): () => void;
};

export type RemoteTerminalOpenResult = {
  /** Host-side terminal handle; stable across re-attaches. */
  terminalId: string;
  /** Bounded replay ring, base64 — the output before this client attached. */
  replay: string;
  cols: number;
  rows: number;
};

export type RemoteTerminalManagerOptions = {
  /** Routing key of the owning host; validates every session id it is given. */
  hostKey: string;
  client: RemoteTerminalClient;
  /** Dispatch a renderer IPC event. */
  emit: (channel: string, payload: unknown) => void;
  log?: (level: "warn" | "error", message: string, data?: unknown) => void;
};

export interface RemoteTerminalManager {
  /**
   * Open a terminal for a remote session, or re-attach when `terminalId` is
   * supplied. Throws `INVALID_ARGUMENT` when the namespaced session id does
   * not belong to this host, so one host can never drive another's terminal.
   */
  open(
    remoteSessionId: string,
    options: { cols: number; rows: number; terminalId?: string },
  ): Promise<RemoteTerminalOpenResult>;
  /** Forward keystrokes. `data` is base64, so no byte is lost in transit. */
  input(terminalId: string, data: string): Promise<void>;
  resize(terminalId: string, cols: number, rows: number): Promise<void>;
  /** Close the pty on the host and forget the mapping. */
  close(terminalId: string): Promise<void>;
  /** Whether this manager has `terminalId` open. */
  owns(terminalId: string): boolean;
  /** Detach every listener and drop every mapping (host disconnect/quit). */
  closeAll(): void;
}

type OpenTerminal = {
  terminalId: string;
  remoteSessionId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createRemoteTerminalManager(
  options: RemoteTerminalManagerOptions,
): RemoteTerminalManager {
  const { hostKey, client, emit } = options;
  const log = options.log ?? (() => undefined);
  const terminals = new Map<string, OpenTerminal>();
  let unsubscribe: (() => void) | null = null;

  const ensureSubscribed = (): void => {
    if (unsubscribe) return;
    unsubscribe = client.subscribe((envelope) => handle(envelope));
  };

  const handle = (envelope: RacpEventEnvelope): void => {
    if (!isRecord(envelope.payload)) return;
    const payload = envelope.payload;
    const terminalId = typeof payload.terminalId === "string" ? payload.terminalId : "";
    if (!terminalId) return;
    if (!terminals.has(terminalId)) return;
    if (envelope.kind === "terminal.output") {
      const data = typeof payload.data === "string" ? payload.data : "";
      if (!data) return;
      emit(IPC.event.remoteTerminalData, { terminalId, data });
    }
    if (envelope.kind === "terminal.changed") {
      const code = typeof payload.code === "number" ? payload.code : null;
      // The pty is gone on the host, so the mapping must go too — otherwise a
      // later reconnect would try to re-attach a dead terminal.
      terminals.delete(terminalId);
      emit(IPC.event.remoteTerminalExit, { terminalId, code });
    }
  };

  return {
    async open(remoteSessionId, terminalOptions) {
      const parsed = parseRemoteSessionId(remoteSessionId);
      if (!parsed || parsed.hostKey !== hostKey) {
        throw Object.assign(
          new Error("session does not belong to this remote host"),
          { errorCode: ErrorCodes.INVALID_ARGUMENT },
        );
      }
      ensureSubscribed();
      const result = await client.request<RemoteTerminalOpenResult>("terminal/open", {
        sessionId: parsed.hostSessionId,
        cols: terminalOptions.cols,
        rows: terminalOptions.rows,
        ...(terminalOptions.terminalId ? { terminalId: terminalOptions.terminalId } : {}),
      });
      if (typeof result?.terminalId !== "string" || !result.terminalId) {
        throw Object.assign(new Error("remote host returned no terminal id"), {
          errorCode: ErrorCodes.INTERNAL,
        });
      }
      terminals.set(result.terminalId, { terminalId: result.terminalId, remoteSessionId });
      return result;
    },
    async input(terminalId, data) {
      await client.request("terminal/input", { terminalId, data });
    },
    async resize(terminalId, cols, rows) {
      await client.request("terminal/resize", { terminalId, cols, rows });
    },
    async close(terminalId) {
      terminals.delete(terminalId);
      // Best effort: the host may already have reaped the pty, and a failed
      // close must not stop the renderer from dropping its own state.
      await client.request("terminal/close", { terminalId }).catch((error: unknown) => {
        log("warn", `terminal/close failed for ${terminalId}`, { error: String(error) });
      });
    },
    owns(terminalId) {
      return terminals.has(terminalId);
    },
    closeAll() {
      terminals.clear();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
