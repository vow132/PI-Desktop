import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRemoteProjectRegistry, remoteProjectId } from "../electron/main/remote/remote-projects.ts";

const row = (hostKey, hostProjectId) => ({ hostKey, hostProjectId, path: "/srv/app", name: `App ${hostProjectId}`, createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" });
async function fixture(t) {
  const dataDir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "remote-projects-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, file: join(dataDir, "remote-projects.json"), registry: createRemoteProjectRegistry({ dataDir }) };
}

test("parallel remote registrations persist independently and survive reload", async (t) => {
  const { dataDir, registry } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => registry.upsert(row(`host-${i % 2}`, `p-${i}`))));
  const restarted = createRemoteProjectRegistry({ dataDir });
  assert.equal((await restarted.list()).length, 12);
  assert.equal((await restarted.listForHost("host-0")).length, 6);
  assert.equal((await restarted.get(remoteProjectId("host-1", "p-1"))).path, "/srv/app");
});

test("forgetting one host never removes another host with the same remote path", async (t) => {
  const { registry } = await fixture(t);
  await registry.upsert(row("a", "p"));
  await registry.upsert(row("b", "p"));
  await registry.remove(remoteProjectId("a", "p"));
  assert.deepEqual((await registry.list()).map(r => r.hostKey), ["b"]);
  await registry.removeForHost("b");
  assert.deepEqual(await registry.list(), []);
});

test("a corrupt registry is not silently overwritten by registration", async (t) => {
  const { file, registry } = await fixture(t);
  await writeFile(file, "{ damaged", "utf8");
  await assert.rejects(registry.upsert(row("a", "p")));
  assert.equal(await readFile(file, "utf8"), "{ damaged");
});

test("invalid record entries are skipped without hiding valid registrations", async (t) => {
  const { file, registry } = await fixture(t);
  await writeFile(file, JSON.stringify({ version: 1, projects: [null, 7, row("a", "p")] }), "utf8");
  assert.deepEqual(await registry.list(), [row("a", "p")]);
});

test("encrypted remote project paths round-trip without a cleartext copy", async (t) => {
  const { dataDir, file } = await fixture(t);
  const encryption = { isAvailable: () => true, encryptString: text => Buffer.from(text).reverse(), decryptString: bytes => Buffer.from(bytes).reverse().toString("utf8") };
  const registry = createRemoteProjectRegistry({ dataDir, encryption });
  await registry.upsert(row("a", "p"));
  assert.equal((await readFile(file, "utf8")).includes("/srv/app"), false);
  assert.deepEqual(await registry.get(remoteProjectId("a", "p")), row("a", "p"));
});
