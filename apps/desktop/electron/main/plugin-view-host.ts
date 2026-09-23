import { session, shell, WebContentsView, type BrowserWindow } from "electron";
import { join } from "node:path";
import { parseAllowedExternalUrl } from "./safe-open-external";
import type { FileViewBinding } from "./remote/remote-file-view-contract";
import {
  PLUGIN_VIEW_LOCATION_EVENT,
  PLUGIN_VIEW_LOCATION_PARAM,
  normalizeLocation,
  planLocationDelivery,
  viewEntryUrl,
} from "./plugin-view-location";
import {
  applyPluginEgressPolicy,
  pluginSessionPartition,
  type PluginPanelBlockedRequest,
} from "./plugin-panel-host";
import {
  PLUGIN_PANEL_EMBEDDED_ARGUMENT,
  PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX,
  type PluginPanelTheme,
} from "../shared/plugin-panel-chrome";

/**
 * Re-exported so the location contract stays addressable through the module
 * that owns the view lifecycle. The rules themselves live in
 * `plugin-view-location.ts`, free of Electron, so they stay unit-testable.
 */
export { PLUGIN_VIEW_LOCATION_EVENT, PLUGIN_VIEW_LOCATION_PARAM, viewEntryUrl };

/**
 * Plugin-contributed work panel views (ADR 0104).
 *
 * A view is the same isolated web page as a `ui.panel` window — sandboxed
 * preload, per-plugin persisted partition, `net.domains` egress allowlist — but
 * composited inside the main window at a rect the renderer measures, exactly as
 * `BrowserPane` does for the preview browser. The renderer stays the visibility
 * authority: a `WebContentsView` always draws above renderer content, so it
 * must be hidden whenever the view is not the active panel surface or a
 * blocking overlay is open.
 *
 * Views are cached rather than destroyed on tab switch so a plugin keeps its
 * scroll position and in-page state, bounded by `MAX_LIVE_VIEWS` so a user who
 * browses many plugins does not accumulate renderer processes forever.
 */

/** Live views kept warm; the least recently shown one is evicted past this. */
const MAX_LIVE_VIEWS = 4;
// File views may contain unsaved buffers. Refuse a new context at this cap,
// rather than evicting one whose dirty state only the plugin can know.
const MAX_FILE_VIEW_CONTEXTS = 16;

export type PluginViewOpenRequest = {
  pluginId: string;
  viewId: string;
  locale: string;
  theme: PluginPanelTheme;
  /** Absolute path to the view's HTML entry. */
  htmlPath: string;
  /** Egress allowlist from `manifest.net.domains`. */
  netDomains?: readonly string[];
  /**
   * What this view should show, when the opener knows (D320 follow-up).
   *
   * A work-panel view is opened either from the tool launcher, which has no
   * specific subject, from a chat file reference, which does, or by a plan or
   * goal approval artifact, whose host-chosen view receives the artifact path
   * (D452). The value is
   * opaque to the host: it travels as the entry URL's `piViewOpen` query
   * parameter on creation and as the `view:open` event afterwards, and the
   * plugin decides what it means. `pi.browser` uses its own chrome channel
   * instead and never receives this.
   */
  location?: string;
  remoteProjectId?: string;
  workspaceFiles?: boolean;
};

export type PluginViewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type LiveView = {
  key: string;
  pluginId: string;
  viewId: string;
  remoteProjectId?: string;
  preserveBuffers: boolean;
  generation: number;
  activity: number;
  view: WebContentsView;
  /** Absolute path to this view's HTML entry; its URL is rebuilt from it. */
  htmlPath: string;
  /** Monotonic counter; lowest value is the least recently shown. */
  usedAt: number;
  /**
   * What this view should show, or null when nothing specific was requested.
   * The page reads it from its own URL, so this is also the value a later
   * request is re-delivered against.
   */
  location: string | null;
  /** False until the first document finished loading. */
  loaded: boolean;
  started: boolean;
};

