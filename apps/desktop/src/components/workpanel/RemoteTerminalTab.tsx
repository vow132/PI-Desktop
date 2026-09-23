import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { IconTerminal } from "../icons";
import { WorkTabEmpty } from "./WorkTabEmpty";

/** The shell lifecycle, as the tab renders it. */
type TerminalStatus = "opening" | "open" | "exited" | "failed";

/** Bytes → base64 in slices, so a large replay ring cannot blow the stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const slice = bytes.subarray(offset, offset + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Base64 → bytes. Output is a remote shell's byte stream, which is not
 * guaranteed to be valid UTF-8, so the decoder is used losslessly and never
 * with a replacement character that would corrupt a redraw sequence.
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const toBase64 = (text: string): string => bytesToBase64(new TextEncoder().encode(text));

/**
 * Terminal tab for a remote session: an xterm surface over RACP
 * `terminal/*`, whose desktop half lives in `remote-terminal.ts`.
 *
 * Two invariants the component owns:
 *
 * 1. **One pty per open tab.** Unmounting closes the host-side shell, so a
 *    closed tab never leaves a process running on a machine the user may not
 *    be able to reach again.
 * 2. **The `terminalId` is a durable handle.** A retry after a failed open
 *    (a dropped tunnel, not a reported exit) sends the same id back, so the
 *    host returns its bounded replay ring instead of spawning a second shell.
 */
export function RemoteTerminalTab() {
  const { t } = useTranslation();
  const remoteSessionId = useAppStore((state) => {
    if (!state.activeSessionId) return null;
    const session = state.sessions.find((candidate) => candidate.id === state.activeSessionId);
    return session?.source === "remote" ? session.id : null;
  });

  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** Host-side handle; survives a failed open so a retry can re-attach. */
  const terminalIdRef = useRef<string | null>(null);
  /** Set once the host reports the pty gone — then a retry must open a new one. */
  const goneRef = useRef(false);
  const geometryRef = useRef({ cols: 0, rows: 0 });
  const openSeqRef = useRef(0);

  const [status, setStatus] = useState<TerminalStatus>("opening");
  const [error, setError] = useState<string | null>(null);

  /** Push the container's real geometry to the host, when it actually changed. */
  const syncGeometry = useCallback(async () => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit) return;
    const before = geometryRef.current;
    fit.fit();
    const cols = terminal.cols;
    const rows = terminal.rows;
    if (cols === before.cols && rows === before.rows) return;
    geometryRef.current = { cols, rows };
    const terminalId = terminalIdRef.current;
    if (!terminalId) return;
    try {
      await api.resizeRemoteTerminal(terminalId, cols, rows);
    } catch {
      // A rejected resize leaves the shell at its last geometry; the next key
      // press still arrives, which is better than tearing the tab down.
    }
  }, []);

  const openShell = useCallback(
    async (sessionId: string) => {
      const host = hostRef.current;
      if (!host) return;
      const sequence = (openSeqRef.current += 1);
      setStatus("opening");
      setError(null);
      // Captured before the reset below: this is the handle a retry re-attaches to.
      const previousId = terminalIdRef.current;
      // Once the host reported the pty gone the handle is dead, so a retry must
      // open a fresh shell instead of asking for a replay ring that cannot exist.
      const reattach = !goneRef.current ? previousId : null;
      if (previousId && !reattach) {
        // The shell this surface was attached to is gone: close it so a retry
        // never leaves an orphaned pty on the host.
        void api.closeRemoteTerminal(previousId).catch(() => undefined);
      }

      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      terminalIdRef.current = null;
      geometryRef.current = { cols: 0, rows: 0 };

      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        scrollback: 5000,
        convertEol: false,
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      terminalRef.current = terminal;
      fitRef.current = fit;

      try {
        const result = await api.openRemoteTerminal({
          sessionId,
          cols: terminal.cols,
          rows: terminal.rows,
          ...(reattach ? { terminalId: reattach } : {}),
        });
        if (sequence !== openSeqRef.current) return;
        terminalIdRef.current = result.terminalId;
        goneRef.current = false;
        const replay = base64ToBytes(result.replay ?? "");
        if (replay.length > 0) terminal.write(replay);
        setStatus("open");
        void syncGeometry();
      } catch (openError) {
        if (sequence !== openSeqRef.current) return;
        terminalIdRef.current = null;
        setStatus("failed");
        setError(openError instanceof Error ? openError.message : String(openError));
      }
    },
    [syncGeometry],
  );

  /** Open one shell per remote session, and close it when the tab goes away. */
  useEffect(() => {
    if (!remoteSessionId) return;
    goneRef.current = false;
    void openShell(remoteSessionId);
    return () => {
      openSeqRef.current += 1;
      const terminalId = terminalIdRef.current;
      terminalIdRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      if (terminalId) void api.closeRemoteTerminal(terminalId).catch(() => undefined);
    };
  }, [openShell, remoteSessionId]);

  /** Host output and the pty's exit, both keyed by terminal id. */
  useEffect(() => {
    return api.onRemoteTerminalEvent(
      (payload) => {
        const terminal = terminalRef.current;
        if (!terminal || payload.terminalId !== terminalIdRef.current) return;
        terminal.write(base64ToBytes(payload.data ?? ""));
      },
      (payload) => {
        if (payload.terminalId !== terminalIdRef.current) return;
        // The host reaped the shell, so the handle is dead: a retry has to
        // open a new one rather than ask for a replay ring that cannot exist.
        goneRef.current = true;
        terminalIdRef.current = null;
        setStatus("exited");
      },
    );
  }, []);

  /** Keystrokes leave the renderer as base64, so no byte is lost in transit. */
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || status !== "open") return;
    const disposable = terminal.onData((data) => {
      const terminalId = terminalIdRef.current;
      if (!terminalId) return;
      void api
        .sendRemoteTerminalInput(terminalId, toBase64(data))
        .catch(() => undefined);
    });
    return () => disposable.dispose();
  }, [status]);

  /** The panel is resizable, so the shell's geometry follows the container. */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => void syncGeometry());
    observer.observe(host);
    return () => observer.disconnect();
  }, [syncGeometry]);

  if (!remoteSessionId) {
    return (
      <WorkTabEmpty
        icon={IconTerminal}
        title={t("remote.terminal.notRemoteTitle")}
        body={t("remote.terminal.notRemoteBody")}
      />
    );
  }

  const failed = status === "failed";
  return (
    <div className="remote-terminal">
      <div className="remote-terminal-surface" ref={hostRef} />
      {failed ? (
        <div className="remote-terminal-overlay" role="alert">
          <p className="remote-terminal-error">{error ?? t("remote.terminal.openFailed")}</p>
          <button
            type="button"
            className="remote-terminal-retry"
            onClick={() => void openShell(remoteSessionId)}
          >
            {t("remote.terminal.retry")}
          </button>
        </div>
      ) : null}
      {status === "opening" ? (
        <div className="remote-terminal-overlay" role="status">
          <p className="remote-terminal-hint">{t("remote.terminal.opening")}</p>
        </div>
      ) : null}
      {status === "exited" ? (
        <div className="remote-terminal-overlay" role="status">
          <p className="remote-terminal-hint">{t("remote.terminal.exited")}</p>
          <button
            type="button"
            className="remote-terminal-retry"
            onClick={() => void openShell(remoteSessionId)}
          >
            {t("remote.terminal.retry")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
