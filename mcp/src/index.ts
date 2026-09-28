#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { STRIKE_SDK_VERSION, strikeChains } from "@strike/sdk";

const server = new McpServer({ name: "strike", version: "0.1.0" });

server.registerTool(
  "strike_info",
  {
    title: "Strike protocol info",
    description: "Describe Strike and list the chains it supports.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          protocol: "Strike",
          sdkVersion: STRIKE_SDK_VERSION,
          chains: Object.values(strikeChains).map((c) => ({ id: c.id, name: c.name })),
        }),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