export function pluginViewKey(pluginId: string, viewId: string): string {
  return `${pluginId}/${viewId}`;
}

export class PluginViewHost {
  private views = new Map<string, LiveView>();
  private window: BrowserWindow | null = null;
  /** The one view currently attached to the window, if any. */
  private visibleKey: string | null = null;
  private bounds: PluginViewBounds = { x: 0, y: 0, width: 0, height: 0 };
  private clock = 0;
  private onBlockedRequest?: PluginPanelBlockedRequest;
  private selected = new Map<string, string>();
  private generation = 0;
  onDestroy?: (senderId: number) => void;

  constructor(onBlockedRequest?: PluginPanelBlockedRequest) {
    this.onBlockedRequest = onBlockedRequest;
  }

  /**
   * Fired when the visible plugin view changes. The work-panel browser guest
   * clamps itself to this rect so it cannot cover chat/composer.
   */
  onSurface?: (
    surface: {
      pluginId: string;
      viewId: string;
      visible: boolean;
      bounds: PluginViewBounds;
    } | null,
  ) => void;

  /**
   * Push a one-way event to every live docked view. Detached panel windows
   * are broadcast separately by `PluginPanelHost`; both surfaces share the
   * preload channel `pi-plugin-panel-event:<event>`.
   */
  broadcast(event: string, payload: unknown): void {
    const channel = `pi-plugin-panel-event:${event}`;
    for (const entry of this.views.values()) {
      const wc = entry.view.webContents;
      // A bound page must never see the local workspace broadcast, which the
      // vendored UI treats as an instruction to reset its editor.
      if (event === "workspace:changed" && entry.remoteProjectId) continue;
      if (wc.isDestroyed()) continue;
      try {
        wc.send(channel, payload);
      } catch {
        // One view that cannot receive must not starve the others.
      }
    }
  }

  setWindow(window: BrowserWindow | null): void {
    if (this.window === window) return;
    this.detachVisible();
    this.window = window;
  }

  /** Whether a live web contents exists for this view. */
  has(pluginId: string, viewId: string): boolean {
    return this.views.has(this.selected.get(pluginViewKey(pluginId, viewId)) ?? pluginViewKey(pluginId, viewId));
  }

  /**
   * The plugin owning a web contents, so `PluginPanelHost` can accept bridge
   * calls from docked views on the same channel it serves panel windows.
   */
  pluginIdForSender(senderId: number): string | null {
    for (const entry of this.views.values()) {
      const wc = entry.view.webContents;
      if (!wc.isDestroyed() && wc.id === senderId) return entry.pluginId;
    }
    return null;
  }

  bindingForSender(senderId: number): FileViewBinding | null {
    for (const entry of this.views.values()) {
      const wc = entry.view.webContents;
      if (!wc.isDestroyed() && wc.id === senderId) return {
        pluginId: entry.pluginId, viewId: entry.viewId,
        remoteProjectId: entry.remoteProjectId, generation: entry.generation,
        activity: entry.activity, active: this.visibleKey === entry.key,
      };
    }
    return null;
  }

