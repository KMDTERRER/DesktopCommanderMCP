import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { SerenaLaunchProfile } from './serena-launch-profile.js';
import type { ServerResult } from '../types.js';
import { normalizeMcpToolResult } from '../utils/mcp-tool-error.js';

const TOOL_LIST_MAX_PAGES = 16;
const TOOL_LIST_MAX_TOOLS = 512;

export type SerenaToolInfo = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
};

function remainingMs(deadlineAt: number, label: string): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    const error = new Error(`${label} deadline exceeded.`) as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return Math.max(1, remaining);
}

function disconnected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  return code === 'NOT_CONNECTED' || code === 'CONNECTION_CLOSED' || /\b(?:not connected|connection closed)\b/i.test(message);
}

export class SerenaPrivateClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private startingTransport?: StdioClientTransport;
  private startup?: Promise<void>;
  private toolCache?: SerenaToolInfo[];
  private closed = false;
  generation = 0;

  constructor(readonly profile: SerenaLaunchProfile) {}

  async ensureStarted(deadlineAt: number): Promise<void> {
    if (this.closed) throw new Error('Private Serena client is closed.');
    if (this.client && this.transport) return;
    if (this.startup) return this.startup;
    const startup = this.start(deadlineAt);
    this.startup = startup;
    try {
      await startup;
    } finally {
      if (this.startup === startup) this.startup = undefined;
    }
  }

  private async start(deadlineAt: number): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.profile.command,
      args: this.profile.args,
      cwd: this.profile.cwd,
      env: this.profile.env,
      // Serena is a nested implementation detail of the local MCP server. Its
      // logs must not escape through the remote device's owning terminal.
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => undefined);
    const client = new Client({ name: 'desktop-commander-internal-serena', version: '1.0.0' });
    this.startingTransport = transport;
    try {
      await client.connect(transport, { timeout: remainingMs(deadlineAt, 'Serena private stdio startup') });
      if (this.closed) {
        await client.close().catch(() => undefined);
        throw new Error('Private Serena client was closed during startup.');
      }
      this.transport = transport;
      this.client = client;
      this.toolCache = undefined;
      this.generation += 1;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    } finally {
      if (this.startingTransport === transport) this.startingTransport = undefined;
    }
  }

  async listTools(deadlineAt: number, signal?: AbortSignal): Promise<SerenaToolInfo[]> {
    await this.ensureStarted(deadlineAt);
    if (this.toolCache) return this.toolCache;
    const client = this.client!;
    const tools: SerenaToolInfo[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < TOOL_LIST_MAX_PAGES; page++) {
      const timeout = remainingMs(deadlineAt, 'Serena tools/list');
      const options: RequestOptions = { timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: true, ...(signal ? { signal } : {}) };
      const result = await client.listTools(cursor ? { cursor } : undefined, options);
      for (const raw of result.tools ?? []) {
        const tool = raw as SerenaToolInfo;
        if (names.has(tool.name)) throw new Error(`Private Serena returned duplicate tool '${tool.name}'.`);
        names.add(tool.name);
        tools.push(tool);
        if (tools.length > TOOL_LIST_MAX_TOOLS) throw new Error(`Private Serena exceeded ${TOOL_LIST_MAX_TOOLS} tools.`);
      }
      if (!result.nextCursor) {
        this.toolCache = tools;
        return tools;
      }
      if (cursors.has(result.nextCursor)) throw new Error('Private Serena repeated a tools/list pagination cursor.');
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error(`Private Serena exceeded ${TOOL_LIST_MAX_PAGES} tools/list pages.`);
  }

  async callTool(
    tool: string, args: Record<string, unknown>, deadlineAt: number,
    options: { retryReadOnly?: boolean; signal?: AbortSignal } = {},
  ): Promise<ServerResult> {
    const invoke = async () => {
      await this.ensureStarted(deadlineAt);
      const timeout = remainingMs(deadlineAt, `Serena tool ${tool}`);
      const requestOptions: RequestOptions = {
        timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: true,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      return normalizeMcpToolResult(
        await this.client!.callTool({ name: tool, arguments: args }, undefined, requestOptions),
        `Serena result for ${tool}`,
      );
    };
    try {
      return await invoke();
    } catch (error) {
      if (!disconnected(error)) throw error;
      // A workspace release/hibernate is an ownership boundary, not a transient
      // transport failure. A late in-flight read must never reopen its closed
      // Serena child after the binding owner has released it.
      if (this.closed) throw error;
      await this.reset(deadlineAt);
      if (!options.retryReadOnly) throw error;
      return invoke();
    }
  }

  async reset(deadlineAt: number): Promise<void> {
    await this.close(deadlineAt);
    this.closed = false;
    this.toolCache = undefined;
  }

  async close(deadlineAt = Date.now() + 5_000): Promise<void> {
    this.closed = true;
    const client = this.client;
    const transport = this.transport;
    const startingTransport = this.startingTransport;
    this.client = undefined;
    this.transport = undefined;
    this.startingTransport = undefined;
    this.toolCache = undefined;
    if (!client && !transport && !startingTransport) return;
    const closeOwned = Promise.all([
      client?.close().catch(() => undefined),
      transport?.close().catch(() => undefined),
      startingTransport && startingTransport !== transport
        ? startingTransport.close().catch(() => undefined)
        : Promise.resolve(),
    ]).then(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        closeOwned,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(1, deadlineAt - Date.now())); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
