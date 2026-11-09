import { randomUUID } from "node:crypto";
import type { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { ToolError } from "../utils/tool-error.js";
import { shellQuote } from "./catalog.js";

const OUTPUT_LIMIT = 1024 * 1024;
const powershellQuote = (value: string) => "'" + value.replace(/'/g, "''") + "'";

function commandWithResult(argv: string[], env: Record<string, string>, shell: string, marker: string): string {
  if (shell === "powershell") {
    const assignments = Object.entries(env).map(([key, value]) => `$env:${key} = ${powershellQuote(value)};`).join(" ");
    const script = `$ErrorActionPreference = 'Stop';
[Console]::Out.Write("${marker}:stdout\n");
[Console]::Error.Write("${marker}:stderr\n");
$pluginExit = 0;
try { ${assignments} & ${argv.map(powershellQuote).join(" ")}; if ($LASTEXITCODE -is [int]) { $pluginExit = $LASTEXITCODE } }
catch { [Console]::Error.WriteLine($_.ToString()); $pluginExit = 1 }
[Console]::Out.Write("\n${marker}:exit:$pluginExit\n");
exit $pluginExit`;
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  if (shell !== "posix") throw new ToolError("INVALID_CONFIGURATION", `Unknown plugin commandShell: ${shell}`);
  const command = [...(Object.keys(env).length ? ["env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`)] : []), ...argv].map(shellQuote).join(" ");
  // The subshell contains commands that explicitly exit; the parent reports their result.
  return `printf '%s\\n' '${marker}:stdout'; printf '%s\\n' '${marker}:stderr' >&2; (${command}); plugin_exit=$?; printf '\\n%s:%s\\n' '${marker}:exit' "$plugin_exit"; exit "$plugin_exit"`;
}

/** Adapt the public text/streaming interface without extending the SSH manager. */
export async function executePluginSsh(ssh: SSHConnectionManager, alias: string, argv: string[],
  env: Record<string, string>, shell: string, timeout: number, onProgress?: (chunk: string) => void): Promise<string> {
  const marker = `__HANDFREE_PLUGIN_${randomUUID().replaceAll("-", "")}__`;
  const command = commandWithResult(argv, env, shell, marker);
  let pending = "";
  const progress = onProgress ? (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) if (line && !line.includes(marker)) onProgress(line + "\n");
    // Progress is a preview, not an additional unbounded output buffer.
    if (pending.length > 4096) pending = pending.slice(-4096);
  } : undefined;
  const raw = await ssh.executeCommandWithProgress(command, alias, {
    timeout, maxRetries: 0, maxOutputBytes: OUTPUT_LIMIT + 512, onProgress: progress,
  });
  if (pending && !pending.includes(marker)) onProgress?.(pending);

  const stdoutPrefix = `${marker}:stdout\n`;
  const separator = `\n[STDERR]\n${marker}:stderr\n`;
  const boundary = raw.indexOf(separator);
  if (!raw.startsWith(stdoutPrefix) || boundary < 0)
    throw new ToolError("COMMAND_EXECUTION_ERROR", "Plugin output was truncated or ended without a confirmed result", false);
  const stdoutWithResult = raw.slice(stdoutPrefix.length, boundary);
  const result = stdoutWithResult.match(new RegExp(`\n${marker}:exit:(-?\\d+)\n$`));
  if (!result)
    throw new ToolError("COMMAND_EXECUTION_ERROR", "Plugin command ended without a confirmed exit code", false);
  const stdout = stdoutWithResult.slice(0, result.index);
  const exitCode = Number(result[1]);
  let stderr = raw.slice(boundary + separator.length);
  const exitSuffix = `\n[EXIT CODE: ${exitCode}]`;
  if (exitCode !== 0 && stderr.endsWith(exitSuffix)) stderr = stderr.slice(0, -exitSuffix.length);
  if (Buffer.byteLength(stdout) > OUTPUT_LIMIT || Buffer.byteLength(stderr) > OUTPUT_LIMIT)
    throw new ToolError("COMMAND_EXECUTION_ERROR", "Plugin command output was truncated (limit: 1 MiB per stream)", false);
  const output = [stdout.trim() ? stdout : "", stderr.trim() ? `[STDERR]\n${stderr}` : ""].filter(Boolean).join("\n");
  if (exitCode !== 0)
    throw new ToolError("COMMAND_EXECUTION_ERROR", `Command exited with code ${exitCode}\n${output}`, false);
  return output || "(Command completed successfully with no output)";
}
