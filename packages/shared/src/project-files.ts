import Type from "typebox";
import * as Value from "typebox/value";

/** Project-relative, slash-separated paths only; the Host enforces containment. */
export const PROJECT_FILE_TEXT_MAX_BYTES = 128 * 1024;
export const PROJECT_FILE_IMAGE_MAX_BYTES = 256 * 1024;
export const PROJECT_FILE_LIST_LIMIT = 1000;
export const PROJECT_FILE_SEARCH_LIMIT = 200;
export const PROJECT_FILE_SCAN_LIMIT = 5000;
export const PROJECT_FILE_RESPONSE_MAX_BYTES = 900 * 1024;

const projectId = Type.String({ minLength: 1, maxLength: 128 });
const path = Type.String({ maxLength: 1024 });
const name = Type.String({ minLength: 1, maxLength: 255 });
const requestId = Type.String({ minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" });
const version = Type.String({ minLength: 1, maxLength: 128 });
const eol = Type.Union([Type.Literal("lf"), Type.Literal("crlf")]);
const closed = { additionalProperties: false } as const;

export const ProjectFileEntrySchema = Type.Object({
  name, path, isDirectory: Type.Boolean(),
  size: Type.Optional(Type.Integer({ minimum: 0 })),
  mtimeMs: Type.Optional(Type.Number()),
  isSymlink: Type.Optional(Type.Boolean()),
  outside: Type.Optional(Type.Boolean()),
  ignored: Type.Optional(Type.Boolean()),
}, closed);
export type ProjectFileEntry = Type.Static<typeof ProjectFileEntrySchema>;

export const ProjectFilesListInputSchema = Type.Object({ projectId, path: Type.Optional(path) }, closed);
export const ProjectFilesReadInputSchema = Type.Object({ projectId, path }, closed);
export const ProjectFilesSearchInputSchema = Type.Object({
  projectId, path: Type.Optional(path), query: Type.String({ maxLength: 256 }),
  cursor: Type.Optional(Type.String({ maxLength: 4, pattern: "^(0|[1-9][0-9]{0,3})$" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: PROJECT_FILE_SEARCH_LIMIT })),
}, closed);
export const ProjectFilesWriteInputSchema = Type.Object({
  projectId, requestId, path, text: Type.String({ maxLength: PROJECT_FILE_TEXT_MAX_BYTES }),
  expectedVersion: version, eol: Type.Optional(eol), bom: Type.Optional(Type.Boolean()),
}, closed);
export const ProjectFilesCreateInputSchema = Type.Object({ projectId, requestId, parent: path, name, isDirectory: Type.Boolean() }, closed);
export const ProjectFilesRenameInputSchema = Type.Object({ projectId, requestId, path, newName: name }, closed);
export const ProjectFilesMoveInputSchema = Type.Object({ projectId, requestId, from: path, toDir: path }, closed);

const metadata = { ok: Type.Literal(true), path, size: Type.Integer({ minimum: 0 }), mtimeMs: Type.Number() };
export const ProjectFilesListResultSchema = Type.Object({
  ok: Type.Literal(true), path, entries: Type.Array(ProjectFileEntrySchema, { maxItems: PROJECT_FILE_LIST_LIMIT }),
  truncated: Type.Boolean(), ignoreActive: Type.Literal(false),
}, closed);
export const ProjectFilesReadResultSchema = Type.Union([
  Type.Object({ ...metadata, version, kind: Type.Literal("text"), text: Type.String({ maxLength: PROJECT_FILE_TEXT_MAX_BYTES }), eol, bom: Type.Boolean() }, closed),
  Type.Object({ ...metadata, version, kind: Type.Literal("image"), dataUri: Type.String({ maxLength: 350000 }), mime: Type.String({ maxLength: 64 }) }, closed),
  Type.Object({ ...metadata, version, kind: Type.Literal("binary") }, closed),
  // Oversized files are not read/hashed and cannot be edited. No invented version.
  Type.Object({ ...metadata, kind: Type.Literal("tooLarge"), limit: Type.Integer({ minimum: 1 }) }, closed),
]);
export const ProjectFilesSearchResultSchema = Type.Object({
  ok: Type.Literal(true), matches: Type.Array(ProjectFileEntrySchema, { maxItems: PROJECT_FILE_SEARCH_LIMIT }),
  cursor: Type.Optional(Type.String({ maxLength: 4 })), truncated: Type.Boolean(),
}, closed);
export const ProjectFilesWriteResultSchema = Type.Object({ ...metadata, version }, closed);
export const ProjectFilesEntryResultSchema = Type.Object({ ok: Type.Literal(true), entry: ProjectFileEntrySchema }, closed);

export type ProjectFilesListInput = Type.Static<typeof ProjectFilesListInputSchema>;
export type ProjectFilesReadInput = Type.Static<typeof ProjectFilesReadInputSchema>;
export type ProjectFilesSearchInput = Type.Static<typeof ProjectFilesSearchInputSchema>;
export type ProjectFilesWriteInput = Type.Static<typeof ProjectFilesWriteInputSchema>;
export type ProjectFilesCreateInput = Type.Static<typeof ProjectFilesCreateInputSchema>;
export type ProjectFilesRenameInput = Type.Static<typeof ProjectFilesRenameInputSchema>;
export type ProjectFilesMoveInput = Type.Static<typeof ProjectFilesMoveInputSchema>;
export type ProjectFilesListResult = Type.Static<typeof ProjectFilesListResultSchema>;
export type ProjectFilesReadResult = Type.Static<typeof ProjectFilesReadResultSchema>;
export type ProjectFilesSearchResult = Type.Static<typeof ProjectFilesSearchResultSchema>;
export type ProjectFilesWriteResult = Type.Static<typeof ProjectFilesWriteResultSchema>;
export type ProjectFilesEntryResult = Type.Static<typeof ProjectFilesEntryResultSchema>;

export const PROJECT_FILES_INPUT_SCHEMAS = {
  list: ProjectFilesListInputSchema, read: ProjectFilesReadInputSchema, search: ProjectFilesSearchInputSchema,
  write: ProjectFilesWriteInputSchema, create: ProjectFilesCreateInputSchema,
  rename: ProjectFilesRenameInputSchema, move: ProjectFilesMoveInputSchema,
} as const;
export type ProjectFilesMethod = keyof typeof PROJECT_FILES_INPUT_SCHEMAS;
export type ProjectFilesInputs = { [K in ProjectFilesMethod]: Type.Static<(typeof PROJECT_FILES_INPUT_SCHEMAS)[K]> };
export type ProjectFilesResults = {
  list: ProjectFilesListResult; read: ProjectFilesReadResult; search: ProjectFilesSearchResult;
  write: ProjectFilesWriteResult; create: ProjectFilesEntryResult; rename: ProjectFilesEntryResult; move: ProjectFilesEntryResult;
};

/** Shared validation keeps direct Host callers and wire callers on the same contract. */
export function isProjectFilesInput<K extends ProjectFilesMethod>(method: K, input: unknown): input is ProjectFilesInputs[K] {
  return Value.Check(PROJECT_FILES_INPUT_SCHEMAS[method], input);
}
