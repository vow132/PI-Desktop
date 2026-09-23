import { posix } from "node:path";

export type FileViewBinding = Readonly<{
  pluginId: string;
  viewId: string;
  remoteProjectId?: string;
  generation: number;
  active: boolean;
  /** Changes on hide, so a hidden-and-restored view rejects pre-hide replies. */
  activity: number;
}>;

export function fileViewError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Never use the desktop OS's path resolver for a remote POSIX namespace. */
export function fileViewPath(value: unknown, root: string, allowRoot = false): string {
  if (typeof value !== "string" || value.length > 1024 || /[\\\x00-\x1f:]/.test(value)) {
    throw fileViewError("INVALID_PATH", "Use a project-relative file path.");
  }
  const base = root.replace(/\/+$/, "") || "/";
  let path = value;
  if (path.startsWith("/")) {
    if (path === base) path = "";
    else if (path.startsWith(base === "/" ? "/" : `${base}/`)) path = path.slice(base === "/" ? 1 : base.length + 1);
    else throw fileViewError("OUTSIDE_ROOT", "Remote files must stay inside the selected project.");
  }
  if (path.split("/").some((part) => part === "..")) {
    throw fileViewError("OUTSIDE_ROOT", "Remote files must stay inside the selected project.");
  }
  path = posix.normalize(path);
  if (path === ".") path = "";
  if (!allowRoot && !path) throw fileViewError("INVALID_PATH", "A file path is required.");
  return path;
}

export function fileViewName(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 255 || value === "." || value === ".." || /[\\/\x00-\x1f:]/.test(value)) {
    throw fileViewError("INVALID_PATH", "Use a single file or folder name.");
  }
  return value;
}

const DEFAULT_PREFS = {
  splitRatio: 0.32, treeCollapsed: false, showIgnored: false, mdPreview: false,
  csvTable: true, jsonTree: false, tablePageSize: 1000,
};

/** Root preferences are never accepted as remote routing authority or sent to the child. */
export function fileViewPrefs(value: unknown, defaults = true): Record<string, unknown> {
  const source = record(value);
  const prefs: Record<string, unknown> = defaults ? { ...DEFAULT_PREFS } : {};
  for (const key of ["treeCollapsed", "showIgnored", "mdPreview", "csvTable", "jsonTree"]) {
    if (typeof source[key] === "boolean") prefs[key] = source[key];
  }
  if (typeof source.splitRatio === "number" && Number.isFinite(source.splitRatio)) {
    prefs.splitRatio = Math.min(0.7, Math.max(0.15, source.splitRatio));
  }
  if (typeof source.tablePageSize === "number" && Number.isFinite(source.tablePageSize)) {
    prefs.tablePageSize = Math.min(5000, Math.max(100, Math.round(source.tablePageSize / 100) * 100));
  }
  return defaults ? { ...prefs, projectRoots: {} } : prefs;
}

/** Do not echo raw transport errors: they can contain connection URLs or host keys. */
export function fileViewFailure(error: unknown, mutationSent = false) {
  const rawCode = record(error).code ?? record(error).errorCode;
  const aliases: Record<string, string> = {
    CAPABILITY_UNAVAILABLE: "UNSUPPORTED",
    HOST_OFFLINE: "OFFLINE", REMOTE_HOST_OFFLINE: "OFFLINE",
    ROLE_DENIED: "FORBIDDEN", AUTH_FORBIDDEN: "FORBIDDEN",
  };
  const code = typeof rawCode === "string" ? aliases[rawCode] ?? rawCode : undefined;
  const messages: Record<string, string> = {
    PERMISSION_DENIED: "Remote workspace access is not approved for this view or connection.",
    FORBIDDEN: "The remote connection must have the owner role to change files.",
    UNAUTHORIZED: "The remote connection is not authorized. Reconnect before continuing.",
    STALE_CONTEXT: "This file view is no longer active. Return to its project and reload.",
    NOT_FOUND: "The registered remote project or file is no longer available.",
    REMOTE_PATH_NOT_FOUND: "The remote file no longer exists. Reload the directory.",
    REMOTE_PATH_FORBIDDEN: "This remote path is not accessible within the selected project.",
    OUTSIDE_ROOT: "Remote files must stay inside the selected project.",
    INVALID_PATH: "Use a valid project-relative path without parent traversal.",
    INVALID_ARGUMENT: "The remote file request is invalid.",
    TOO_LARGE: "This file exceeds the remote file size limit.",
    CONFLICT: "The remote file changed. Reload it before saving; force overwrite is unavailable.",
    READ_ONLY: "This remote file is read-only. Reload it from an upgraded host before saving.",
    UNSUPPORTED: "This operation is unavailable for remote files. Upgrade the remote host for project file access.",
    OFFLINE: "The remote host is offline. Reconnect and reload; local files are never used instead.",
    BUSY: "A remote file change is already in progress. Wait for its result before continuing.",
  };
  // The vendored UI replaces UNSUPPORTED with generic copy. A remote-specific
  // code preserves the actionable message using its existing error display.
  if (typeof code === "string" && messages[code]) return { ok: false, code, message: messages[code] };
  return mutationSent
    ? { ok: false, code: "OUTCOME_UNKNOWN", message: "The remote change outcome is unknown. Reload before retrying; this request will not be replayed." }
    : { ok: false, code: "REMOTE_UNAVAILABLE", message: "Remote files are unavailable. Reconnect and reload the view." };
}
