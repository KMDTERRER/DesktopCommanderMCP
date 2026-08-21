import process from 'node:process';

export type McpJsonRpcTraceSummary = {
  kind: 'request' | 'response' | 'notification';
  id?: string;
  method?: string;
  tool?: string;
  outcome?: 'result' | 'error';
};

export function mcpStdioTraceEnabled(): boolean {
  const raw = process.env.DC_MCP_STDIO_TRACE;
  // Protocol diagnostics share the process' stderr with the terminal that owns
  // the remote device. They must therefore be an explicit operator opt-in;
  // remote execution alone is not permission to emit server lifecycle traffic.
  if (raw === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function traceToken(value: unknown, maximum = 120): string {
  const rendered = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?');
  return rendered.length <= maximum ? rendered : `${rendered.slice(0, maximum)}...`;
}

export function traceMcpStdio(
  phase: string, fields: Record<string, unknown> = {}, enabled = mcpStdioTraceEnabled(),
): void {
  if (!enabled) return;
  try {
    const details = Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${traceToken(key, 40)}=${traceToken(value)}`)
      .join(' ');
    process.stderr.write(`[MCP-STDIO] ${traceToken(phase, 48)}${details ? ` ${details}` : ''}\n`);
  } catch {
    // Diagnostics must never become a transport dependency.
  }
}

export function describeMcpJsonRpcFrame(value: unknown): McpJsonRpcTraceSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== '2.0') return null;
  const id = Object.prototype.hasOwnProperty.call(record, 'id') ? traceToken(record.id, 64) : undefined;
  if (typeof record.method === 'string') {
    const params = record.params && typeof record.params === 'object' && !Array.isArray(record.params)
      ? record.params as Record<string, unknown> : undefined;
    const tool = record.method === 'tools/call' && params && typeof params.name === 'string'
      ? traceToken(params.name, 120) : undefined;
    return { kind: id === undefined ? 'notification' : 'request', id, method: traceToken(record.method, 120), tool };
  }
  if (id !== undefined && Object.prototype.hasOwnProperty.call(record, 'result')) {
    return { kind: 'response', id, outcome: 'result' };
  }
  if (id !== undefined && Object.prototype.hasOwnProperty.call(record, 'error')) {
    return { kind: 'response', id, outcome: 'error' };
  }
  return null;
}

export function parseMcpJsonRpcFrame(text: string): McpJsonRpcTraceSummary | null {
  try {
    return describeMcpJsonRpcFrame(JSON.parse(text));
  } catch {
    return null;
  }
}
