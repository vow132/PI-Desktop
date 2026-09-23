import { useState } from "react";
import { useTranslation } from "react-i18next";
import { remoteProjectSessions } from "../../lib/remote-projects";
import { useAppStore } from "../../stores/app-store";
import { IconChevronRight, IconPlus, IconServer, IconX } from "../icons";
import { TooltipButton } from "../ui";

/** Remembered registrations, including offline hosts, live beside local groups. */
export function RemoteProjectList() {
  const { t } = useTranslation();
  const projects = useAppStore((state) => state.remoteProjects);
  const hosts = useAppStore((state) => state.remoteHosts);
  const sessions = useAppStore((state) => state.sessions);
  const activeProjectId = useAppStore((state) => state.activeRemoteProjectId);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const pending = useAppStore((state) => state.remoteProjectPending);
  const errors = useAppStore((state) => state.remoteProjectErrors);
  const selectProject = useAppStore((state) => state.selectRemoteProject);
  const selectSession = useAppStore((state) => state.selectSession);
  const newSession = useAppStore((state) => state.newRemoteProjectSession);
  const removeProject = useAppStore((state) => state.removeRemoteProject);
  const showToast = useAppStore((state) => state.showToast);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!projects.length) return null;

  return (
    <div className="remote-project-list">
      {projects.map((project) => {
        const host = hosts.find((row) => row.hostKey === project.hostKey);
        const open = expanded[project.id] ?? activeProjectId === project.id;
        const chats = remoteProjectSessions(project, sessions);
        const status = t(host?.connected ? "remote.online" : "remote.offline");
        return (
          <section className="remote-project-group" key={project.id} data-remote-project={project.id}>
            <div className={`remote-project-row${activeProjectId === project.id ? " is-active" : ""}`}>
              <TooltipButton
                type="button"
                className={`remote-project-action remote-project-disclosure${open ? " is-open" : ""}`}
                tooltip={t("remote.parent")}
                ariaLabel={t("remote.parent")}
                aria-expanded={open}
                onClick={() => setExpanded((value) => ({ ...value, [project.id]: !open }))}
              >
                <IconChevronRight size={12} />
              </TooltipButton>
              <button
                type="button"
                className="remote-project-select"
                aria-pressed={activeProjectId === project.id}
                onClick={() => {
                  setExpanded((value) => ({ ...value, [project.id]: true }));
                  void selectProject(project.id);
                }}
              >
                <IconServer size={13} aria-hidden />
                <span className="remote-project-label">
                  <span className="remote-project-name">{project.name}</span>
                  <span className="remote-project-meta">{host?.label ?? project.hostKey} · {status}</span>
                  <span className="remote-project-path">{project.path}</span>
                </span>
              </button>
              <TooltipButton
                type="button"
                className="remote-project-action"
                tooltip={t("nav.newChat")}
                ariaLabel={t("nav.newChat")}
                disabled={pending[project.id] === true}
                onClick={() => void newSession(project.id)}
              >
                <IconPlus size={13} />
              </TooltipButton>
              <TooltipButton
                type="button"
                className="remote-project-action"
                tooltip={t("project.clear")}
                ariaLabel={t("project.clear")}
                disabled={pending[project.id] === true}
                onClick={() => void removeProject(project.id)}
              >
                <IconX size={13} />
              </TooltipButton>
            </div>
            {errors[project.id] ? <p className="remote-project-error" role="alert">{errors[project.id]}</p> : null}
            {open ? (
              <ul className="remote-project-sessions">
                {chats.map((chat) => (
                  <li key={chat.id}>
                    <button
                      type="button"
                      className={`remote-project-session${activeSessionId === chat.id ? " is-active" : ""}`}
                      aria-pressed={activeSessionId === chat.id}
                      onClick={() => void selectSession(chat.id).catch((error: unknown) => showToast(
                        error instanceof Error ? error.message : String(error), { variant: "error" },
                      ))}
                    >
                      {chat.title || t("chat.untitledTask")}
                    </button>
                  </li>
                ))}
                {!chats.length ? <li className="remote-project-empty">{t("project.noSessions")}</li> : null}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
