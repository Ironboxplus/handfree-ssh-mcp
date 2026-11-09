import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PluginHost } from "../plugins/host.js";
import { rejectUnknownArguments } from "./strict-arguments.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";

const target = {
  plugin: z.string().describe("Plugin id from plugin-list"),
  component: z.string().optional().describe("Required when the plugin has multiple components"),
  connectionName: z.string().optional().describe("Existing SSH connection alias; same selection as execute-command. Omit for local components."),
};
const reply = async (operation: () => unknown) => {
  try { return {content: [{type: "text" as const, text: JSON.stringify(await operation())}]}; }
  catch (error) { return {content: [{type: "text" as const, text: formatToolErrorResponse(toToolError(error, "COMMAND_EXECUTION_ERROR"))}], isError: true}; }
};

export function registerPluginTools(server: McpServer): void {
  const host = new PluginHost();
  rejectUnknownArguments(server.tool("plugin-list", "Discover enabled plugins, components, installation targets, sources and setup instructions before installation. Read component setup: ask for user-specific directories and initialization choices unless supplied or explicitly delegated. Does not install anything or open SSH connections.", {},
    async () => reply(() => host.catalog.read().map(({manifest}) => manifest))));
  rejectUnknownArguments(server.tool("plugin-activate", "Check the installed version and current skill catalog, using read-only discovery when supported. Missing local registration or PATH is not proof the remote package is absent: confirm existing user-level root and runtime before installing. Discovery-enabled install reuses an existing package; explicit update runs maintenance. First read plugin-list setup and resolve user-specific choices unless delegated. Review workloads; Web update stops and restarts an already running local Web and reports verified version/network diagnostics. Installation is not initialization. Does not start schedulers.",
    {...target, mode: z.enum(["check", "install", "update"]).default("check"),
      timeout: z.number().int().min(1000).max(1800000).optional().describe("Installer timeout in milliseconds (default 300000, maximum 1800000). Set the client request timeout accordingly for slow dependencies.")},
    async ({mode, timeout, ...selection}, extra) => {
      let progress = 0;
      const token = extra._meta?.progressToken;
      const report = token === undefined ? undefined : (message: string) => {
        void server.server.notification({method: "notifications/progress", params: {
          progressToken: token, progress: ++progress, message: message.slice(-500),
        }}).catch(() => {});
      };
      return reply(() => host.activate(selection, mode, timeout, report));
    }));
  rejectUnknownArguments(server.tool("plugin-skill", "Read a skill from the installed plugin. Omit name for its catalog. Fetch again after updating the plugin. This returns instructions; it does not install a global client skill.",
    {...target, name: z.string().min(1).optional()},
    async ({name, ...selection}) => reply(() => host.skill(selection, name))));
  rejectUnknownArguments(server.tool("plugin-run", "Invoke a plugin CLI with an argv array, using its configured entry point and settings. Read plugin-skill first. SSH components use the selected SSH connection and its existing command policy. Transfer files with the existing SFTP tools; all supplied paths belong to the component host.",
    {...target, args: z.array(z.string().refine(s => !s.includes("\0"))).max(256), timeout: z.number().int().min(1000).max(1800000).optional().describe("Command timeout in milliseconds (default 30000, up to 1800000 for explicit long setup operations). Match the client request timeout.")},
    async ({args, timeout, ...selection}) => reply(() => host.run(selection, args, timeout))));
}
