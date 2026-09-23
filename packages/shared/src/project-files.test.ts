import { describe, expect, it } from "vitest";
import * as Value from "typebox/value";
import {
  isProjectFilesInput, PROJECT_FILE_TEXT_MAX_BYTES, ProjectFilesReadResultSchema,
  ProjectFilesSearchResultSchema, PROJECT_FILES_INPUT_SCHEMAS,
} from "./project-files.js";

const write = { projectId: "7", path: "README.md", text: "hello", expectedVersion: "a".repeat(64), requestId: "12345678-abcd-1234-abcd-123456789012" };
describe("project-file wire contracts", () => {
  it("requires project identity and bounded mutation requestIds, without arbitrary roots or force writes", () => {
    expect(isProjectFilesInput("write", write)).toBe(true);
    expect(isProjectFilesInput("write", { ...write, expectedVersion: undefined })).toBe(false);
    expect(isProjectFilesInput("write", { ...write, requestId: undefined })).toBe(false);
    expect(isProjectFilesInput("write", { ...write, requestId: "x".repeat(129) })).toBe(false);
    expect(isProjectFilesInput("write", { ...write, requestId: "invalid id" })).toBe(false);
    expect(isProjectFilesInput("write", { ...write, force: true })).toBe(false);
    expect(isProjectFilesInput("list", { projectId: "7", root: "/home" })).toBe(false);
    expect(isProjectFilesInput("list", { path: "" })).toBe(false);
    expect(isProjectFilesInput("write", { ...write, text: "a".repeat(PROJECT_FILE_TEXT_MAX_BYTES + 1) })).toBe(false);
  });
  it("bounds search paging and explicitly classifies non-text previews", () => {
    expect(isProjectFilesInput("search", { projectId: "7", query: "[.*", cursor: "200", limit: 200 })).toBe(true);
    for (const cursor of ["-1", "NaN", "1e3", "10000", "01"]) expect(isProjectFilesInput("search", { projectId: "7", query: "a", cursor })).toBe(false);
    expect(isProjectFilesInput("search", { projectId: "7", query: "a", limit: 201 })).toBe(false);
    const metadata = { ok: true, path: "large.txt", size: 999999, mtimeMs: 123 };
    expect(Value.Check(ProjectFilesReadResultSchema, { ...metadata, kind: "tooLarge", limit: 131072 })).toBe(true);
    expect(Value.Check(ProjectFilesReadResultSchema, { ...metadata, kind: "binary", version: "a".repeat(64) })).toBe(true);
    expect(Value.Check(ProjectFilesReadResultSchema, { ...metadata, kind: "sqlite" })).toBe(false);
    expect(Value.Check(ProjectFilesSearchResultSchema, { ok: true, matches: [], truncated: false })).toBe(true);
    expect(Object.keys(PROJECT_FILES_INPUT_SCHEMAS)).toEqual(["list", "read", "search", "write", "create", "rename", "move"]);
  });
});