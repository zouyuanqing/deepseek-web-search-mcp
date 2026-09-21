import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createMcpServer } from "../src/tools.js";

const EXPECTED_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

async function listToolSurface() {
  const server = createMcpServer(loadConfig({}));
  const client = new Client({ name: "tools-test", version: "1.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("tool surface", () => {
  it("exposes web_search and web_research", async () => {
    const tools = await listToolSurface();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["web_research", "web_search"]);
  });

  it("declares all four annotations on web_search and web_research", async () => {
    const tools = await listToolSurface();
    for (const name of ["web_search", "web_research"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations, name).toEqual(EXPECTED_ANNOTATIONS);
    }
  });
});
