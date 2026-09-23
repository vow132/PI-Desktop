import { describe, expect, it } from "vitest";
import { validateManifest, PLUGIN_PERMISSIONS } from "./index.js";

const view = { id: "files", title: "Files", entry: "views/index.html" };
const base = { schemaVersion: 1, id: "example.files", name: "Files", version: "1.0.0", main: "main.js" };
const declaration = { version: 1, channelPrefix: "custom_files" };
const manifest = (workspaceFiles: unknown, permissions = ["ui.view", "workspace.remote.read"]) => ({
  ...base, permissions, contributes: { views: [{ ...view, workspaceFiles }] },
});

describe("host-mediated workspace file views", () => {
  it("keeps legacy views valid and adds explicit read/write permissions", () => {
    expect(validateManifest({ ...base, permissions: ["ui.view"], contributes: { views: [view] } }).ok).toBe(true);
    expect(PLUGIN_PERMISSIONS).toContain("workspace.remote.read");
    expect(PLUGIN_PERMISSIONS).toContain("workspace.remote.write");
    const result = validateManifest(manifest(declaration));
    expect(result.ok).toBe(true);
    expect(result.manifest?.contributes?.views?.[0].workspaceFiles).toEqual(declaration);
    expect(validateManifest(manifest(declaration, ["ui.view", "workspace.remote.read", "workspace.remote.write"])).ok).toBe(true);
  });
  it("does not treat ui.view or write alone as remote read approval", () => {
    expect(validateManifest(manifest(declaration, ["ui.view"])).ok).toBe(false);
    expect(validateManifest(manifest(declaration, ["ui.view", "workspace.remote.write"])).ok).toBe(false);
  });
  it("refuses unknown protocol versions, reserved channels and arbitrary roots", () => {
    for (const value of [null, [], {}, { version: 2, channelPrefix: "fm" },
      { version: 1, channelPrefix: "fs" }, { version: 1, channelPrefix: "workspace" },
      { version: 1, channelPrefix: "fm.read" }, { ...declaration, root: "/etc" }]) {
      expect(validateManifest(manifest(value)).ok, JSON.stringify(value)).toBe(false);
    }
  });
  it("does not relax the existing local fs.write wildcard rule", () => {
    expect(validateManifest({ ...manifest(declaration), permissions: ["fs.write", "workspace.remote.read"],
      fs: { write: { root: "workspace", scope: ["**"] } } }).ok).toBe(false);
  });
});
