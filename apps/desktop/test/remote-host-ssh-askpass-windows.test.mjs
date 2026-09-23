/** Offline Windows askpass tests: only disposable credentials and keys. */
import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import fs, { access, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { register, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { ASKPASS_SECRET_ENV, createSshAskpass } = await import(
  "../electron/main/remote/ssh-askpass.ts"
);
const { WINDOWS_ASKPASS_CODE, windowsAskpassCommand, protectWindowsAskpassDirectory } = await import(
  "../electron/main/remote/ssh-askpass-windows.ts"
);

const WINDOWS = {
  skip: process.platform !== "win32" && "requires native Windows",
  timeout: 30_000,
};
const PASSWORD = '  local fixture 测试 café %PATH% !bang! & | ^ > < "quoted" (value)\t  ';
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 };
const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const powershell = join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
const keygen = join(system32, "OpenSSH", "ssh-keygen.exe");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

async function requireTools(t, ...paths) {
  for (const path of paths) {
    if (!(await exists(path))) {
      t.skip(`required native Windows executable is not installed: ${path}`);
      return false;
    }
  }
  return true;
}

async function runtimeFor(t, engine) {
  if (engine === "Node") return process.execPath;
  // Resolve only the repository's installed Electron, including a reused pnpm
  // store through the worktree's node_modules junction. Never install a runtime.
  const modules = join(here, "../../../node_modules");
  const candidates = [join(modules, "electron")];
  const store = join(modules, ".pnpm");
  if (await exists(store)) {
    for (const name of (await readdir(store)).filter((name) => /^electron@43\./.test(name))) {
      candidates.push(join(store, name, "node_modules/electron"));
    }
  }
  for (const candidate of candidates) {
    const manifest = join(candidate, "package.json");
    if (!(await exists(manifest))) continue;
    const { version } = JSON.parse(await readFile(manifest, "utf8"));
    const executable = join(candidate, "dist/electron.exe");
    if (version.startsWith("43.") && await exists(executable)) return executable;
  }
  t.skip("repository-installed Electron 43 Windows executable is not available");
  return undefined;
}

async function tmpDir(t) {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "ssh askpass % ! & ^ (测试)-"));
  const nativeRm = rm;
  t.after(() => nativeRm(dir, REMOVE_OPTIONS));
  return dir;
}

