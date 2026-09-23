import i18n from "i18next";
import type { RemoteHostCapabilities, RemoteHostSummary, RemoteProjectSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import type { AppState } from "../app-state";
import { createRemoteProjectNavigation, remoteErrorMessage, type RemoteProjectAccess } from "../runtime/remote-project-navigation";

export type RemoteBrowseState = {
  hostKey: string;
  path: string;
  parent?: string;
  entries: Array<{ name: string; path: string }>;
  loading: boolean;
  error?: string;
};
export type RemoteWizardStep = "method" | "config" | "connecting" | "folder";
export type RemoteWizardAuth = "key" | "password";
export type RemoteWizardState = {
  open: boolean;
  step: RemoteWizardStep;
  hostKey: string | null;
  label: string;
  host: string;
  port: string;
  user: string;
  auth: RemoteWizardAuth;
  secret: string;
  path: string | null;
  name: string;
  submitting: boolean;
  bootstrapSteps: string[];
  error?: string;
};
const emptyBrowse = (hostKey = ""): RemoteBrowseState => ({ hostKey, path: "", entries: [], loading: false });
const closedWizard = (): RemoteWizardState => ({
  open: false, step: "method", hostKey: null, label: "", host: "", port: "22", user: "",
  auth: "key", secret: "", path: null, name: "", submitting: false, bootstrapSteps: [],
});

/** Wizard ownership is independent of navigation ownership and directory request order. */
export function createRemoteSlice(access: RemoteProjectAccess) {
  const { get, set, runtime } = access;
  const projects = createRemoteProjectNavigation(access);
  let wizardGeneration = 0;
  let browseSequence = 0;
  let wizardIntent: number | undefined;
  const ownsWizard = (generation: number) => generation === wizardGeneration && get().remoteWizard.open;
  const invalidateWizard = () => {
    wizardGeneration++;
    browseSequence++;
    if (wizardIntent !== undefined && runtime.navigationIntentIsCurrent(wizardIntent)) runtime.beginNavigationIntent();
    wizardIntent = undefined;
  };

  return {
    ...projects.actions,
    browseRemoteDirectory: async (hostKey: string, path?: string): Promise<void> => {
      const generation = wizardGeneration;
      if (!ownsWizard(generation) || get().remoteWizard.hostKey !== hostKey || projects.hostWasRemoved(hostKey)) return;
      const request = ++browseSequence;
      const intent = runtime.beginNavigationIntent();
      wizardIntent = intent;
      const current = () => ownsWizard(generation) && request === browseSequence &&
        runtime.navigationIntentIsCurrent(intent) && get().remoteWizard.hostKey === hostKey && !projects.hostWasRemoved(hostKey);
      const previous = get().remoteBrowse;
      set({ remoteBrowse: { ...(previous.hostKey === hostKey ? previous : emptyBrowse(hostKey)), loading: true, error: undefined } });
      try {
        const result = await api.browseRemoteHost(hostKey, path);
        if (!current()) return;
        set((state) => ({
          remoteBrowse: { hostKey, ...result, loading: false },
          remoteWizard: {
            ...state.remoteWizard,
            path: result.path,
            name: state.remoteWizard.name || result.path.split("/").filter(Boolean).pop() || "",
          },
        }));
      } catch (error) {
        if (current()) set((state) => ({ remoteBrowse: { ...state.remoteBrowse, loading: false, error: remoteErrorMessage(error) } }));
      } finally {
        if (ownsWizard(generation) && request === browseSequence && get().remoteBrowse.loading) {
          set((state) => ({ remoteBrowse: { ...state.remoteBrowse, loading: false, error: i18n.t("remote.browseFailed") } }));
        }
      }
    },

    openRemoteWizard: (hostKey?: string): void => {
      invalidateWizard();
      set({ remoteWizard: { ...closedWizard(), open: true, ...(hostKey ? { hostKey, step: "folder" } : {}) }, remoteBrowse: emptyBrowse(hostKey) });
      if (hostKey) void get().browseRemoteDirectory(hostKey);
    },
    goToRemoteWizardStep: (step: RemoteWizardStep): void => {
      if (get().remoteWizard.submitting) return;
      browseSequence++;
      set((state) => ({ remoteWizard: { ...state.remoteWizard, step, error: undefined } }));
    },
    setRemoteWizardField: (field: "label" | "host" | "port" | "user" | "secret" | "auth" | "name", value: string): void => {
      if (get().remoteWizard.submitting) return;
      if (field === "auth" && value !== "key" && value !== "password") return;
      set((state) => ({ remoteWizard: { ...state.remoteWizard, [field]: value, ...(field === "auth" ? { secret: "" } : {}), error: undefined } }));
    },
    connectRemoteWizard: async (): Promise<boolean> => {
      const wizard = get().remoteWizard;
      if (!wizard.open || !wizard.host.trim() || wizard.submitting) return false;
      const port = Number(wizard.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        set({ remoteWizard: { ...wizard, error: i18n.t("remote.browseFailed") } });
        return false;
      }
      const generation = wizardGeneration;
      const intent = runtime.beginNavigationIntent();
      wizardIntent = intent;
      set({ remoteWizard: { ...wizard, submitting: true, step: "connecting", error: undefined, bootstrapSteps: [] } });
      try {
        const result = await api.bootstrapRemoteHost({
          label: wizard.label.trim() || wizard.host.trim(), host: wizard.host.trim(), port,
          ...(wizard.user.trim() ? { user: wizard.user.trim() } : {}),
          ...(wizard.auth === "password" ? { password: wizard.secret } : wizard.secret.trim() ? { identityFile: wizard.secret.trim() } : {}),
        });
        await get().loadRemoteHosts();
        if (!ownsWizard(generation)) return false;
        if (!runtime.navigationIntentIsCurrent(intent)) {
          set((state) => ({ remoteWizard: { ...state.remoteWizard, secret: "", submitting: false, step: "config", error: i18n.t("remote.browseFailed") } }));
          return false;
        }
        set((state) => ({ remoteWizard: { ...state.remoteWizard, submitting: false, secret: "", hostKey: result.host.hostKey, bootstrapSteps: result.steps, step: "folder" } }));
        void get().browseRemoteDirectory(result.host.hostKey);
        return true;
      } catch (error) {
        if (ownsWizard(generation)) set((state) => ({ remoteWizard: { ...state.remoteWizard, submitting: false, step: "config", error: remoteErrorMessage(error) } }));
        return false;
      }
    },

    selectRemoteWizardHost: (hostKey: string): void => {
      if (get().remoteWizard.submitting) return;
      invalidateWizard();
      set((state) => ({ remoteWizard: { ...state.remoteWizard, hostKey, step: "folder", path: null, name: "", secret: "", error: undefined }, remoteBrowse: emptyBrowse(hostKey) }));
      void get().browseRemoteDirectory(hostKey);
    },
    selectRemoteWizardPath: (path: string, name: string): void => {
      if (get().remoteWizard.submitting) return;
      set((state) => ({ remoteWizard: { ...state.remoteWizard, path, name } }));
    },
    closeRemoteWizard: (): void => {
      invalidateWizard();
      set({ remoteWizard: closedWizard(), remoteBrowse: emptyBrowse() });
    },

    submitRemoteWizard: async (): Promise<RemoteProjectSummary | null> => {
      const wizard = get().remoteWizard;
      if (!wizard.open || !wizard.hostKey || !wizard.path || wizard.submitting || get().remoteBrowse.loading) return null;
      const generation = wizardGeneration;
      const intent = runtime.beginNavigationIntent();
      wizardIntent = intent;
      set({ remoteWizard: { ...wizard, submitting: true, error: undefined } });
      try {
        const { project } = await api.registerRemoteProject({ hostKey: wizard.hostKey, path: wizard.path, ...(wizard.name.trim() ? { name: wizard.name.trim() } : {}) });
        // Registration is durable even when its navigation was superseded.
        projects.remember(project);
        if (!ownsWizard(generation)) return null;
        const activated = await projects.activate(project.id, intent, () => ownsWizard(generation));
        if (!ownsWizard(generation)) return null;
        if (!activated) {
          set((state) => ({ remoteWizard: { ...state.remoteWizard, submitting: false, secret: "", error: i18n.t("remote.browseFailed") } }));
          return null;
        }
        wizardIntent = undefined;
        invalidateWizard();
        set({ remoteWizard: closedWizard(), remoteBrowse: emptyBrowse() });
        return project;
      } catch (error) {
        if (ownsWizard(generation)) set((state) => ({ remoteWizard: { ...state.remoteWizard, submitting: false, error: remoteErrorMessage(error) } }));
        return null;
      }
    },
  };
}
export type RemoteSlice = ReturnType<typeof createRemoteSlice>;

/** The selected remote project remains usable before it has any sessions. */
export function activeSessionRoot(state: AppState): {
  path: string | null; remote: boolean; sessionId?: string; remoteProjectId?: string;
} {
  const session = state.sessions.find((candidate) => candidate.id === state.activeSessionId);
  if (session?.source === "remote") return { path: session.projectPath ?? null, remote: true, sessionId: session.id, remoteProjectId: session.remoteProjectId };
  if (state.activeRemoteProjectId) {
    const project = state.remoteProjects.find((row) => row.id === state.activeRemoteProjectId);
    return { path: project?.path ?? null, remote: true, remoteProjectId: state.activeRemoteProjectId };
  }
  return { path: state.workspace?.path ?? null, remote: false };
}
export function hostSupports(host: RemoteHostSummary | undefined, capability: keyof RemoteHostCapabilities): boolean {
  return host?.capabilities?.[capability] === true;
}
