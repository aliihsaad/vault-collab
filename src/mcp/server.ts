#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createVaultCollabMcpTools,
  type CreateVaultCollabMcpToolsOptions,
  type VaultCollabMcpTools
} from "./tools.js";

export interface VaultCollabMcpServerHandle {
  server: McpServer;
  tools: VaultCollabMcpTools;
  close: () => Promise<void>;
}

export function createVaultCollabMcpServer(
  options: CreateVaultCollabMcpToolsOptions
): VaultCollabMcpServerHandle {
  const tools = createVaultCollabMcpTools(options);
  const server = new McpServer({
    name: "vault-collab",
    version: "0.1.0"
  });

  for (const definition of tools.definitions) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: {
          destructiveHint: false,
          openWorldHint: false
        }
      },
      async (args) => tools.callTool(definition.name, args)
    );
  }

  return {
    server,
    tools,
    close: async () => {
      await server.close();
      tools.close();
    }
  };
}

export async function startVaultCollabStdioServer(dbPath: string): Promise<VaultCollabMcpServerHandle> {
  const handle = createVaultCollabMcpServer({ dbPath });
  const transport = new StdioServerTransport();
  await handle.server.connect(transport);
  return handle;
}

function parseDbPath(argv: string[], env: NodeJS.ProcessEnv): string {
  const dbFlagIndex = argv.indexOf("--db");
  if (dbFlagIndex !== -1) {
    const value = argv[dbFlagIndex + 1];
    if (!value) {
      throw new Error("--db requires a path");
    }
    return value;
  }

  if (env.VAULT_COLLAB_DB) {
    return env.VAULT_COLLAB_DB;
  }

  throw new Error("Missing database path. Use --db <path> or VAULT_COLLAB_DB.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await startVaultCollabStdioServer(parseDbPath(process.argv.slice(2), process.env));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
