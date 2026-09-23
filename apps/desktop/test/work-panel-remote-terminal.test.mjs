/**
 * Remote workspace ▸ Terminal tab.
 *
 * The tab is the only surface that drives a shell on a remote host, so the
 * contract that matters is lifecycle: one pty per open tab, the host's
 * `terminalId` treated as a durable handle, and nothing left running on a
 * machine the user may not be able to reach again. This suite pins the wiring
 * across the tab registry, the work panel, the component, the catalogs and the
 * stylesheet.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  isKnownWorkPanelTab,
  openWorkPanelTabState,
  sanitizeWorkPanelTabsState,
  toolWorkPanelTab,
} from "../src/lib/work-panel-tabs.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const panel = read("src/components/workpanel/WorkPanel.tsx");
const tab = read("src/components/workpanel/RemoteTerminalTab.tsx");
const css = read("src/styles/remote-workspace.css");
const api = read("src/lib/api.ts");

const LOCALES = ["de", "en", "es", "fr", "ko", "tr", "zh-CN", "zh-TW"];

test("terminal is a first-class work panel tab kind", () => {
  const terminal = toolWorkPanelTab("terminal");
  assert.equal(terminal.kind, "terminal");
  assert.equal(terminal.id, "terminal");
  assert.ok(isKnownWorkPanelTab(terminal));

  // A second open must reuse the same shell rather than fork a second one.
  const state = openWorkPanelTabState({ tabs: [], activeTabId: null }, terminal);
  const reopened = openWorkPanelTabState(state, toolWorkPanelTab("terminal"));
  assert.deepEqual(
    reopened.tabs.map((entry) => entry.id),
    ["terminal"],
  );
  assert.equal(reopened.activeTabId, "terminal");

  // Persisted state from an older build must survive sanitisation.
  assert.deepEqual(
    sanitizeWorkPanelTabsState({ tabs: [terminal], activeTabId: "terminal" }),
    { tabs: [terminal], activeTabId: "terminal" },
  );
});

test("the terminal tab is gated on a remote session", () => {
  // Offered only where a shell can exist: the active session's source.
  assert.match(panel, /session\?\.source === "remote"/);
  assert.match(panel, /workPanelTools\(t, pluginViews, activeSessionIsRemote\)/);
  assert.match(panel, /const tools = workPanelTools\(/);
  assert.match(tab, /session\?\.source === "remote" \? session\.id : null/);
});

test("the work panel renders the remote terminal tab and labels it", () => {
  assert.match(panel, /activeTab\?\.kind === "terminal" && \(/);
  assert.match(panel, /<RemoteTerminalTab \/>/);
  assert.match(panel, /terminal: IconTerminal,/);
  assert.match(panel, /label: t\("panel\.tabs\.terminal"\),/);
  assert.match(panel, /import \{ RemoteTerminalTab \} from "\.\/RemoteTerminalTab";/);
});

test("one pty per open tab, closed when the tab goes away", () => {
  assert.match(tab, /api\.openRemoteTerminal\(\{/);
  assert.match(tab, /api\.closeRemoteTerminal\(terminalId\)/);
  // The cleanup is the unmount path; without it a closed tab orphans a shell.
  assert.match(tab, /return \(\) => \{[\s\S]*?api\.closeRemoteTerminal\(/);
  // Session changes re-run the effect, so a stale shell must never be reused.
  assert.match(tab, /\}, \[openShell, remoteSessionId\]\);/);
});

test("the terminalId is a durable handle rather than a fresh spawn", () => {
  // A retry after a failed open re-attaches; after a reported exit it opens a
  // new shell, because the host has already reaped the old one.
  assert.match(tab, /const reattach = !goneRef\.current \? previousId : null;/);
  assert.match(tab, /\.\.\.\(reattach \? \{ terminalId: reattach \} : \{\}\)/);
  assert.match(tab, /goneRef\.current = true;/);
  // A dead handle is closed, not leaked, before the replacement surface opens.
  assert.match(tab, /if \(previousId && !reattach\) \{[\s\S]*?api\.closeRemoteTerminal\(previousId\)/);
});

test("keystrokes, output, and geometry all cross the bridge as base64", () => {
  assert.match(api, /sendRemoteTerminalInput: \(terminalId: string, data: string\) =>/);
  assert.match(tab, /api\s*\.sendRemoteTerminalInput\(terminalId, toBase64\(data\)\)/);
  assert.match(tab, /api\.onRemoteTerminalEvent\(/);
  assert.match(tab, /terminal\.write\(base64ToBytes\(payload\.data \?\? ""\)\)/);
  // Replay arrives before the shell is interactive and must not be dropped.
  assert.match(tab, /const replay = base64ToBytes\(result\.replay \?\? ""\)/);
  // The panel is resizable, so the shell's geometry follows the container.
  assert.match(tab, /api\.resizeRemoteTerminal\(terminalId, cols, rows\)/);
  assert.match(tab, /new ResizeObserver\(\(\) => void syncGeometry\(\)\)/);
  // Late output from a previous surface must not be written into a new one.
  assert.match(tab, /if \(!terminal \|\| payload\.terminalId !== terminalIdRef\.current\) return;/);
});

test("a non-remote session gets an empty state, not a broken shell", () => {
  assert.match(tab, /<WorkTabEmpty/);
  assert.match(tab, /icon=\{IconTerminal\}/);
  assert.match(tab, /title=\{t\("remote\.terminal\.notRemoteTitle"\)\}/);
});

test("every terminal string exists in all eight catalogs", () => {
  const keys = [
    "panel.tabs.terminal",
    "remote.terminal.notRemoteTitle",
    "remote.terminal.notRemoteBody",
    "remote.terminal.opening",
    "remote.terminal.openFailed",
    "remote.terminal.exited",
    "remote.terminal.retry",
  ];
  for (const locale of LOCALES) {
    const source = read(`../../packages/i18n/src/locales/${locale}/index.ts`);
    for (const key of keys) {
      const leaf = key.split(".").pop();
      assert.match(
        source,
        new RegExp(`"?${leaf}"?\\s*:`),
        `${locale} is missing ${key}`,
      );
    }
  }
  // The component must not ask for a key none of the catalogs declares.
  const used = [...tab.matchAll(/t\("(remote\.[a-zA-Z.]+)"\)/g)].map((m) => m[1]);
  assert.ok(used.length > 0, "the tab asks for no remote strings");
  for (const key of used) {
    assert.ok(keys.includes(key), `${key} is not covered by this suite`);
  }
});

test("the terminal stylesheet fills the pane and covers it while not ready", () => {
  const rule = (selector) => {
    const from = css.indexOf(`\n${selector} {`);
    assert.ok(from >= 0, `${selector} rule missing`);
    return css.slice(from, css.indexOf("}", from));
  };
  // FitAddon derives the shell geometry from the container box.
  assert.match(rule(".remote-terminal-surface"), /height:\s*100%/);
  assert.match(rule(".work-panel-tabpane-terminal"), /padding:\s*0/);
  assert.match(rule(".remote-terminal-overlay"), /position:\s*absolute/);
  assert.match(rule(".remote-terminal-overlay"), /inset:\s*0/);
  assert.match(rule(".remote-terminal-retry"), /cursor:\s*pointer/);
});
