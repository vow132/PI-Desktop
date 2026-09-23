/** Controlled SSH lifecycle races: only credential I/O and child spawning are faked. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { register, syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSystemSshTransport } = await import("../electron/main/remote/ssh-transport.ts");

const TEST_OPTIONS = { timeout: 10_000 };
const TARGET = { host: "remote.example", password: "lifecycle-test-password" };
const FORWARD = { localPort: 1, remoteHost: "127.0.0.1", remotePort: 41_234 };
const OPERATIONS = [
  ["exec", (transport) => transport.exec("id -u"), "HOST_BOOTSTRAP_FAILED"],
  ["execWithInput", (transport) => transport.execWithInput("sh -s", "echo ready"), "HOST_BOOTSTRAP_FAILED"],
  ["forward", (transport) => transport.forward(FORWARD), "REMOTE_FORWARD_FAILED"],
];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function credential(t, dispose = async () => undefined) {
  return {
    env: { SSH_ASKPASS: "test-only-helper", SSH_ASKPASS_REQUIRE: "force" },
    dispose: t.mock.fn(dispose),
  };
}

function mockSpawn(t, implementation) {
  const spawn = t.mock.method(childProcess, "spawn", implementation);
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
  });
  return spawn;
}

function controlledChild(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = t.mock.fn(() => {
    queueMicrotask(() => child.emit("close", null));
    return true;
  });
  t.after(() => {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });
  return child;
}

function controlledSpawns(t, count) {
  const children = Array.from({ length: count }, () => controlledChild(t));
  const started = children.map(() => deferred());
  let index = 0;
  const spawn = mockSpawn(t, () => {
    const current = index++;
    assert.ok(children[current], "unexpected SSH child");
    started[current].resolve();
    return children[current];
  });
  return { children, started, spawn };
}

function transportFor(t, createAskpass, options = {}, target = TARGET) {
  const transport = createSystemSshTransport(target, { createAskpass, ...options });
  t.after(() => transport.dispose());
  return transport;
}

for (const [name, run, errorCode] of OPERATIONS) {
  test(`dispose during pending ${name} acquisition cleans late material without spawning`, TEST_OPTIONS, async (t) => {
    const acquisition = deferred();
    const acquiring = deferred();
    const cleaned = deferred();
    const material = credential(t, async () => cleaned.resolve());
    const createAskpass = t.mock.fn(() => {
      acquiring.resolve();
      return acquisition.promise;
    });
    const spawn = mockSpawn(t, () => {
      throw new Error("SSH must not start after disposal");
    });
    const transport = transportFor(t, createAskpass);
    const outcome = run(transport).then(
      () => null,
      (error) => error,
    );
    await acquiring.promise;
    transport.dispose();
    transport.dispose();
    assert.equal(material.dispose.mock.callCount(), 0);
    acquisition.resolve(material);
    const error = await outcome;
    await cleaned.promise;

    assert.equal(spawn.mock.callCount(), 0, "no SSH child may start after disposal");
    assert.equal(error?.errorCode, errorCode);
    assert.match(error.message, /disposed/);
    assert.equal(material.dispose.mock.callCount(), 1);
    await assert.rejects(run(transport), /disposed/);
    assert.equal(createAskpass.mock.callCount(), 1);
    transport.dispose();
    assert.equal(material.dispose.mock.callCount(), 1);
  });

  for (const password of [undefined, TARGET.password]) {
    test(`dispose after ${name} acquires its ${password === undefined ? "key" : "password"} environment still prevents spawn`, TEST_OPTIONS, async (t) => {
      const acquisition = deferred();
      const cleaned = deferred();
      const material = credential(t, async () => cleaned.resolve());
      const spawn = mockSpawn(t, () => {
        throw new Error("SSH must not start after disposal");
      });
      const transport = transportFor(t, () => acquisition.promise, {}, { ...TARGET, password });
      const rejected = assert.rejects(run(transport), { errorCode, message: "ssh transport is disposed" });
      if (password === undefined) {
        transport.dispose();
      } else {
        // Resume acquireEnv first, then dispose before its caller resumes to
        // spawn. This exercises the second await boundary, not pending I/O.
        acquisition.resolve(material);
        queueMicrotask(() => transport.dispose());
      }
      await rejected;
      if (password !== undefined) await cleaned.promise;
      assert.equal(spawn.mock.callCount(), 0);
      assert.equal(material.dispose.mock.callCount(), password === undefined ? 0 : 1);
    });
  }
}

for (const password of [undefined, TARGET.password]) {
  test(`an already disposed ${password === undefined ? "key" : "password"} transport refuses every operation`, TEST_OPTIONS, async (t) => {
    const createAskpass = t.mock.fn(async () => credential(t));
    const spawn = mockSpawn(t, () => {
      throw new Error("SSH must not start after disposal");
    });
    const transport = transportFor(t, createAskpass, {}, { ...TARGET, password });
    transport.dispose();
    for (const [, run, errorCode] of OPERATIONS) {
      await assert.rejects(run(transport), (error) => {
        assert.equal(error.errorCode, errorCode);
        assert.match(error.message, /disposed/);
        return true;
      });
    }
    assert.equal(createAskpass.mock.callCount(), 0);
    assert.equal(spawn.mock.callCount(), 0);
  });
}

test("overlapping exec and upload retain material until the last command completes", TEST_OPTIONS, async (t) => {
  const acquisition = deferred();
  const material = credential(t);
  const createAskpass = t.mock.fn(() => acquisition.promise);
  const { children, started, spawn } = controlledSpawns(t, 2);
  const transport = transportFor(t, createAskpass);
  const first = transport.exec("uname -s");
  const second = transport.execWithInput("sh -s", "echo ready");
  assert.equal(createAskpass.mock.callCount(), 1);
  acquisition.resolve(material);
  await Promise.all(started.map((gate) => gate.promise));
  for (const call of spawn.mock.calls) {
    assert.equal(call.arguments[2].env.SSH_ASKPASS, material.env.SSH_ASKPASS);
    assert.equal(call.arguments[1].includes(TARGET.password), false);
  }
  children[0].emit("close", 0);
  assert.equal((await first).code, 0);
  assert.equal(material.dispose.mock.callCount(), 0);
  children[1].emit("close", 0);
  assert.equal((await second).code, 0);
  assert.equal(material.dispose.mock.callCount(), 1);
});

test("a ready forward releases its auth use but does not delete an overlapping command's material", TEST_OPTIONS, async (t) => {
  const server = createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const material = credential(t);
  const createAskpass = t.mock.fn(async () => material);
  const { children, started } = controlledSpawns(t, 2);
  const transport = transportFor(t, createAskpass);
  const command = transport.exec("id -u");
  const forward = await transport.forward({ ...FORWARD, localPort: server.address().port });
  await started[0].promise;
  assert.equal(createAskpass.mock.callCount(), 1);
  assert.equal(material.dispose.mock.callCount(), 0);
  children[0].emit("close", 0);
  await command;
  assert.equal(material.dispose.mock.callCount(), 1);
  assert.equal(children[1].kill.mock.callCount(), 0, "the authenticated tunnel stays live");
  await forward.close();
  await forward.close();
  assert.equal(children[1].kill.mock.callCount(), 1);
  assert.equal(material.dispose.mock.callCount(), 1);
});

test("a failed shared acquisition does not poison later retries", TEST_OPTIONS, async (t) => {
  const acquisition = deferred();
  const failure = new Error("credential preparation failed");
  const material = credential(t);
  let attempts = 0;
  const createAskpass = t.mock.fn(() => ++attempts === 1 ? acquisition.promise : Promise.resolve(material));
  const child = controlledChild(t);
  const spawn = mockSpawn(t, () => {
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
  const transport = transportFor(t, createAskpass);
  const first = assert.rejects(transport.exec("id -u"), (error) => error === failure);
  const second = assert.rejects(transport.forward(FORWARD), (error) => error === failure);
  acquisition.reject(failure);
  await Promise.all([first, second]);
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal((await transport.exec("uname -s")).code, 0);
  assert.equal(createAskpass.mock.callCount(), 2);
  assert.equal(material.dispose.mock.callCount(), 1);
});

for (const [name, run] of OPERATIONS) {
  test(`synchronous ${name} spawn failure releases credentials`, TEST_OPTIONS, async (t) => {
    const failure = new Error("fixture spawn failure");
    const material = credential(t);
    mockSpawn(t, () => { throw failure; });
    const transport = transportFor(t, async () => material);
    await assert.rejects(run(transport), (error) => {
      if (name === "forward") assert.equal(error, failure);
      else {
        assert.equal(error.errorCode, "HOST_BOOTSTRAP_FAILED");
        assert.match(error.message, /could not be started: fixture spawn failure/);
      }
      return true;
    });
    assert.equal(material.dispose.mock.callCount(), 1);
    transport.dispose();
    assert.equal(material.dispose.mock.callCount(), 1);
  });
}

test("a stale cleanup completion cannot release newer shared material", TEST_OPTIONS, async (t) => {
  const cleaning = deferred();
  const finishCleanup = deferred();
  const oldMaterial = credential(t, () => {
    cleaning.resolve();
    return finishCleanup.promise;
  });
  const newMaterial = credential(t);
  let acquisitions = 0;
  const { children, started } = controlledSpawns(t, 3);
  const transport = transportFor(t, async () => ++acquisitions === 1 ? oldMaterial : newMaterial);
  const first = transport.exec("first");
  await started[0].promise;
  children[0].emit("close", 0);
  await cleaning.promise;
  const second = transport.exec("second");
  const third = transport.exec("third");
  await Promise.all(started.slice(1).map((gate) => gate.promise));
  finishCleanup.resolve();
  await first;
  children[1].emit("close", 0);
  await second;
  assert.equal(newMaterial.dispose.mock.callCount(), 0);
  children[2].emit("close", 0);
  await third;
  assert.equal(acquisitions, 2);
  assert.equal(oldMaterial.dispose.mock.callCount(), 1);
  assert.equal(newMaterial.dispose.mock.callCount(), 1);
});

test("repeated dispose reaps live commands and cleans their shared credential only once", TEST_OPTIONS, async (t) => {
  const cleaned = deferred();
  const material = credential(t, async () => cleaned.resolve());
  const { children, started } = controlledSpawns(t, 2);
  const transport = transportFor(t, async () => material);
  const commands = [
    assert.rejects(transport.exec("first"), { errorCode: "HOST_BOOTSTRAP_FAILED" }),
    assert.rejects(transport.exec("second"), { errorCode: "HOST_BOOTSTRAP_FAILED" }),
  ];
  await Promise.all(started.map((gate) => gate.promise));
  transport.dispose();
  transport.dispose();
  await Promise.all([...commands, cleaned.promise]);
  for (const child of children) assert.equal(child.kill.mock.callCount(), 1);
  assert.equal(material.dispose.mock.callCount(), 1);
});

for (const pendingDispose of [false, true]) {
  test(`cleanup failures ${pendingDispose ? "after disposal" : "after exec"} log a fixed secret-free warning`, TEST_OPTIONS, async (t) => {
    const acquisition = deferred();
    const warned = deferred();
    const logged = [];
    const material = credential(t, async () => {
      throw new Error(`${TARGET.password}: private credential path`);
    });
    const child = controlledChild(t);
    mockSpawn(t, () => {
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
    const transport = transportFor(t, () => acquisition.promise, {
      log: (...entry) => {
        logged.push(entry);
        if (entry[0] === "warn") warned.resolve();
      },
    });
    const command = transport.exec("id -u");
    const outcome = pendingDispose ? assert.rejects(command, /disposed/) : command;
    if (pendingDispose) transport.dispose();
    acquisition.resolve(material);
    await outcome;
    await warned.promise;
    assert.deepEqual(logged.filter(([level]) => level === "warn"), [
      ["warn", "ssh askpass material cleanup failed"],
    ]);
    assert.equal(JSON.stringify(logged).includes(TARGET.password), false);
    assert.equal(material.dispose.mock.callCount(), 2);
  });
}

test("credential cleanup retries a transient failure before completing", TEST_OPTIONS, async (t) => {
  let attempts = 0;
  const material = credential(t, async () => {
    if (++attempts === 1) throw new Error("private credential path");
  });
  const { children, started } = controlledSpawns(t, 1);
  const transport = transportFor(t, async () => material);
  const command = transport.exec("id -u");
  await started[0].promise;
  children[0].emit("close", 0);
  await command;
  assert.equal(attempts, 2);
  transport.dispose();
  assert.equal(attempts, 2);
});

test("failed cleanup is retried on the next acquisition without losing newer material", TEST_OPTIONS, async (t) => {
  let attempts = 0;
  const oldMaterial = credential(t, async () => {
    if (++attempts <= 2) throw new Error("private credential path");
  });
  const newMaterial = credential(t);
  let acquisitions = 0;
  const { children, started } = controlledSpawns(t, 2);
  const transport = transportFor(t, async () => ++acquisitions === 1 ? oldMaterial : newMaterial);
  const first = transport.exec("first");
  await started[0].promise;
  children[0].emit("close", 0);
  await first;
  assert.equal(attempts, 2);
  const second = transport.exec("second");
  await started[1].promise;
  assert.equal(attempts, 3);
  assert.equal(newMaterial.dispose.mock.callCount(), 0);
  children[1].emit("close", 0);
  await second;
  assert.equal(newMaterial.dispose.mock.callCount(), 1);
});

test("late material cleanup remains retryable through repeated transport disposal", TEST_OPTIONS, async (t) => {
  const acquisition = deferred();
  const warnings = [deferred(), deferred()];
  const cleaned = deferred();
  const logged = [];
  let attempts = 0;
  const material = credential(t, async () => {
    if (++attempts <= 4) throw new Error(`${TARGET.password}: private credential path`);
    cleaned.resolve();
  });
  const spawn = mockSpawn(t, () => { throw new Error("unexpected SSH spawn"); });
  const transport = transportFor(t, () => acquisition.promise, {
    log: (...entry) => {
      if (entry[0] !== "warn") return;
      logged.push(entry);
      warnings[logged.length - 1]?.resolve();
    },
  });
  const command = assert.rejects(transport.exec("id -u"), /disposed/);
  transport.dispose();
  acquisition.resolve(material);
  await Promise.all([command, warnings[0].promise]);
  assert.equal(attempts, 2);
  transport.dispose();
  transport.dispose();
  await warnings[1].promise;
  assert.equal(attempts, 4, "concurrent disposal retries share one bounded cleanup");
  transport.dispose();
  await cleaned.promise;
  assert.equal(attempts, 5);
  transport.dispose();
  assert.equal(attempts, 5, "successful cleanup is not retried");
  assert.equal(spawn.mock.callCount(), 0);
  assert.deepEqual(logged, [
    ["warn", "ssh askpass material cleanup failed"],
    ["warn", "ssh askpass material cleanup failed"],
  ]);
});

for (const stoppedBy of ["dispose", "child exit"]) {
  test(`forward rejects ${stoppedBy} while credential cleanup is pending`, TEST_OPTIONS, async (t) => {
    const server = createServer((socket) => socket.end());
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const cleaning = deferred();
    const finishCleanup = deferred();
    const material = credential(t, () => {
      cleaning.resolve();
      return finishCleanup.promise;
    });
    const { children } = controlledSpawns(t, 1);
    const transport = transportFor(t, async () => material);
    const rejected = assert.rejects(
      transport.forward({ ...FORWARD, localPort: server.address().port }),
      (error) => {
        assert.equal(error.errorCode, "REMOTE_FORWARD_FAILED");
        assert.match(error.message, stoppedBy === "dispose" ? /disposed/ : /ssh exited/);
        return true;
      },
    );
    await cleaning.promise;
    if (stoppedBy === "dispose") transport.dispose();
    else children[0].emit("close", 255);
    finishCleanup.resolve();
    await rejected;
    assert.equal(material.dispose.mock.callCount(), 1);
  });
}