  /**
   * Create the view if needed and mark it as the most recently used. Nothing is
   * attached here: the renderer follows with `setBounds` / `setVisible` once it
   * has measured the panel surface.
   *
   * Re-opening an already live view re-delivers its location — a second click
   * on the same chat reference is a request to show that file, not a cache
   * hit — and never tears the view down, so unsaved work inside a plugin is
   * not discarded by navigation.
   */
  open(request: PluginViewOpenRequest): void {
    const ref = pluginViewKey(request.pluginId, request.viewId);
    const key = request.remoteProjectId ? `${ref}#${encodeURIComponent(request.remoteProjectId)}` : ref;
    const location = normalizeLocation(request.location);
    const existing = this.views.get(key);
    if (!existing && request.workspaceFiles &&
        [...this.views.values()].filter((entry) => entry.preserveBuffers).length >= MAX_FILE_VIEW_CONTEXTS) {
      throw new Error("FILE_VIEW_LIMIT: Close a file view after saving its edits before opening another project.");
    }
    const previous = this.selected.get(ref);
    if (previous && previous !== key && this.visibleKey === previous) this.detachVisible();
    this.selected.set(ref, key);
    if (existing) {
      existing.usedAt = ++this.clock;
      this.deliverLocation(existing, location);
      return;
    }
    const view = this.createView(request);
    const entry: LiveView = {
      key,
      pluginId: request.pluginId,
      viewId: request.viewId,
      remoteProjectId: request.remoteProjectId,
      preserveBuffers: request.workspaceFiles === true,
      generation: ++this.generation,
      activity: 0,
      view,
      htmlPath: request.htmlPath,
      usedAt: ++this.clock,
      location,
      loaded: false,
      started: false,
    };
    this.views.set(key, entry);
    const senderId = view.webContents.id;
    view.webContents.once("destroyed", () => {
      if (this.views.get(key) === entry) {
        this.views.delete(key);
        this.onDestroy?.(senderId);
      }
    });
    view.webContents.once("did-finish-load", () => {
      entry.loaded = true;
    });
    // Remote file pages make hello/list calls as soon as they load. Start
    // only after attachment so the trusted active-sender gate is already open.
    if (!entry.remoteProjectId) this.load(entry);
    this.evictBeyondLimit();
  }

  /**
   * Hand a view the subject it should show.
   *
   * A document that has not finished loading cannot have subscribed to the
   * event yet, so the location is written into its URL and the load restarted;
   * nothing has run, so nothing is lost. Once loaded, the view subscribes and
   * is told through the same preload event channel as every other panel event.
   */
  private deliverLocation(entry: LiveView, location: string | null): void {
    const delivery = planLocationDelivery(entry.location, location, entry.loaded);
    if (delivery.kind === "none") return;
    // The page reads its subject from the URL it was loaded with, so the
    // remembered value has to follow every accepted request.
    entry.location = delivery.location;
    if (delivery.kind === "reload") {
      this.load(entry);
      return;
    }
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return;
    wc.send(`pi-plugin-panel-event:${PLUGIN_VIEW_LOCATION_EVENT}`, {
      path: delivery.location,
    });
  }

  private load(entry: LiveView): void {
    if (entry.remoteProjectId && this.visibleKey !== entry.key) return;
    entry.started = true;
    void entry.view.webContents
      .loadURL(viewEntryUrl(entry.htmlPath, entry.location))
      .catch(() => {
        // Load failures surface to the user as the tab's empty state; the view
        // stays cached so a plugin reload can retry into the same slot.
      });
  }

  setBounds(bounds: PluginViewBounds): void {
    this.bounds = {
      x: Math.max(0, Math.round(Number(bounds.x) || 0)),
      y: Math.max(0, Math.round(Number(bounds.y) || 0)),
      width: Math.max(0, Math.round(Number(bounds.width) || 0)),
      height: Math.max(0, Math.round(Number(bounds.height) || 0)),
    };
    const visible = this.visibleKey ? this.views.get(this.visibleKey) : null;
    visible?.view.setBounds(this.bounds);
    this.emitSurface();
  }

  /**
   * Show exactly one view, or none.
   *
   * Only one work panel surface is on screen at a time, so showing a view
   * implicitly detaches whichever was attached before. That keeps a stale view
   * from lingering above the renderer when the user switches tabs quickly.
   */
  setVisible(pluginId: string, viewId: string, visible: boolean): void {
    const ref = pluginViewKey(pluginId, viewId);
    const key = this.selected.get(ref) ?? ref;
    if (!visible) {
      if (this.visibleKey === key) this.detachVisible();
      return;
    }
    const entry = this.views.get(key);
    if (!entry) return;
    if (this.visibleKey && this.visibleKey !== key) this.detachVisible();
    entry.usedAt = ++this.clock;
    if (!this.window || this.window.isDestroyed()) return;
    const children = this.window.contentView.children;
    if (!children.includes(entry.view)) {
      this.window.contentView.addChildView(entry.view);
    }
    entry.view.setBounds(this.bounds);
    this.visibleKey = key;
    if (!entry.started) this.load(entry);
    this.emitSurface();
  }

