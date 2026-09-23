/** Windows askpass bytes and the ACL boundary that must precede credential writes. */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { win32 } from "node:path";
import { ErrorCodes } from "@pi-desktop/shared";

// OpenSSH launches this through the existing Node/Electron executable, not a
// command interpreter. The constant code ignores prompt arguments after `--`;
// credential bytes and their Unicode path never enter executable code or argv.
export const WINDOWS_ASKPASS_CODE =
  "try{process.stdout.write(require('node:fs').readFileSync(process.env.PI_SSH_ASKPASS_SECRET));}" +
  "catch{process.exitCode=1;}";

const ASKPASS_DIR_ENV = "PI_SSH_ASKPASS_DIR";

// Paths travel only through the environment; identities come from the current
// token, not localized account names. Read back the effective DACL, since chmod
// and a successful ACL write alone do not prove confidentiality on Windows.
const PROTECT_DIRECTORY_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $directory = [System.IO.DirectoryInfo]::new($env:PI_SSH_ASKPASS_DIR)
  if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $none = [System.Security.AccessControl.PropagationFlags]::None
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid, $fullControl, $inheritance, $none, $allow))
  $directory.SetAccessControl($acl)
  $actual = $directory.GetAccessControl()
  $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (-not $actual.AreAccessRulesProtected -or
      $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
      $rules.Count -ne 1) { exit 1 }
  $rule = $rules[0]
  if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.IsInherited -or
      $rule.AccessControlType -ne $allow -or $rule.FileSystemRights -ne $fullControl -or
      $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne $none) { exit 1 }
  exit 0
} catch {
  exit 1
}
`;

function protectionFailure(): Error {
  // Do not forward child-process errors: they include argv, output and paths.
  return Object.assign(
    new Error(
      "Could not secure the Windows SSH password directory. Ensure Windows PowerShell is available " +
        "and the temporary directory supports current-user-only NTFS permissions.",
    ),
    { errorCode: ErrorCodes.HOST_BOOTSTRAP_FAILED, platform: "win32" },
  );
}

async function runPowerShell(script: string, pathEnv: NodeJS.ProcessEnv): Promise<string> {
  // Same well-known SystemRoot location as host-core's Windows shell resolver;
  // deliberately no PATH fallback for this security-sensitive operation.
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw protectionFailure();
  const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise<string>((resolve, reject) => {
    execFile(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: { SystemRoot: systemRoot, ...pathEnv },
        windowsHide: true,
        timeout: 8_000,
        maxBuffer: 16 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** Restrict and verify an empty directory before any credential is written. */
export async function protectWindowsAskpassDirectory(directory: string): Promise<void> {
  try {
    await runPowerShell(PROTECT_DIRECTORY_SCRIPT, { [ASKPASS_DIR_ENV]: directory });
  } catch {
    throw protectionFailure();
  }
}

const SHORT_PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $file = (New-Object -ComObject Scripting.FileSystemObject).GetFile($env:PI_SSH_ASKPASS_HELPER)
  [Console]::Write($file.ShortPath)
  exit 0
} catch {
  exit 1
}
`;

/** Windows OpenSSH 9.5 cannot launch Unicode executable paths. Verify an ASCII
 * alias for the existing runtime; credential paths remain untouched. */
async function windowsAskpassExecutable(helper: string): Promise<string> {
  const needsAlias = /[^\x20-\x7e]|[%!^&()]/;
  if (!needsAlias.test(helper)) return helper;
  try {
    const short = await runPowerShell(SHORT_PATH_SCRIPT, { PI_SSH_ASKPASS_HELPER: helper });
    if (!win32.isAbsolute(short) || needsAlias.test(short)) throw new Error("unusable alias");
    const [original, alias] = await Promise.all([realpath(helper), realpath(short)]);
    if (original !== alias) throw new Error("different file");
    return short;
  } catch {
    throw Object.assign(
      new Error(
        "Windows OpenSSH could not use the application executable for password authentication. " +
          "Install the application in an ASCII path or enable Windows 8.3 short names on its volume.",
      ),
      { errorCode: ErrorCodes.HOST_BOOTSTRAP_FAILED, platform: "win32" },
    );
  }
}

/** Windows OpenSSH supports executable plus fixed arguments in SSH_ASKPASS. */
export async function windowsAskpassCommand(executable = process.execPath): Promise<string> {
  const runtime = await windowsAskpassExecutable(executable);
  return `"${runtime}" --input-type=commonjs -e "${WINDOWS_ASKPASS_CODE}" --`;
}
