import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { IconNewProject, IconServer, IconPlus } from "../icons";
import { placeContextMenu, type ContextMenuPlacement } from "../../lib/context-menu";
import { TooltipButton } from "../ui";
/**
 * The Projects section's single `+` control. It is the one entry point for
 * adding a project, whether that project lives on this machine or on a paired
 * remote host: 新建项目 opens the existing Create project dialog, and
 * 远程连接 opens the wizard that browses a paired host's folders.
 *
 * Both entries are always listed. 远程连接 with no host paired opens the
 * wizard's guidance, which is more useful than hiding an entry the user may
 * have paired a host for in Settings.
 */
export function ProjectSourceMenu() {
  const { t } = useTranslation();
  const open = useAppStore((state) => state.projectSourceMenuOpen);
  const openProject = useAppStore((state) => state.openProject);
  const openProjectSourceMenu = useAppStore((state) => state.openProjectSourceMenu);
  const closeProjectSourceMenu = useAppStore((state) => state.closeProjectSourceMenu);
  const openRemoteWizard = useAppStore((state) => state.openRemoteWizard);
  const loadRemoteHosts = useAppStore((state) => state.loadRemoteHosts);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /**
   * The menu is portaled to `document.body`, so it owns its own placement: a
   * `position: fixed` surface with no origin stays in document flow, which for
   * a portal is the end of the body — rendered, but always off-screen. The
   * position comes from the trigger's live rect.
   */
  const [placement, setPlacement] = useState<ContextMenuPlacement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".project-source-menu, [data-project-source-trigger]")) return;
      closeProjectSourceMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeProjectSourceMenu();
    };
    const onViewportChange = () => closeProjectSourceMenu();
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [closeProjectSourceMenu, open]);
  /**
   * Anchor below the trigger, clamped into the viewport like the context
   * menu. Runs after the menu is in the DOM, because a fixed surface needs
   * its own box before it can be clamped.
   */
  const anchorMenu = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const next = placeContextMenu(
      { x: rect.right - size.width, y: rect.bottom + 4 },
      { width: size.width, height: size.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPlacement((previous) =>
      previous && previous.top === next.top && previous.left === next.left
        ? previous
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    if (open) anchorMenu();
    else setPlacement(null);
  }, [anchorMenu, open]);

  const openMenu = () => {
    // Refresh the host list so the remote entry can decide what to open.
    void loadRemoteHosts();
    openProjectSourceMenu();
  };

  const menu = open ? (
    <div
      ref={menuRef}
      className="project-source-menu"
      role="menu"
      aria-label={t("project.createSourceLabel")}
      style={
        placement
          ? { top: `${placement.top}px`, left: `${placement.left}px` }
          : { visibility: "hidden" }
      }
    >
      <button
        type="button"
        role="menuitem"
        data-action="new-project"
        onClick={() => {
          closeProjectSourceMenu();
          void openProject();
        }}
      >
        <IconNewProject size={14} aria-hidden />
        <span>{t("nav.newProject")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        data-action="open-remote-connection"
        onClick={() => {
          closeProjectSourceMenu();
          openRemoteWizard();
        }}
      >
        <IconServer size={14} aria-hidden />
        <span>{t("project.createSourceRemote")}</span>
      </button>
    </div>
  ) : null;

  return (
    <span className="sidebar-menu-wrap">
      <TooltipButton
        ref={triggerRef}
        type="button"
        className="sidebar-toolbar-button"
        data-project-source-trigger="true"
        tooltip={t("project.openSourceMenu")}
        ariaLabel={t("project.openSourceMenu")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            closeProjectSourceMenu();
            return;
          }
          openMenu();
        }}
      >
        <IconPlus size={14} />
      </TooltipButton>
      {menu ? createPortal(menu, document.body) : null}
    </span>
  );
}
