/**
 * OpenSSH's askpass seam: how a login password reaches the `ssh` client
 * without ever becoming a command-line argument.
 *
 * The transport deliberately spawns the system `ssh` (see `ssh-transport.ts`),
 * which reads a password from the terminal — and there is no terminal behind
 * that spawn. OpenSSH's own answer is `SSH_ASKPASS`: when it needs a secret it
 * runs the program named by that variable and reads the first line of its
 * stdout. This module builds that program.
 *
 * Two properties matter, and both are structural rather than conventional:
 *
 * - The secret is not an argument and not an environment variable. It lives in
 *   a `0600` file inside a `0700` directory (a verified current-user-only DACL
 *   on Windows), and the helper reads it by path, so a process listing (`ps`)
 *   never shows it and neither does a crash dump of the argv.
 * - The material is created lazily, only when an `ssh` child is about to
 *   authenticate, and deleted again as soon as that child is done with it —
 *   for a forward, that is the moment the port is up. Nothing keeps the file
 *   alive past its use.
 *
 * `SSH_ASKPASS_REQUIRE=force` (OpenSSH 8.4+) is what makes this work without a
 * terminal; `DISPLAY` is set as well because older builds only consult the
 * helper when there is no tty *and* a display to blame.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ErrorCodes } from "@pi-desktop/shared";
import {
  protectWindowsAskpassDirectory,
  windowsAskpassCommand,
} from "./ssh-askpass-windows.js";

/** Environment variable naming the file the helper reads the secret from. */
export const ASKPASS_SECRET_ENV = "PI_SSH_ASKPASS_SECRET";

/**
 * The helper. `$1` is OpenSSH's prompt text and is deliberately ignored: the
 * same secret answers "user@host's password:" and a key passphrase prompt, and
 * an encrypted key whose passphrase is not this password simply falls through
 * to password authentication. The trailing `echo` terminates the line OpenSSH
 * reads, so a secret without a trailing newline is still returned whole.
 */
export const ASKPASS_HELPER_SCRIPT = `#!/bin/sh
# Written by the desktop app; do not edit. Reads the secret from a 0600 file
# so it never appears in the process list.
cat "\${${ASKPASS_SECRET_ENV}}"
echo
`;

/**
 * A cap, so a paste of something enormous fails as a validation error instead
 * of as a mysterious authentication failure.
 */
const MAX_PASSWORD_LENGTH = 4096;

function fail(message: string, errorCode: string, data?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { errorCode, ...(data ?? {}) });
}

async function removeCredentialDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // File-system errors can include credential paths; retain only a stable,
    // actionable cleanup diagnosis, not the raw error or a child-process cause.
    throw fail(
      "Could not remove temporary SSH password material. Close processes holding temporary files " +
        "and retry cleanup; protected credential files may remain until cleanup succeeds.",
      ErrorCodes.HOST_BOOTSTRAP_FAILED,
      { code: "SSH_ASKPASS_CLEANUP_FAILED", cleanupFailed: true },
    );
  }
}

/** Validate a supplied login password; returns it unchanged. */
export function assertSshPassword(value: unknown, field = "password"): string {
  if (typeof value !== "string") {
    throw fail(`${field} must be a string`, ErrorCodes.INVALID_ARGUMENT, { field });
  }
  if (value.length === 0) {
    throw fail(`${field} must not be empty`, ErrorCodes.INVALID_ARGUMENT, { field });
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    throw fail(`${field} must be at most ${MAX_PASSWORD_LENGTH} characters`, ErrorCodes.INVALID_ARGUMENT, {
      field,
    });
  }
  if (/[\r\n]/.test(value)) {
    // Not a style rule: `ssh` reads the askpass answer up to the first line
    // break, so anything after one would be silently dropped.
    throw fail(`${field} must not contain a line break`, ErrorCodes.INVALID_ARGUMENT, { field });
  }
  if (value.includes("\0")) {
    // OpenSSH consumes a C string; an embedded NUL would silently truncate it.
    throw fail(`${field} must not contain a NUL character`, ErrorCodes.INVALID_ARGUMENT, { field });
  }
  return value;
}

/** On-disk credential material handed to one `ssh` child at a time. */
export type SshAskpassMaterial = {
  /** Variables to merge over `process.env` for the `ssh` spawn. */
  env: NodeJS.ProcessEnv;
  /** Delete the secret and the helper. Idempotent. */
  dispose(): Promise<void>;
};

export type SshAskpassOptions = {
  /** Parent directory for the throwaway folder; defaults to the OS temp dir. */
  dir?: string;
  /** Injected for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Internal test seam; production always applies and verifies the native ACL. */
  protectWindowsDirectory?: (directory: string) => Promise<void>;
};

/** Write a platform-native helper and its secret into a private throwaway directory. */
export async function createSshAskpass(
  secret: unknown,
  options: SshAskpassOptions = {},
): Promise<SshAskpassMaterial> {
  const password = assertSshPassword(secret);
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const parent = options.dir ?? tmpdir();
  const dir = await mkdtemp(join(windows ? resolve(parent) : parent, "pi-ssh-askpass-"));
  const secretPath = join(dir, "secret");
  const helperPath = join(dir, "askpass.sh");
  let executable = helperPath;
  try {
    if (windows) {
      // `mode`/chmod do not protect Windows credentials. Verify the DACL while
      // the directory is still empty, and fail closed before writing a secret.
      await (options.protectWindowsDirectory ?? protectWindowsAskpassDirectory)(dir);
    } else {
      // `mkdtemp` creates 0700; make the POSIX confidentiality boundary explicit.
      await chmod(dir, 0o700);
    }
    await writeFile(secretPath, windows ? `${password}\n` : password, { mode: 0o600, flag: "wx" });
    if (windows) {
      executable = await windowsAskpassCommand();
    } else {
      await writeFile(helperPath, ASKPASS_HELPER_SCRIPT, { mode: 0o700, flag: "wx" });
    }
  } catch (error) {
    // A half-written credential is still a credential; do not leave it behind.
    await removeCredentialDirectory(dir);
    throw error;
  }
  let disposal: Promise<void> | undefined;
  return {
    env: {
      SSH_ASKPASS: executable,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env.DISPLAY ?? ":0",
      [ASKPASS_SECRET_ENV]: secretPath,
      ...(windows ? { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "", NODE_PATH: "" } : {}),
    },
    async dispose() {
      disposal ??= removeCredentialDirectory(dir).catch((error: unknown) => {
        disposal = undefined;
        throw error;
      });
      await disposal;
    },
  };
}