function activateMocks(t) {
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

function run(binary, args, env) {
  return spawnSync(binary, args, {
    env: { ...process.env, ...env },
    windowsHide: true,
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function assertAnswer(result) {
  assert.equal(result.error === undefined, true, "native runtime must launch without timing out");
  assert.equal(result.status, 0, "native askpass runtime must succeed");
  // Compare booleans so even a failed assertion cannot print fixture secrets.
  assert.equal(result.stdout.equals(Buffer.from(`${PASSWORD}\n`, "utf8")), true,
    "stdout must preserve exactly the UTF-8 credential bytes and one newline");
  assert.equal(result.stderr.length, 0, "askpass must not emit diagnostics");
}

for (const engine of ["Node", "Electron 43"]) {
  test(`${engine} askpass preserves bytes and treats malicious prompts as plain arguments`, WINDOWS, async (t) => {
    if (!(await requireTools(t, powershell))) return;
    const runtime = await runtimeFor(t, engine);
    if (!runtime) return;
    const parent = await tmpDir(t);
    const material = await createSshAskpass(PASSWORD, { dir: parent });
    t.after(() => material.dispose());
    const secretPath = material.env[ASKPASS_SECRET_ENV];
    assert.equal((await readFile(secretPath)).equals(Buffer.from(`${PASSWORD}\n`, "utf8")), true);
    assert.equal(dirname(dirname(secretPath)), parent, "credential directory must keep its original path");
    assert.equal(/[^\x00-\x7f]/.test(secretPath) && /[%!&]/.test(secretPath), true);
    assert.deepEqual(await readdir(dirname(secretPath)), ["secret"], "no executable helper is written");
    assert.equal(material.env.SSH_ASKPASS, await windowsAskpassCommand());
    assert.equal(material.env.SSH_ASKPASS_REQUIRE, "force");
    assert.equal(material.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(material.env.NODE_OPTIONS, "");
    assert.equal(material.env.NODE_PATH, "");
    assert.equal(Object.values(material.env).some((value) => value.includes(PASSWORD)), false);
    const command = await windowsAskpassCommand(runtime);
    const parts = /^"([^"]+)" --input-type=commonjs -e "([^"]+)" --$/.exec(command);
    assert.equal(parts !== null, true, "command must use only the runtime and fixed code");
    assert.equal(parts[2] === WINDOWS_ASKPASS_CODE, true);
    assert.equal(/[^\x20-\x7e]|[%!^&()]/.test(parts[1]), false, "runtime path must be OpenSSH-safe");
    assert.equal(await realpath(parts[1]), await realpath(runtime), "an alias must identify the same executable");
    assert.equal(command.includes(PASSWORD) || command.includes(secretPath), false);

    const marker = join(parent, "prompt-command-executed");
    const payload = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`;
    const preload = join(parent, "prompt-preload.cjs");
    await writeFile(preload, payload, { flag: "wx" });
    const env = {
      ...process.env,
      NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
      NODE_PATH: parent,
      ...material.env,
    };
    if (engine === "Electron 43") {
      const version = run(runtime, ["--input-type=commonjs", "-e", "process.stdout.write(process.versions.electron)"], env);
      assert.equal(version.status, 0, "the installed application engine must run as Node");
      assert.match(version.stdout.toString("utf8"), /^43\./);
      assert.equal(version.stderr.length, 0);
    }
    for (const prompt of [
      `" & echo injected > "${marker}" & --eval="${payload}"`,
      `--eval=${payload}`,
      `--require=${preload}`,
    ]) {
      // No shell, escaping shim, or verbatim command line: prompt is one argv
      // value after --, exactly as untrusted prompt data must be handled.
      const args = ["--input-type=commonjs", "-e", WINDOWS_ASKPASS_CODE, "--", prompt];
      assert.equal(args.some((arg) => arg.includes(PASSWORD)), false);
      assertAnswer(run(runtime, args, env));
      await assert.rejects(stat(marker), { code: "ENOENT" });
    }
    await material.dispose();
    await assert.rejects(stat(dirname(secretPath)), { code: "ENOENT" });
    const missing = run(runtime, ["--input-type=commonjs", "-e", WINDOWS_ASKPASS_CODE, "--", "prompt"], env);
    assert.equal(missing.error === undefined, true);
    assert.equal(missing.status, 1, "a missing credential fails closed");
    assert.equal(missing.stdout.length, 0);
    assert.equal(missing.stderr.length, 0, "read failures must not expose credential paths");
  });

  test(`native OpenSSH unlocks a disposable key using ${engine} askpass`, WINDOWS, async (t) => {
    if (!(await requireTools(t, powershell, keygen))) return;
    const runtime = await runtimeFor(t, engine);
    if (!runtime) return;
    const parent = await tmpDir(t);
    const material = await createSshAskpass(PASSWORD, { dir: parent });
    const wrong = await createSshAskpass("different-local-fixture", { dir: parent });
    t.after(() => Promise.all([material.dispose(), wrong.dispose()]));
    const command = await windowsAskpassCommand(runtime);
    const marker = join(parent, "native-prompt-command-executed");
    const key = join(parent, "key & mkdir %PI_TEST_PROMPT_MARKER% & rem !prompt! ^ (测试)");
    // -N is disposable fixture setup only. The tested unlock argv and env
    // contain no password; no server, network, or user's key is involved.
    const generated = run(keygen, ["-q", "-t", "ed25519", "-N", PASSWORD, "-f", key]);
    assert.equal(generated.error === undefined, true);
    assert.equal(generated.status, 0, "OpenSSH must create the encrypted fixture");
    const unlock = (askpass) => {
      const args = ["-y", "-f", key];
      const env = { ...askpass.env, SSH_ASKPASS: command, PI_TEST_PROMPT_MARKER: marker };
      assert.equal(args.some((arg) => arg.includes(PASSWORD)), false);
      assert.equal(Object.values(env).some((value) => value.includes(PASSWORD)), false);
      return run(keygen, args, env);
    };
    const rejected = unlock(wrong);
    assert.equal(rejected.error === undefined, true, "wrong-password control must not time out");
    assert.equal(Number.isInteger(rejected.status) && rejected.status !== 0, true,
      "the key must actually require the correct passphrase");
    assert.equal(rejected.stdout.length, 0);
    const unlocked = unlock(material);
    assert.equal(unlocked.error === undefined, true, "native OpenSSH must launch the real helper");
    assert.equal(unlocked.status, 0, "OpenSSH must consume the direct runtime's answer");
    assert.equal(unlocked.stderr.length, 0);
    assert.equal(unlocked.stdout.toString("utf8").trim() === (await readFile(`${key}.pub`, "utf8")).trim(), true,
      "unlocked public key must match the encrypted fixture");
    await assert.rejects(stat(marker), { code: "ENOENT" });
    // ssh-keygen uses a generic prompt; this proves its native launch boundary,
    // not a server-controlled prompt. Direct-runtime cases above cover payloads.
    await Promise.all([material.dispose(), wrong.dispose()]);
    await assert.rejects(stat(dirname(material.env[ASKPASS_SECRET_ENV])), { code: "ENOENT" });
  });
}

function readAcl(path) {
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:PI_TEST_ACL_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
@{
  protected = $acl.AreAccessRulesProtected
  ownerIsCurrentUser = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value
  ruleCount = $rules.Count
  allRulesInherited = @($rules | Where-Object { -not $_.IsInherited }).Count -eq 0
  onlyCurrentUserFullControl = @($rules | Where-Object {
    $_.IdentityReference.Value -ne $sid.Value -or
    $_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
    $_.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl
  }).Count -eq 0
} | ConvertTo-Json -Compress
`], {
    env: { SystemRoot: process.env.SystemRoot, PI_TEST_ACL_PATH: path },
    windowsHide: true,
    timeout: 10_000,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "independent native ACL readback must succeed");
  return JSON.parse(result.stdout);
}

test("Windows DACL is verified before credential writes and inherited by the secret", WINDOWS, async (t) => {
  if (!(await requireTools(t, powershell))) return;
  const parent = await tmpDir(t);
  let verifiedBeforeWrite = false;
  const material = await createSshAskpass(PASSWORD, {
    dir: parent,
    protectWindowsDirectory: async (directory) => {
      assert.deepEqual(await readdir(directory), [], "no secret may precede ACL protection");
      await protectWindowsAskpassDirectory(directory);
      assert.deepEqual(readAcl(directory), {
        protected: true,
        ownerIsCurrentUser: true,
        ruleCount: 1,
        allRulesInherited: false,
        onlyCurrentUserFullControl: true,
      });
      assert.deepEqual(await readdir(directory), []);
      verifiedBeforeWrite = true;
    },
  });
  t.after(() => material.dispose());
  assert.equal(verifiedBeforeWrite, true);
  assert.deepEqual(readAcl(material.env[ASKPASS_SECRET_ENV]), {
    protected: false,
    ownerIsCurrentUser: true,
    ruleCount: 1,
    allRulesInherited: true,
    onlyCurrentUserFullControl: true,
  });
});

test("failed ACL setup removes the empty directory without writing credentials", async (t) => {
  const parent = await tmpDir(t);
  let attempted = false;
  await assert.rejects(createSshAskpass(PASSWORD, {
    dir: parent,
    platform: "win32",
    protectWindowsDirectory: async (directory) => {
      attempted = true;
      assert.deepEqual(await readdir(directory), []);
      throw Object.assign(new Error("fixture protection failure"), { errorCode: "HOST_BOOTSTRAP_FAILED" });
    },
  }), { errorCode: "HOST_BOOTSTRAP_FAILED" });
  assert.equal(attempted, true);
  assert.deepEqual(await readdir(parent), []);
});

test("Windows secret creation is exclusive and rolls back a blocked write", WINDOWS, async (t) => {
  if (!(await requireTools(t, powershell))) return;
  const parent = await tmpDir(t);
  await assert.rejects(createSshAskpass(PASSWORD, {
    dir: parent,
    protectWindowsDirectory: async (directory) => {
      await protectWindowsAskpassDirectory(directory);
      await writeFile(join(directory, "secret"), "occupied fixture", { flag: "wx" });
    },
  }), { code: "EEXIST" });
  assert.deepEqual(await readdir(parent), [], "partial material must be removed");
});

function assertSanitized(error, parent) {
  assert.equal(error.errorCode, "HOST_BOOTSTRAP_FAILED");
  assert.equal(error.message.includes(parent) || error.message.includes(PASSWORD), false);
  for (const field of ["path", "stdout", "stderr", "cause"]) assert.equal(error[field], undefined);
  return true;
}

test("Windows ACL subprocess is bounded, path-only and sanitizes failures", WINDOWS, async (t) => {
  const parent = await tmpDir(t);
  let called = false;
  t.mock.method(childProcess, "execFile", (binary, args, options, callback) => {
    called = true;
    assert.equal(binary, powershell);
    assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    assert.equal(args.length, 5);
    assert.equal(args.some((arg) => arg.includes(parent) || arg.includes(PASSWORD)), false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout > 0 && options.timeout <= 10_000, true);
    assert.equal(options.maxBuffer <= 16 * 1024, true);
    assert.deepEqual(Object.keys(options.env).sort(), ["PI_SSH_ASKPASS_DIR", "SystemRoot"]);
    assert.equal(dirname(options.env.PI_SSH_ASKPASS_DIR), parent);
    callback(Object.assign(new Error(`private child diagnostic ${PASSWORD}`), {
      stdout: PASSWORD, stderr: PASSWORD, killed: true,
    }));
  });
  activateMocks(t);
  await assert.rejects(createSshAskpass(PASSWORD, { dir: parent }), (error) => {
    assertSanitized(error, parent);
    assert.match(error.message, /Windows PowerShell.*NTFS/);
    assert.equal(error.message.includes("private child"), false);
    return true;
  });
  assert.equal(called, true);
  assert.deepEqual(await readdir(parent), []);
});

for (const mismatch of [false, true]) {
  test(`Windows runtime alias rejects ${mismatch ? "a different executable" : "an unusable Unicode path"}`, WINDOWS, async (t) => {
    const parent = await tmpDir(t);
    const runtime = join(parent, "fixture-runtime.exe");
    await writeFile(runtime, "not executed", { flag: "wx" });
    let called = false;
    t.mock.method(childProcess, "execFile", (binary, args, options, callback) => {
      called = true;
      assert.equal(binary, powershell);
      assert.equal(args.some((arg) => arg.includes(runtime)), false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout > 0 && options.timeout <= 10_000, true);
      assert.deepEqual(Object.keys(options.env).sort(), ["PI_SSH_ASKPASS_HELPER", "SystemRoot"]);
      assert.equal(options.env.PI_SSH_ASKPASS_HELPER, runtime);
      callback(null, mismatch ? process.execPath : runtime, "");
    });
    activateMocks(t);
    await assert.rejects(windowsAskpassCommand(runtime), (error) => {
      assertSanitized(error, parent);
      assert.match(error.message, /application executable.*ASCII path.*8\.3/);
      return true;
    });
    assert.equal(called, true, "only the runtime, never the credential directory, needs an alias");
  });
}

function assertCleanupFailure(error, parent) {
  assertSanitized(error, parent);
  assert.equal(error.code, "SSH_ASKPASS_CLEANUP_FAILED");
  assert.equal(error.cleanupFailed, true);
  return true;
}

for (const cleanupFails of [false, true]) {
  test(`Windows partial-write rollback ${cleanupFails ? "reports sanitized cleanup failure" : "removes credentials"}`, WINDOWS, async (t) => {
    if (!(await requireTools(t, powershell))) return;
    const parent = await tmpDir(t);
    const originalWrite = fs.writeFile;
    const originalRm = fs.rm;
    const calls = [];
    let secretPath;
    t.mock.method(fs, "writeFile", async (path, data, options) => {
      await originalWrite(path, data, options);
      if (dirname(dirname(path)) === parent) {
        secretPath = path;
        throw Object.assign(new Error("injected write failure"), { code: "EIO" });
      }
    });
    t.mock.method(fs, "rm", async (path, options) => {
      if (dirname(path) !== parent) return originalRm(path, options);
      calls.push(options);
      if (cleanupFails) {
        throw Object.assign(new Error(`${PASSWORD} ${path}`), {
          code: "EPERM", path, stdout: PASSWORD, stderr: PASSWORD,
        });
      }
      return originalRm(path, options);
    });
    activateMocks(t);
    await assert.rejects(createSshAskpass(PASSWORD, { dir: parent }), (error) => {
      if (cleanupFails) return assertCleanupFailure(error, parent);
      assert.equal(error.code, "EIO");
      return true;
    });
    assert.equal(typeof secretPath, "string", "failure must follow the actual credential write");
    assert.deepEqual(calls, [REMOVE_OPTIONS], "Node's removal API receives bounded retry options");
    if (cleanupFails) {
      assert.equal((await readFile(secretPath)).equals(Buffer.from(`${PASSWORD}\n`, "utf8")), true,
        "exhausted cleanup must not claim that remaining credentials were removed");
    } else {
      assert.deepEqual(await readdir(parent), []);
    }
  });
}

test("Windows disposal retries after one rejected removal and remains idempotent", WINDOWS, async (t) => {
  if (!(await requireTools(t, powershell))) return;
  const parent = await tmpDir(t);
  const material = await createSshAskpass(PASSWORD, { dir: parent });
  const directory = dirname(material.env[ASKPASS_SECRET_ENV]);
  const originalRm = fs.rm;
  const calls = [];
  t.mock.method(fs, "rm", async (path, options) => {
    if (path !== directory) return originalRm(path, options);
    calls.push(options);
    if (calls.length === 1) {
      throw Object.assign(new Error(`${PASSWORD} ${directory}`), { code: "EBUSY", path: directory });
    }
    return originalRm(path, options);
  });
  activateMocks(t);
  await assert.rejects(material.dispose(), (error) => assertCleanupFailure(error, parent));
  assert.equal((await stat(directory)).isDirectory(), true);
  await material.dispose();
  await material.dispose();
  assert.deepEqual(calls, [REMOVE_OPTIONS, REMOVE_OPTIONS]);
  await assert.rejects(stat(directory), { code: "ENOENT" });
});
