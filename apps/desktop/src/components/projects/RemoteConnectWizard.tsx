import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import {
  IconChevronRight,
  IconServer,
  IconFolder,
  IconX,
} from "../icons";
import { TooltipButton } from "../ui";

const STEPS = ["method", "config", "connecting", "folder"] as const;

/**
 * Remote connection wizard, in the shape VS Code Remote hosts and zcode use:
 * a step rail beside the panel, four steps 鈥?閫夋嫨鏂瑰紡, 濉啓閰嶇疆, 杩炴帴涓?
 * 閫夋嫨鐩綍.
 *
 * Step 2 is where the host is *described by hand*: the destination, port,
 * user, and credential go straight to the existing SSH bootstrap, which
 * uploads the script over the user's own `ssh` client, downloads and
 * verifies the published `pi-host` bundle on the remote machine, and pairs
 * it over the forwarded loopback port. Nothing here duplicates that path.
 *
 * Only SSH ships (ADR 0303). WSL and Docker are listed as unavailable rather
 * than hidden, so the shape matches what users of the other clients expect
 * without pretending they can be connected today.
 */
export function RemoteConnectWizard() {
  const { t } = useTranslation();
  const wizard = useAppStore((state) => state.remoteWizard);
  const hosts = useAppStore((state) => state.remoteHosts);
  const browse = useAppStore((state) => state.remoteBrowse);
  const closeRemoteWizard = useAppStore((state) => state.closeRemoteWizard);
  const goToRemoteWizardStep = useAppStore((state) => state.goToRemoteWizardStep);
  const setRemoteWizardField = useAppStore((state) => state.setRemoteWizardField);
  const connectRemoteWizard = useAppStore((state) => state.connectRemoteWizard);
  const selectRemoteWizardHost = useAppStore((state) => state.selectRemoteWizardHost);
  const selectRemoteWizardPath = useAppStore((state) => state.selectRemoteWizardPath);
  const browseRemoteDirectory = useAppStore((state) => state.browseRemoteDirectory);
  const submitRemoteWizard = useAppStore((state) => state.submitRemoteWizard);
  const [nameTouched, setNameTouched] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const open = wizard.open;
  const activeHost = hosts.find((candidate) => candidate.hostKey === wizard.hostKey);
  const stepIndex = STEPS.indexOf(wizard.step);

  const suggestedName = useMemo(() => {
    const path = browse.path || wizard.path || "";
    return path.split("/").filter(Boolean).pop() ?? "";
  }, [browse.path, wizard.path]);
  useEffect(() => { setNameTouched(false); }, [open, wizard.hostKey]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRemoteWizard();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeRemoteWizard, open, wizard.submitting]);

  if (!open) return null;

  const projectName = nameTouched ? wizard.name : suggestedName;
  const hostRequired = Boolean(wizard.host.trim());
  const passwordRequired = wizard.auth === "password" ? Boolean(wizard.secret) : true;
  const canConnect = hostRequired && passwordRequired && !wizard.submitting;
  const canSubmit = Boolean(wizard.path) && !wizard.submitting && !browse.loading && !browse.error;

  const enter = (path: string) => {
    selectRemoteWizardPath(path, nameTouched ? wizard.name : path.split("/").filter(Boolean).pop() ?? "");
    void browseRemoteDirectory(wizard.hostKey ?? "", path);
  };

  const goUp = () => {
    const up = browse.parent;
    if (!up) return;
    selectRemoteWizardPath(up, nameTouched ? wizard.name : up.split("/").filter(Boolean).pop() ?? "");
    void browseRemoteDirectory(wizard.hostKey ?? "", up);
  };

  const rail = (
    <nav className="remote-wizard-rail" aria-label={t("remote.wizardTitle")}>
      <p className="remote-wizard-rail-title">{t("remote.wizardTitle")}</p>
      <ol className="remote-wizard-steps">
        {STEPS.map((step, index) => {
          const state = index < stepIndex ? "done" : index === stepIndex ? "active" : "todo";
          return (
            <li
              key={step}
              className={`remote-wizard-step is-${state}`}
              data-remote-step={step}
              aria-current={index === stepIndex ? "step" : undefined}
            >
              <span className="remote-wizard-step-marker" aria-hidden>
                {state === "done" ? "✓" : index + 1}
              </span>
              <span className="remote-wizard-step-label">{t(`remote.step.${step}`)}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );

  return createPortal(
    <div
      className="overlay remote-wizard-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) closeRemoteWizard();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog remote-wizard has-rail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-wizard-title"
        onClick={(event) => event.stopPropagation()}
      >
        {rail}

        <div className="remote-wizard-panel">
          <div className="remote-wizard-head">
            <h2 id="remote-wizard-title" className="remote-wizard-title">
              {t(`remote.step.${wizard.step}`)}
            </h2>
            <TooltipButton
              type="button"
              className="project-create-dialog-close"
              tooltip={t("remote.cancel")}
              ariaLabel={t("remote.cancel")}
              onClick={closeRemoteWizard}
            >
              <IconX size={17} />
            </TooltipButton>
          </div>
          <p className="remote-wizard-subtitle">{t(`remote.stepHint.${wizard.step}`)}</p>

          {wizard.step === "method" ? (
            <section className="remote-wizard-section" aria-labelledby="remote-wizard-method">
              <h3 id="remote-wizard-method" className="remote-wizard-section-title">
                {t("remote.methodTitle")}
              </h3>
              <div className="remote-wizard-methods" role="radiogroup" aria-labelledby="remote-wizard-method">
                <button
                  type="button"
                  role="radio"
                  aria-checked="true"
                  className="remote-wizard-method is-active"
                  data-remote-method="ssh"
                  onClick={() => goToRemoteWizardStep("config")}
                >
                  <IconServer size={18} aria-hidden />
                  <span className="remote-wizard-method-name">{t("remote.methodSsh")}</span>
                  <span className="remote-wizard-method-desc">{t("remote.methodSshDesc")}</span>
                </button>
                <div className="remote-wizard-method is-unavailable" data-remote-method="wsl">
                  <span className="remote-wizard-method-mark" aria-hidden>
                    &gt;_
                  </span>
                  <span className="remote-wizard-method-name">{t("remote.methodUnavailable")}</span>
                  <span className="remote-wizard-method-desc">{t("remote.methodUnavailable")}</span>
                  <span className="remote-wizard-method-note">{t("remote.methodUnavailable")}</span>
                </div>
                <div className="remote-wizard-method is-unavailable" data-remote-method="docker">
                  <span className="remote-wizard-method-mark" aria-hidden>
                    鈻?                  </span>
                  <span className="remote-wizard-method-name">{t("remote.methodUnavailable")}</span>
                  <span className="remote-wizard-method-desc">{t("remote.methodUnavailable")}</span>
                  <span className="remote-wizard-method-note">{t("remote.methodUnavailable")}</span>
                </div>
              </div>

              {hosts.length > 0 ? (
                <div className="remote-wizard-paired">
                  <h4 className="remote-wizard-section-title">{t("remote.pairedHosts")}</h4>
                  <ul className="remote-wizard-host-list">
                    {hosts.map((candidate) => (
                      <li key={candidate.hostKey}>
                        <button
                          type="button"
                          className="remote-wizard-host"
                          data-remote-paired={candidate.hostKey}
                          onClick={() => selectRemoteWizardHost(candidate.hostKey)}
                        >
                          <IconServer size={14} aria-hidden />
                          <span className="remote-wizard-host-name">{candidate.label}</span>
                          <span
                            className={`remote-wizard-host-status${candidate.connected ? " is-online" : ""}`}
                          >
                            {candidate.connected ? t("remote.online") : t("remote.offline")}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}

          {wizard.step === "config" ? (
            <section className="remote-wizard-section" aria-labelledby="remote-wizard-config">
              <h3 id="remote-wizard-config" className="remote-wizard-section-title">
                {t("remote.configTitle")}
              </h3>
              <p className="remote-wizard-note">{t("remote.configNote")}</p>

              <div className="remote-wizard-grid">
                <label className="remote-wizard-field is-wide" htmlFor="remote-host">
                  <span className="remote-wizard-label">{t("remote.hostLabel")}</span>
                  <input
                    id="remote-host"
                    className="field-input"
                    value={wizard.host}
                    placeholder={t("remote.hostPlaceholder")}
                    onChange={(event) => setRemoteWizardField("host", event.target.value)}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                  />
                </label>

                <label className="remote-wizard-field" htmlFor="remote-port">
                  <span className="remote-wizard-label">{t("remote.portLabel")}</span>
                  <input
                    id="remote-port"
                    className="field-input"
                    value={wizard.port}
                    inputMode="numeric"
                    onChange={(event) => setRemoteWizardField("port", event.target.value)}
                    spellCheck={false}
                  />
                </label>

                <label className="remote-wizard-field" htmlFor="remote-user">
                  <span className="remote-wizard-label">{t("remote.userLabel")}</span>
                  <input
                    id="remote-user"
                    className="field-input"
                    value={wizard.user}
                    placeholder={t("remote.userPlaceholder")}
                    onChange={(event) => setRemoteWizardField("user", event.target.value)}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                  />
                </label>

                <label className="remote-wizard-field is-wide" htmlFor="remote-label">
                  <span className="remote-wizard-label">{t("remote.labelLabel")}</span>
                  <input
                    id="remote-label"
                    className="field-input"
                    value={wizard.label}
                    placeholder={t("remote.labelPlaceholder")}
                    onChange={(event) => setRemoteWizardField("label", event.target.value)}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                  />
                </label>
              </div>

              <div className="remote-wizard-auth" role="radiogroup" aria-label={t("remote.authLabel")}>
                <span className="remote-wizard-label">{t("remote.authLabel")}</span>
                <div className="remote-wizard-auth-options">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={wizard.auth === "password"}
                    className={`remote-wizard-auth-option${wizard.auth === "password" ? " is-active" : ""}`}
                    data-remote-auth="password"
                    onClick={() => setRemoteWizardField("auth", "password")}
                  >
                    {t("remote.authPassword")}
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={wizard.auth === "key"}
                    className={`remote-wizard-auth-option${wizard.auth === "key" ? " is-active" : ""}`}
                    data-remote-auth="key"
                    onClick={() => setRemoteWizardField("auth", "key")}
                  >
                    {t("remote.authKey")}
                  </button>
                </div>
              </div>

              <label className="remote-wizard-field is-wide" htmlFor="remote-secret">
                <span className="remote-wizard-label">
                  {wizard.auth === "password" ? t("remote.passwordLabel") : t("remote.identityLabel")}
                </span>
                <input
                  id="remote-secret"
                  className="field-input"
                  type={wizard.auth === "password" ? "password" : "text"}
                  value={wizard.secret}
                  placeholder={
                    wizard.auth === "password"
                      ? t("remote.passwordPlaceholder")
                      : t("remote.identityPlaceholder")
                  }
                  onChange={(event) => setRemoteWizardField("secret", event.target.value)}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                />
                <span className="remote-wizard-hint">
                  {wizard.auth === "password"
                    ? t("remote.passwordHint")
                    : t("remote.identityHint")}
                </span>
              </label>

              {wizard.error ? (
                <p className="remote-wizard-error" role="alert">
                  {wizard.error}
                </p>
              ) : null}
            </section>
          ) : null}

          {wizard.step === "connecting" ? (
            <section className="remote-wizard-section" aria-labelledby="remote-wizard-connecting">
              <h3 id="remote-wizard-connecting" className="remote-wizard-section-title">
                {t("remote.connectingTitle")}
              </h3>
              <ol className="remote-wizard-progress" data-remote-progress>
                {wizard.bootstrapSteps.map((step) => (
                  <li key={step} className="is-done">
                    鉁?{t(`remote.stage.${step}`)}
                  </li>
                ))}
                {wizard.bootstrapSteps.length === 0 ? (
                  <li className="is-running">{t("remote.connecting")}</li>
                ) : null}
              </ol>
              <p className="remote-wizard-note">{t("remote.connectNote")}</p>
            </section>
          ) : null}

          {wizard.step === "folder" ? (
            <section className="remote-wizard-section" aria-labelledby="remote-wizard-folder">
              <h3 id="remote-wizard-folder" className="remote-wizard-section-title">
                {t("remote.folderStep")}
              </h3>
              {activeHost ? (
                <p className="remote-wizard-note">
                  {activeHost.label} 路 {activeHost.connected ? t("remote.online") : t("remote.offline")}
                </p>
              ) : null}
              <div className="remote-wizard-breadcrumb">
                <TooltipButton
                  type="button"
                  className="remote-wizard-up"
                  tooltip={t("remote.parent")}
                  ariaLabel={t("remote.parent")}
                  disabled={!browse.parent || browse.loading || wizard.submitting}
                  onClick={goUp}
                >
                  <IconChevronRight size={14} className="remote-wizard-up-icon" />
                </TooltipButton>
                <code className="remote-wizard-path" data-remote-browse-path>
                  {browse.path || t("remote.browseRoot")}
                </code>
              </div>
              <ul className="remote-wizard-list" data-remote-browse-list>
                {browse.loading ? (
                  <li className="remote-wizard-row is-loading">{t("remote.loading")}</li>
                ) : null}
                {!browse.loading && browse.entries.length === 0 ? (
                  <li className="remote-wizard-row is-empty">{t("remote.noFolders")}</li>
                ) : null}
                {browse.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className={`remote-wizard-row${wizard.path === entry.path ? " is-active" : ""}`}
                      data-remote-folder={entry.name}
                      disabled={browse.loading || wizard.submitting}
                      onClick={() => enter(entry.path)}
                    >
                      <IconFolder size={14} aria-hidden />
                      <span>{entry.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {browse.error ? (
                <p className="remote-wizard-error" role="alert">
                  {t("remote.browseFailed")}
                  {" "}{browse.error}
                </p>
              ) : null}

              <label className="remote-wizard-field is-wide" htmlFor="remote-wizard-name-input">
                <span className="remote-wizard-label">{t("remote.nameStep")}</span>
                <input
                  id="remote-wizard-name-input"
                  className="field-input"
                  value={projectName}
                  onChange={(event) => {
                    setNameTouched(true);
                    setRemoteWizardField("name", event.target.value);
                  }}
                  placeholder={suggestedName}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                />
              </label>
              {wizard.error ? (
                <p className="remote-wizard-error" role="alert">
                  {wizard.error}
                </p>
              ) : null}
            </section>
          ) : null}

          <div className="remote-wizard-actions">
            <button
              type="button"
              className="remote-wizard-ghost"
              disabled={wizard.submitting || stepIndex === 0}
              onClick={() => {
                if (stepIndex === 3) goToRemoteWizardStep("config");
                else goToRemoteWizardStep("method");
              }}
            >
              {t("remote.back")}
            </button>
            {/*
              The step forward and the step that commits the project are two
              different actions, so they never sit side by side. Before the
              folder is chosen there is nothing to commit yet 鈥?showing a
              disabled 杩炴帴 there read as a second, broken connect button.
            */}
            {wizard.step === "folder" ? (
              <button
                type="button"
                className="remote-wizard-submit"
                disabled={!canSubmit}
                onClick={() => {
                  if (wizard.path) selectRemoteWizardPath(wizard.path, projectName);
                  void submitRemoteWizard();
                }}
              >
                {wizard.submitting ? t("remote.submitting") : t("remote.submit")}
              </button>
            ) : (
              <button
                type="button"
                className="remote-wizard-primary"
                disabled={wizard.step === "connecting" || (wizard.step === "config" && !canConnect)}
                data-remote-connect
                onClick={() => {
                  if (wizard.step === "method") goToRemoteWizardStep("config");
                  else void connectRemoteWizard();
                }}
              >
                {t("remote.next")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
