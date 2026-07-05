import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConfig } from "../models/types.js";
import {
  BUILT_IN_COMMAND_BLACKLIST,
  BUILT_IN_DESTRUCTIVE_GUARDS,
  SSHConnectionManager,
} from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { ToolError, formatToolErrorResponse, toToolError } from "../utils/tool-error.js";

export function formatCommandPolicy(config: SSHConfig): string {
  const whitelist = config.commandWhitelist || [];
  const blacklist = config.commandBlacklist || [];
  const commandMode = config.commandMode
    ?? (whitelist.length > 0 ? "whitelist" : "blacklist");

  let output = `## Command Policy\n\n`;
  output += `Mode: \`${commandMode}\``;
  if (!config.commandMode && whitelist.length > 0) {
    output += ` _(legacy whitelist config)_`;
  }
  output += `\n\n`;

  output += `Built-in destructive command guards:\n\n`;
  for (const { regex, reason } of BUILT_IN_DESTRUCTIVE_GUARDS) {
    output += `- \`${regex.source}\` -> ${reason}\n`;
  }
  output += `\n`;

  output += `Built-in dangerous-command blacklist:\n\n`;
  for (const { regex, reason } of BUILT_IN_COMMAND_BLACKLIST) {
    output += `- \`${regex.source}\` -> ${reason}\n`;
  }
  output += `\n`;

  output += `## Allowed Commands (Whitelist)\n\n`;
  if (commandMode !== "whitelist") {
    output += `Whitelist is inactive in blacklist mode.\n\n`;
  } else if (whitelist.length === 0) {
    output += `WARNING: Whitelist mode is active but no whitelist patterns are configured, so all commands are blocked after blacklist checks.\n\n`;
  } else {
    output += `${whitelist.length} patterns:\n\n`;
    for (const pattern of whitelist) {
      const readable = patternToReadable(pattern);
      output += `- \`${pattern}\``;
      if (readable !== pattern) {
        output += ` -> ${readable}`;
      }
      output += `\n`;
    }
    output += `\n`;
  }

  if (blacklist.length > 0) {
    output += `## Blocked Commands (Blacklist)\n\n`;
    output += `${blacklist.length} patterns:\n\n`;
    for (const pattern of blacklist) {
      const readable = patternToReadable(pattern);
      output += `- \`${pattern}\``;
      if (readable !== pattern) {
        output += ` -> ${readable}`;
      }
      output += `\n`;
    }
    output += `\n`;
  }

  if (commandMode === "whitelist" && whitelist.length > 0) {
    output += `## Example Commands\n\n`;
    output += `Based on the active whitelist, here are some commands you can likely use:\n\n`;
    const examples = generateExamples(whitelist);
    for (const ex of examples.slice(0, 10)) {
      output += `- \`${ex}\`\n`;
    }
    output += `\n`;
  }

  return output;
}

/**
 * Register show-whitelist tool
 * 
 * Allows the LLM to see what commands are allowed for a server.
 */
