import i18n from "i18next";
import { api } from "./api";

type FileTarget = { remote: boolean; sessionId?: string };

/** The legacy file viewer supports sessions; project-only browsing uses the plugin. */
function fileSessionId(target: FileTarget): string | undefined {
  if (target.remote && !target.sessionId) throw new Error(i18n.t("remote.offline"));
  return target.remote ? target.sessionId : undefined;
}

export function listTargetDirectory(target: FileTarget, path: string) {
  return api.fsList(path, fileSessionId(target));
}

export function readTargetFile(target: FileTarget, path: string, mimeType?: string) {
  return api.fsRead(path, mimeType, fileSessionId(target));
}
