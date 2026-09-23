import i18n from "i18next";
import type { RemoteProjectSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { remoteProjectSessions, upsertRemoteProject } from "../../lib/remote-projects";
import { clearSessionPanes } from "../../lib/session-panes";
import { fileManagerPluginTab, openWorkPanelTabState } from "../../lib/work-panel-tabs";
import { switchWorkPanelSession } from "../slices/work-panel-slice";
import type { NavigationOptions } from "../app-state";
import type { StoreAccess } from "../slices/types";
import type { SessionRuntime } from "./session-runtime";

export type RemoteProjectAccess = StoreAccess & { runtime: SessionRuntime };
export const remoteErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Owns remote registry refreshes and navigation; never aligns the local workspace. */
export function createRemoteProjectNavigation({ get, set, runtime }: RemoteProjectAccess) {
  let hostRequest = 0;
  let sequence = 0;
  let allProjectsRequest = 0;
  const hostProjectsRequest = new Map<string, number>();
  const removedHosts = new Set<string>();
  const pendingCreates = new Map<string, Promise<void>>();

  const report = (id: string, error: unknown) => set((state) => ({
    remoteProjectErrors: { ...state.remoteProjectErrors, [id]: remoteErrorMessage(error) },
  }));
  const clearError = (id: string) => set((state) => {
    const errors = { ...state.remoteProjectErrors };
    delete errors[id];
    return { remoteProjectErrors: errors };
  });
  const findProject = (id: string) => {
    const project = get().remoteProjects.find((row) => row.id === id);
    if (!project) throw new Error(i18n.t("remote.offline"));
    return project;
  };
  const remember = (project: RemoteProjectSummary) => {
    if (removedHosts.has(project.hostKey)) return;
    hostProjectsRequest.set(project.hostKey, ++sequence);
    set((state) => ({ remoteProjects: upsertRemoteProject(state.remoteProjects, project) }));
  };

  const clearConversation = () => {
    const state = get();
    if (state.activeSessionId) {
      runtime.cacheSessionTranscript(
        state.activeSessionId,
        state.messages,
        state.sessionHistory[state.activeSessionId],
      );
    }
    set({
      ...switchWorkPanelSession(state, undefined),
      ...clearSessionPanes(),
      activeSessionId: undefined,
      selectingSessionId: undefined,
      messages: [],
      draftConfiguration: null,
      isRunning: false,
      subagentPanel: null,
    });
  };

  const activate = async (
    id: string,
    intent: number,
    owns = () => true,
  ): Promise<boolean> => {
    if (!runtime.navigationIntentIsCurrent(intent) || !owns()) return false;
    const project = findProject(id);
    const connected = get().remoteHosts.some(
      (host) => host.hostKey === project.hostKey && host.connected,
    );
    const latest = connected ? remoteProjectSessions(project, get().sessions)[0] : undefined;
    if (latest) {
      await get().selectSession(latest.id, { navigationIntent: intent });
      if (!runtime.navigationIntentIsCurrent(intent) || !owns()) return false;
      if (get().activeSessionId !== latest.id) {
        throw new Error(i18n.t("remote.offline"));
      }
    } else {
      clearConversation();
      if (!connected && get().remoteHosts.some((host) => host.hostKey === project.hostKey)) {
        report(id, new Error(i18n.t("remote.offline")));
      }
    }
    findProject(id);
    set({ activeRemoteProjectId: id, page: "chat" });
    const tab = fileManagerPluginTab(project.path);
    if (get().activeSessionId) {
      get().openWorkPanelTab(tab);
    } else {
      const next = openWorkPanelTabState(
        { tabs: get().workPanelTabs, activeTabId: get().activeWorkPanelTabId },
        tab,
      );
      set({
        workPanelOpen: true,
        workPanelTabs: next.tabs,
        activeWorkPanelTabId: next.activeTabId,
      });
    }
    return true;
  };

  return {
    remember,
    activate,
    hostWasRemoved: (hostKey: string) => removedHosts.has(hostKey),
    actions: {
      loadRemoteHosts: async (): Promise<void> => {
        const request = ++hostRequest;
        try {
          const { hosts } = await api.listRemoteHosts();
          if (request !== hostRequest) return;
          const keys = new Set(hosts.map((host) => host.hostKey));
          for (const host of get().remoteHosts) {
            if (!keys.has(host.hostKey)) {
              removedHosts.add(host.hostKey);
              hostProjectsRequest.set(host.hostKey, ++sequence);
            }
          }
          for (const key of keys) removedHosts.delete(key);
          set({ remoteHosts: hosts });
        } catch (error) {
          if (request === hostRequest) set({ error: remoteErrorMessage(error) });
        }
      },

      loadRemoteProjects: async (hostKey?: string): Promise<RemoteProjectSummary[]> => {
        const request = ++sequence;
        if (hostKey) hostProjectsRequest.set(hostKey, request);
        else allProjectsRequest = request;
        try {
          const { projects } = await api.listRemoteProjects(hostKey);
          const hostRequestForKey = hostKey ? hostProjectsRequest.get(hostKey) ?? 0 : 0;
          const requestCurrent = hostKey
            ? request === hostRequestForKey
            : request === allProjectsRequest && projects.every(
                (project) => (hostProjectsRequest.get(project.hostKey) ?? 0) <= request,
              );
          if (!requestCurrent) {
            return get().remoteProjects.filter((project) => !hostKey || project.hostKey === hostKey);
          }
          const applicable = projects.filter((project) => !removedHosts.has(project.hostKey));
          if (hostKey && applicable.length === 0 && !get().remoteHosts.some((host) => host.hostKey === hostKey)) {
            return get().remoteProjects.filter((project) => project.hostKey === hostKey);
          }
          set((state) => {
            const targetHosts = new Set(
              hostKey
                ? [hostKey]
                : [
                    ...state.remoteProjects.map((project) => project.hostKey),
                    ...projects.map((project) => project.hostKey),
                  ],
            );
            const retained = state.remoteProjects.filter(
              (project) => !targetHosts.has(project.hostKey),
            );
            return { remoteProjects: [...retained, ...applicable] };
          });
          return get().remoteProjects.filter(
            (project) => !hostKey || project.hostKey === hostKey,
          );
        } catch (error) {
          if (request === (hostKey ? hostProjectsRequest.get(hostKey) : allProjectsRequest)) {
            set({ error: remoteErrorMessage(error) });
          }
          return [];
        }
      },

      selectRemoteProject: async (id: string): Promise<void> => {
        const intent = runtime.beginNavigationIntent();
        clearError(id);
        try {
          await activate(id, intent);
        } catch (error) {
          if (runtime.navigationIntentIsCurrent(intent)) report(id, error);
        }
      },

      newRemoteProjectSession: async (
        id: string,
        options?: NavigationOptions,
      ): Promise<void> => {
        const pending = pendingCreates.get(id);
        if (pending) return pending;
        const intent = options?.navigationIntent ?? runtime.beginNavigationIntent();
        if (!runtime.navigationIntentIsCurrent(intent)) return;
        clearError(id);
        set((state) => ({
          remoteProjectPending: { ...state.remoteProjectPending, [id]: true },
        }));
        const request = (async () => {
          try {
            const project = findProject(id);
            if (!get().remoteHosts.some(
              (host) => host.hostKey === project.hostKey && host.connected,
            )) {
              throw new Error(i18n.t("remote.offline"));
            }
            const { session } = await api.createRemoteSession({
              hostKey: project.hostKey,
              projectId: project.hostProjectId,
            });
            await get().refreshSessions();
            if (!runtime.navigationIntentIsCurrent(intent) || removedHosts.has(project.hostKey)) return;
            findProject(id);
            if (!remoteProjectSessions(project, get().sessions).some((row) => row.id === session.id)) {
              throw new Error(i18n.t("remote.offline"));
            }
            await get().selectSession(session.id, { navigationIntent: intent });
            if (runtime.navigationIntentIsCurrent(intent) && get().activeSessionId === session.id) {
              set({ activeRemoteProjectId: id });
            }
          } catch (error) {
            if (get().remoteProjects.some((row) => row.id === id)) report(id, error);
          } finally {
            set((state) => {
              const pendingState = { ...state.remoteProjectPending };
              delete pendingState[id];
              return { remoteProjectPending: pendingState };
            });
          }
        })();
        pendingCreates.set(id, request);
        try {
          await request;
        } finally {
          pendingCreates.delete(id);
        }
      },

      removeRemoteProject: async (id: string): Promise<void> => {
        clearError(id);
        try {
          const project = findProject(id);
          await api.removeRemoteProject(id);
          hostProjectsRequest.set(project.hostKey, ++sequence);
          if (get().activeRemoteProjectId === id) {
            runtime.beginNavigationIntent();
            clearConversation();
            set({ activeRemoteProjectId: null });
          }
          set((state) => ({
            remoteProjects: state.remoteProjects.filter((row) => row.id !== id),
          }));
        } catch (error) {
          report(id, error);
        }
      },
    },
  };
}

/** Draft submission on a selected remote folder must never create a local chat. */
export function remoteAwareDraftMaterializer(
  { get, runtime }: RemoteProjectAccess,
  localMaterialize: (intent?: number) => Promise<string | null>,
): (intent?: number) => Promise<string | null> {
  return async (requestedIntent) => {
    const id = get().activeRemoteProjectId;
    if (!id) return localMaterialize(requestedIntent);
    const intent = requestedIntent ?? runtime.beginNavigationIntent();
    await get().newRemoteProjectSession(id, { navigationIntent: intent });
    if (!runtime.navigationIntentIsCurrent(intent) || get().activeRemoteProjectId !== id) return null;
    const error = get().remoteProjectErrors[id];
    if (error) throw new Error(error);
    const session = get().sessions.find((row) => row.id === get().activeSessionId);
    return session?.source === "remote" && session.remoteProjectId === id
      ? session.id
      : null;
  };
}