export function registerShowWhitelistTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.tool(
    "show-whitelist",
    "Show the configured command policy, blacklist/whitelist patterns, and SFTP path policy (allowedRemoteDirectories / allowedLocalDirectories) for a server. Use this before execute-command when you need to understand which commands are allowed, why a command may be rejected, or what command patterns are safe to try next. Also use it before upload / download / transfer to see which paths SFTP is permitted to touch.",
    {
      connectionName: z
        .string()
        .optional()
        .describe("Target server name from list-servers. Required when multiple servers are enabled; optional when only one server is enabled."),
    },
    async ({ connectionName }) => {
      try {
        const resolvedName = sshManager.resolveServer(connectionName);
        const config = sshManager.getServerConfig(resolvedName);
        
        if (!config) {
          const toolError = new ToolError(
            "INVALID_CONFIGURATION",
            `Server '${resolvedName}' not found or not enabled.`,
            false,
          );
          return {
            content: [{
              type: "text",
              text: formatToolErrorResponse(toolError)
            }],
            isError: true,
          };
        }

        let output = `# Command Permissions for: ${config.name}\n\n`;
        output += `Host: ${config.username}@${config.host}:${config.port}\n\n`;
        output += formatCommandPolicy(config);

        // SFTP path policy (upload / download / transfer tools only)
        const allowedRemoteDirs = config.allowedRemoteDirectories ?? [];
        const allowedLocalDirs = config.allowedLocalDirectories ?? [];
        const mcpCwd = process.cwd();

        output += `## 📂 SFTP Path Policy (upload / download / transfer)\n\n`;

        // ----- Remote directories -----
        output += `### Allowed remote directories\n\n`;
        if (allowedRemoteDirs.length === 0) {
          output += `⚠️ **\`allowedRemoteDirectories\` is NOT configured.** ` +
            `SFTP upload/download/transfer is **disabled** for this server — every call will be rejected with \`REMOTE_PATH_NOT_ALLOWED\`. ` +
            `To enable file transfer, add absolute POSIX directories under \`allowedRemoteDirectories\` in the server's YAML config.\n\n`;
        } else {
          output += `${allowedRemoteDirs.length} entr${allowedRemoteDirs.length === 1 ? "y" : "ies"}:\n\n`;
          for (const dir of allowedRemoteDirs) {
            output += `- \`${dir}\`\n`;
          }
          output += `\n`;
        }

        // ----- Local directories -----
        output += `### Allowed local directories\n\n`;
        output += `Always implicitly allowed: \`${mcpCwd}\` _(the MCP working directory)_\n\n`;
        if (allowedLocalDirs.length === 0) {
          output += `⚠️ **\`allowedLocalDirectories\` is NOT configured.** ` +
            `Only paths inside the MCP working directory above can be used as the local side of upload/download — any other path will be rejected with \`LOCAL_PATH_NOT_ALLOWED\`. ` +
            `To allow more locations, add absolute host paths under \`allowedLocalDirectories\` in the server's YAML config.\n\n`;
        } else {
          output += `Additional entries (${allowedLocalDirs.length}):\n\n`;
          for (const dir of allowedLocalDirs) {
            output += `- \`${dir}\`\n`;
          }
          output += `\n`;
        }

        // ----- Matching rules -----
        output += `### Matching rules\n\n`;
        output += `- A path is allowed iff it equals an entry above, or starts with \`<entry> + separator\`.\n`;
        output += `- Remote paths must be absolute POSIX (\`/...\`); \`..\` segments and null bytes are rejected up-front.\n`;
        output += `- Local paths are resolved on the MCP host first, then matched.\n`;
        output += `- These path lists do **not** affect \`execute-command\`. They only restrict SFTP file transfers.\n\n`;

        // ----- Output log policy (execute-command full-output persistence) -----
        const outputLogRoot = sshManager.getOutputLogRoot();
        const serverLogDir = `${outputLogRoot}/${config.name}/${config.username}`.replace(/\\/g, "/");
        output += `## 📝 \`execute-command\` Output Logs\n\n`;
        output += `Every \`execute-command\` call returns at most \`maxOutputBytes\` (default 65536) bytes per stream, tail-only. The FULL stdout/stderr is always persisted to disk:\n\n`;
        output += `- Root: \`${outputLogRoot}\` _(override via the top-level \`outputLogDir:\` field in \`servers.yaml\`)_\n`;
        output += `- This server's logs land under: \`${serverLogDir}/\`\n`;
        output += `- File name: \`<timestamp>-<pid>-<rand>.log\` with \`=== META / STDOUT / STDERR / END ===\` markers.\n`;
        output += `- When output is truncated, the response includes an \`[OUTPUT TRUNCATED]\` header with the on-disk log path.\n\n`;

        return {
          content: [{ type: "text", text: output }],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "INVALID_CONFIGURATION");
        Logger.handleError(toolError, "Failed to show whitelist");
        return {
          content: [{ type: "text", text: formatToolErrorResponse(toolError) }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Convert regex pattern to human-readable description
 */
function patternToReadable(pattern: string): string {
  let readable = pattern;
  
  readable = readable.replace(/^\^/, "").replace(/\$$/, "");
  
  if (readable === "ls( .*)?") return "ls, ls -la, ls /path, etc.";
  if (readable === "cat .*") return "cat <file>";
  if (readable === "pwd") return "pwd (current directory)";
  if (readable === "whoami") return "whoami (current user)";
  if (readable === "hostname") return "hostname";
  if (readable === "date") return "date (current time)";
  if (readable === "docker ps.*") return "docker ps, docker ps -a, etc.";
  if (readable === "docker logs.*") return "docker logs <container>";
  if (readable === "git .*") return "git <any subcommand>";
  if (readable.includes(".*")) return readable.replace(/\.\*/g, "<any>");
  if (readable.includes(".+")) return readable.replace(/\.\+/g, "<required>");
  
  return readable;
}

/**
 * Generate example commands based on whitelist patterns
 */
function generateExamples(whitelist: string[]): string[] {
  const examples: string[] = [];
  
  for (const pattern of whitelist) {
    if (pattern.includes("^ls")) examples.push("ls -la");
    if (pattern.includes("^cat")) examples.push("cat /etc/hostname");
    if (pattern.includes("^pwd")) examples.push("pwd");
    if (pattern.includes("^whoami")) examples.push("whoami");
    if (pattern.includes("^hostname")) examples.push("hostname");
    if (pattern.includes("^date")) examples.push("date");
    if (pattern.includes("^echo")) examples.push("echo 'hello world'");
    if (pattern.includes("^docker ps")) examples.push("docker ps -a");
    if (pattern.includes("^docker logs")) examples.push("docker logs --tail 50 <container>");
    if (pattern.includes("^git")) examples.push("git status");
    if (pattern.includes("^head")) examples.push("head -n 20 <file>");
    if (pattern.includes("^tail")) examples.push("tail -n 50 <file>");
    if (pattern.includes("^grep")) examples.push("grep 'pattern' <file>");
    if (pattern.includes("^find")) examples.push("find . -name '*.log'");
    if (pattern.includes("^df")) examples.push("df -h");
    if (pattern.includes("^du")) examples.push("du -sh *");
    if (pattern.includes("^ps")) examples.push("ps aux");
    if (pattern.includes("^uptime")) examples.push("uptime");
    if (pattern.includes("^free")) examples.push("free -h");
    if (pattern.includes("^curl")) examples.push("curl -s https://example.com");
    if (pattern.includes("systemctl status")) examples.push("systemctl status <service>");
  }
  
  return [...new Set(examples)];
}
