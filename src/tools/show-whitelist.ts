import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";

/**
 * Register show-whitelist tool
 * 
 * Allows the LLM to see what commands are allowed for a server.
 */
export function registerShowWhitelistTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.tool(
    "show-whitelist",
    "Show allowed command patterns (whitelist) for a server. Use this to understand what commands you can execute.",
    {
      connectionName: z
        .string()
        .optional()
        .describe("SSH connection name (optional, uses defaultServer from config)"),
    },
    async ({ connectionName }) => {
      try {
        const config = sshManager.getServerConfig(connectionName);
        
        if (!config) {
          return {
            content: [{
              type: "text",
              text: `Server '${connectionName || "default"}' not found or not enabled.`
            }],
            isError: true,
          };
        }

        const whitelist = config.commandWhitelist || [];
        const blacklist = config.commandBlacklist || [];
        
        let output = `# Command Permissions for: ${config.name}\n\n`;
        output += `Host: ${config.username}@${config.host}:${config.port}\n\n`;
        
        // Whitelist
        output += `## ✅ Allowed Commands (Whitelist)\n\n`;
        if (whitelist.length === 0) {
          output += `⚠️ No whitelist configured - using default safe commands.\n\n`;
        } else {
          output += `${whitelist.length} patterns:\n\n`;
          for (const pattern of whitelist) {
            // Try to make the regex more human-readable
            const readable = patternToReadable(pattern);
            output += `- \`${pattern}\``;
            if (readable !== pattern) {
              output += ` → ${readable}`;
            }
            output += `\n`;
          }
          output += `\n`;
        }
        
        // Blacklist
        if (blacklist.length > 0) {
          output += `## ❌ Blocked Commands (Blacklist)\n\n`;
          output += `${blacklist.length} patterns:\n\n`;
          for (const pattern of blacklist) {
            const readable = patternToReadable(pattern);
            output += `- \`${pattern}\``;
            if (readable !== pattern) {
              output += ` → ${readable}`;
            }
            output += `\n`;
          }
          output += `\n`;
        }
        
        // Quick examples
        output += `## 💡 Example Commands\n\n`;
        output += `Based on the whitelist, here are some commands you can likely use:\n\n`;
        const examples = generateExamples(whitelist);
        for (const ex of examples.slice(0, 10)) {
          output += `- \`${ex}\`\n`;
        }
        
        return {
          content: [{ type: "text", text: output }],
        };
      } catch (error: unknown) {
        const errorMessage = Logger.handleError(
          error,
          "Failed to show whitelist"
        );
        return {
          content: [{ type: "text", text: errorMessage }],
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
  // Common transformations
  let readable = pattern;
  
  // Remove anchors for display
  readable = readable.replace(/^\^/, "").replace(/\$$/, "");
  
  // Common patterns
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
    // Try to generate a concrete example from the pattern
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
  
  // Remove duplicates
  return [...new Set(examples)];
}