  close(pluginId: string, viewId: string): void {
    for (const [key, entry] of this.views) {
      if (entry.pluginId === pluginId && entry.viewId === viewId) this.destroy(key);
    }
    this.selected.delete(pluginViewKey(pluginId, viewId));
  }

  /** Drop every view a plugin owns — disable, uninstall, reload, or crash. */
  closePlugin(pluginId: string): void {
    for (const [key, entry] of [...this.views]) {
      if (entry.pluginId === pluginId) this.destroy(key);
      if (entry.pluginId === pluginId) this.selected.delete(pluginViewKey(pluginId, entry.viewId));
    }
  }

  dispose(): void {
    for (const key of [...this.views.keys()]) this.destroy(key);
    this.selected.clear();
  }

  private destroy(key: string): void {
    const entry = this.views.get(key);
    if (!entry) return;
    if (this.visibleKey === key) this.detachVisible();
    this.views.delete(key);
    this.onDestroy?.(entry.view.webContents.id);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  }

  private detachVisible(): void {
    const entry = this.visibleKey ? this.views.get(this.visibleKey) : null;
    if (entry) entry.activity++;
    this.visibleKey = null;
    if (entry && this.window && !this.window.isDestroyed()) {
      const children = this.window.contentView.children;
      if (children.includes(entry.view)) {
        this.window.contentView.removeChildView(entry.view);
      }
    }
    this.emitSurface();
  }

  private emitSurface(): void {
    if (!this.onSurface) return;
    if (!this.visibleKey) {
      this.onSurface(null);
      return;
    }
    const entry = this.views.get(this.visibleKey);
    if (!entry) return;
    this.onSurface({
      pluginId: entry.pluginId,
      viewId: entry.viewId,
      visible: true,
      bounds: this.bounds,
    });
  }

  /** Evict least-recently-shown views, never the one currently on screen. */
  private evictBeyondLimit(): void {
    while ([...this.views.values()].filter((entry) => !entry.preserveBuffers).length > MAX_LIVE_VIEWS) {
      const candidates = [...this.views.values()]
        .filter((entry) => entry.key !== this.visibleKey)
        .filter((entry) => !entry.preserveBuffers)
        .sort((a, b) => a.usedAt - b.usedAt);
      const oldest = candidates[0];
      if (!oldest) return;
      this.destroy(oldest.key);
    }
  }

  private createView(request: PluginViewOpenRequest): WebContentsView {
    const ses = session.fromPartition(pluginSessionPartition(request.pluginId), {
      cache: true,
    });
    applyPluginEgressPolicy(ses, {
      pluginId: request.pluginId,
      netDomains: request.netDomains,
      onBlockedRequest: this.onBlockedRequest,
    });

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: join(__dirname, "../preload/plugin-panel.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        additionalArguments: [
          `${PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX}${encodeURIComponent(request.locale)}`,
          `--pi-plugin-panel-theme=${request.theme}`,
          PLUGIN_PANEL_EMBEDDED_ARGUMENT,
        ],
      },
    });
    const wc = view.webContents;
    // A docked view gets exactly one web contents. `window.open` would mint a
    // chromeless window outside the egress policy applied above.
    wc.setWindowOpenHandler(({ url }) => {
      const allowed = parseAllowedExternalUrl(url);
      if (allowed) void shell.openExternal(allowed);
      return { action: "deny" };
    });
    return view;
  }
}
