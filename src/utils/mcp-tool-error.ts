import type { ServerResult } from '../types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const RAW_PROXY_ERROR_TOOLS = new Set(['mcp_list_tools', 'mcp_call_tool']);

function assertJsonSafe(value: unknown, label: string): void {
    const pending: Array<{ value: unknown; path: string }> = [{ value, path: label }];
    const ancestors = new WeakSet<object>();

    while (pending.length > 0) {
        const current = pending.pop()!;
        if (current.path === '') {
            ancestors.delete(current.value as object);
            continue;
        }
        const item = current.value;
        // JSON.stringify omits undefined object properties (and encodes an
        // undefined array slot as null). Existing Desktop Commander structured
        // results intentionally rely on the former behavior for unset config
        // values, so it is part of the actual upstream wire contract.
        if (item === undefined || item === null || typeof item === 'string' || typeof item === 'boolean') continue;
        if (typeof item === 'number') {
            if (!Number.isFinite(item)) throw new Error(`${current.path} contains a non-finite number.`);
            continue;
        }
        if (typeof item !== 'object') {
            throw new Error(`${current.path} contains a value that JSON cannot encode.`);
        }
        if (!Array.isArray(item)) {
            const prototype = Object.getPrototypeOf(item);
            if (prototype !== Object.prototype && prototype !== null) {
                throw new Error(`${current.path} contains a non-JSON object.`);
            }
        }
        if (ancestors.has(item)) throw new Error(`${current.path} contains a circular reference.`);
        ancestors.add(item);
        pending.push({ value: item, path: '' });
        const entries = Array.isArray(item)
            ? item.map((entry, index) => [String(index), entry] as const)
            : Object.entries(item as Record<string, unknown>);
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const [key, entry] = entries[index];
            pending.push({ value: entry, path: `${current.path}.${key}` });
        }
    }
}

/**
 * Validate and stabilize the runtime CallToolResult before the MCP SDK's own
 * response wrapper sees it. Without this boundary, a handler returning `[]`,
 * null, or malformed content is converted by the SDK into a protocol-level
 * "Invalid tools/call result" error instead of the tool's native isError form.
 */
export function normalizeMcpToolResult(value: unknown, label = 'Tool result'): ServerResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} is not an MCP CallToolResult object.`);
    }
    if (!Object.prototype.hasOwnProperty.call(value, 'content') || !Array.isArray((value as { content?: unknown }).content)) {
        throw new Error(`${label} does not contain an MCP content array.`);
    }
    const parsed = CallToolResultSchema.safeParse(value);
    if (!parsed.success) throw new Error(`${label} has an invalid MCP CallToolResult shape.`);
    assertJsonSafe(parsed.data, label);
    return parsed.data as ServerResult;
}

function toolErrorMessage(error: unknown): string {
    try {
        const message = error instanceof Error && typeof error.message === 'string'
            ? error.message
            : String(error);
        // The SDK prefixes rejected protocol promises with e.g.
        // "MCP error -32000". That implementation detail is precisely the
        // out-of-contract server-error channel this adapter is containing; do
        // not reproduce it inside the native tool result.
        return message
            .replace(/^MCP error -?\d+:\s*/iu, '')
            .replace(/^Error:\s*/iu, '') || 'Tool call failed';
    } catch {
        return 'Unknown tool error';
    }
}

/**
 * Preserve the native MCP CallToolResult error contract at every registered
 * tool boundary. Once a tool call has been accepted for dispatch, failures
 * must be data in the tool result rather than a JSON-RPC/MCP server error.
 */
export function createMcpToolErrorResult(error: unknown, requestedToolName?: string): ServerResult {
    const message = toolErrorMessage(error);
    const text = requestedToolName && RAW_PROXY_ERROR_TOOLS.has(requestedToolName)
        ? message
        : `Error: ${message}`;
    return {
        content: [{ type: 'text', text }],
        isError: true,
    };
}

/**
 * A downstream MCP tool owns its result only on the direct mcp_call_tool
 * surface. When it is tunneled through a frozen read_file/write_file schema,
 * normalize an error back to that wrapper's original single-text form.
 */
export function normalizeFrozenWrapperResult(
    wrapperName: 'read_file' | 'write_file',
    result: ServerResult,
): ServerResult {
    if (result.isError !== true) return result;
    const message = result.content
        .filter((item) => item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('\n')
        .trim() || `${wrapperName} downstream tool failed`;
    return createMcpToolErrorResult(message, wrapperName);
}
