import type { RemoteProjectSummary, SessionSummary } from "@pi-desktop/shared";

/** Remote identity is supplied by main. Paths are never routing or grouping keys. */
export function remoteProjectForSession(
  session: SessionSummary | undefined,
  projects: readonly RemoteProjectSummary[],
): RemoteProjectSummary | undefined {
  if (session?.source !== "remote" || !session.remoteProjectId) return undefined;
  return projects.find((project) =>
    project.id === session.remoteProjectId &&
    (!session.hostKey || session.hostKey === project.hostKey),
  );
}

export function remoteProjectSessions(
  project: RemoteProjectSummary,
  sessions: readonly SessionSummary[],
): SessionSummary[] {
  return sessions.filter((session) =>
    session.source === "remote" && session.remoteProjectId === project.id &&
    (!session.hostKey || session.hostKey === project.hostKey),
  ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function upsertRemoteProject(
  projects: readonly RemoteProjectSummary[],
  project: RemoteProjectSummary,
): RemoteProjectSummary[] {
  return [...projects.filter((row) => row.id !== project.id), project];
}
