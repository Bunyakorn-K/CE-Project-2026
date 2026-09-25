import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_SCOPE_HEADER, signMcpScope, type McpScope } from "../analytics/mcp";

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
  listTools(scope?: McpScope): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, scope?: McpScope): Promise<McpCallResult>;
};

export class McpClient implements McpClientLike {
  private readonly sessions = new Map<string, Client>();
  private readonly connecting = new Map<string, Promise<Client>>();

  constructor(
    private readonly url: string,
    private readonly token: string
  ) {}

  private scopeKey(scope: McpScope | undefined): string {
    return scope ? JSON.stringify({ branchIds: [...scope.branchIds].sort(), canViewRevenue: scope.canViewRevenue }) : "default";
  }

  private async ensureConnected(scope?: McpScope): Promise<Client> {
    const key = this.scopeKey(scope);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const pending = this.connecting.get(key);
    if (pending) return pending;
    const connection = this.connect(scope).finally(() => this.connecting.delete(key));
    this.connecting.set(key, connection);
    return connection;
  }

  private async connect(scope?: McpScope): Promise<Client> {
    const signedScope = scope ? signMcpScope(this.token, scope) : undefined;
    const fetchWithScope: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (signedScope) headers.set(MCP_SCOPE_HEADER, signedScope);
      else headers.delete(MCP_SCOPE_HEADER);
      return fetch(input, { ...init, headers });
    };
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { authorization: `Bearer ${this.token}` } },
      fetch: fetchWithScope
    });
    const client = new Client({ name: "laundrytwin-bot", version: "0.1.0" });
    await client.connect(transport);
    this.sessions.set(this.scopeKey(scope), client);
    return client;
  }

  async listTools(scope?: McpScope): Promise<McpToolInfo[]> {
    const client = await this.ensureConnected(scope);
    const result = await client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
  }

  async callTool(name: string, args: Record<string, unknown>, scope?: McpScope): Promise<McpCallResult> {
    const client = await this.ensureConnected(scope);
    const toolArgs = { ...args };
    delete toolArgs.accessScope;
    const result = await client.callTool({ name, arguments: toolArgs });
    return {
      content: result.content as McpCallResult["content"],
      isError: result.isError as boolean | undefined
    };
  }
}
