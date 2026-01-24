#!/usr/bin/env node

import { SshMcpServer } from "./core/mcp-server.js";
import { Logger } from "./utils/logger.js";

/**
 * Main program entry
 */
async function main(): Promise<void> {
  const sshMcpServer = new SshMcpServer();
  await sshMcpServer.run();
}

main().catch((error) => Logger.handleError(error, "【SSH MCP Server Error】", true));
