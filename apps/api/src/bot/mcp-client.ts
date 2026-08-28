import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The bot is an MCP *client*: the LLM's tool calls are routed to the MCP data
// server over Streamable HTTP, keeping the allow-listed query surface as the
// single data interface for every AI consumer.

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: { type: "object"; properties?: Record<string, object>; required?: string[] };
};

export type McpCallResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

export type McpClientLike = {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
};

export class McpClient implements McpClientLike {
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string
  ) {}

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
    if (!this.client) throw new Error("MCP client failed to connect");
    return this.client;
  }

  private async connect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { authorization: `Bearer ${this.token}` } }
    });
    const client = new Client({ name: "laundrytwin-bot", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const client = await this.ensureConnected();
    const result = await client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const client = await this.ensureConnected();
    const result = await client.callTool({ name, arguments: args });
    return {
      content: result.content as McpCallResult["content"],
      isError: result.isError as boolean | undefined
    };
  }
}
