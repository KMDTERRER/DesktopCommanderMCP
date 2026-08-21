import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { captureRemote } from '../utils/capture.js';
import { normalizeMcpArgumentsObject } from '../utils/mcp-arguments.js';
import { describeMcpJsonRpcFrame, traceMcpStdio } from '../utils/mcp-stdio-trace.js';
import { createMcpToolErrorResult, normalizeMcpToolResult } from '../utils/mcp-tool-error.js';
import {
    PROCESS_CLIENT_RESPONSE_RESERVE_MS, PROCESS_CLIENT_TIMEOUT_MAX_MS,
    PROCESS_TRANSPORT_RESERVE_MS, processToolWaitMs,
} from '../utils/process-wait-contract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Server startup owns bounded configuration I/O before server.connect(). Two
// consecutive 10s startup I/O phases are valid under that contract, so the
// parent handshake deadline must leave headroom instead of killing a healthy
// child at the old 15s boundary.
export const LOCAL_MCP_CONNECT_TIMEOUT_MS = 30_000;
const COMMAND_DISCOVERY_TIMEOUT_MS = 3_000;
const LOCAL_MCP_CLOSE_TIMEOUT_MS = 3_500;
const LOCAL_MCP_TRANSPORT_FALLBACK_TIMEOUT_MS = 500;
const LOCAL_MCP_FORCE_KILL_WAIT_MS = 500;

type LocalProcessRequest = { tool: string; args: Record<string, unknown>; transportTimeoutMs?: number };
type LocalMcpCapabilities = { tools: any[]; instructions?: string };

function parseCompatProcessRequest(toolName: string, args: Record<string, unknown>): LocalProcessRequest | null {
    if (toolName !== 'read_file' && toolName !== 'write_file') return null;
    const rawPath = args.path;
    if (typeof rawPath !== 'string' || !rawPath.toLowerCase().startsWith('mcp://')) return null;
    let url: URL;
    try { url = new URL(rawPath); } catch { return null; }
    const server = url.hostname;
    const tool = url.pathname.split('/').filter(Boolean)[0] ?? '';
    const local = (server === 'desktop-core' && (tool === 'start_process' || tool === 'read_process_output' || tool === 'interact_with_process')) ||
        (server === 'desktop-accelerators' && (tool === 'wait_process' || tool === 'cpp_build_execute'));
    if (!local) return null;
    let downstream: Record<string, unknown> = {};
    try {
        if (toolName === 'read_file') downstream = normalizeMcpArgumentsObject(args.options, 'Remote MCP read options');
        else downstream = normalizeMcpArgumentsObject(JSON.parse(String(args.content ?? '{}')), 'Remote MCP compatibility payload');
    } catch { return null; }
    const rawTimeout = url.searchParams.get('timeout_ms');
    const transportTimeoutMs = rawTimeout && /^\d+$/.test(rawTimeout) ? Number(rawTimeout) : undefined;
    return { tool, args: downstream, transportTimeoutMs };
}

function localProcessRequest(toolName: string, args: Record<string, unknown>): LocalProcessRequest | null {
    if (toolName === 'start_process' || toolName === 'read_process_output' || toolName === 'interact_with_process') {
        return { tool: toolName, args };
    }
    if (toolName === 'mcp_call_tool') {
        const server = args.server;
        const tool = args.tool;
        if ((server === 'desktop-core' && (tool === 'start_process' || tool === 'read_process_output' || tool === 'interact_with_process')) ||
            (server === 'desktop-accelerators' && (tool === 'wait_process' || tool === 'cpp_build_execute'))) {
            return {
                tool: String(tool),
                args: normalizeMcpArgumentsObject(args.arguments, 'Remote mcp_call_tool.arguments'),
                transportTimeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
            };
        }
    }
    return parseCompatProcessRequest(toolName, args);
}

export function localMcpRequestTimeoutMs(toolName: string, args: Record<string, unknown>): number | undefined {
    const target = localProcessRequest(toolName, args);
    if (!target) return undefined;
    const waitMs = processToolWaitMs(target.tool, target.args);
    if (waitMs === null) return undefined;
    const bridgeBudget = Math.max(waitMs + PROCESS_TRANSPORT_RESERVE_MS, target.transportTimeoutMs ?? 0);
    return Math.min(PROCESS_CLIENT_TIMEOUT_MAX_MS, bridgeBudget + PROCESS_CLIENT_RESPONSE_RESERVE_MS);
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, name: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function processExists(pid: number | null): boolean {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function forceTerminateProcess(pid: number | null): Promise<boolean> {
    if (!processExists(pid)) return true;
    try {
        process.kill(pid!, 'SIGKILL');
    } catch {
        return !processExists(pid);
    }
    const deadline = Date.now() + LOCAL_MCP_FORCE_KILL_WAIT_MS;
    while (Date.now() < deadline) {
        if (!processExists(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return !processExists(pid);
}

interface McpConfig {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
}

const LOCAL_MCP_INHERITED_ENV_VARS = [
    'DESKTOP_COMMANDER_MCP_CONFIG',
    'DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY',
    'DESKTOP_COMMANDER_SERENA_PROJECT',
    'DESKTOP_COMMANDER_SERENA_HOME',
    'DESKTOP_COMMANDER_SERENA_PROJECT_DATA_ROOT',
    'DESKTOP_COMMANDER_SERENA_UV_CACHE_DIR',
    'DESKTOP_COMMANDER_SERENA_UV_PROJECT_ENVIRONMENT',
    'DESKTOP_COMMANDER_SERENA_PYTHONPYCACHEPREFIX',
    'DESKTOP_COMMANDER_SERENA_UV_COMMAND',
    'DESKTOP_COMMANDER_SERENA_CPP_PROFILE_JSON',
    'RUFF_BIN',
    'RUFF_BIN_ARGS',
    'AST_GREP_BIN',
    'DESKTOP_COMMANDER_DISABLE_TELEMETRY',
    'DC_MCP_STDIO_TRACE',
] as const;

export function buildLocalMcpChildEnvironment(configEnv?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = { ...getDefaultEnvironment() };
    for (const name of LOCAL_MCP_INHERITED_ENV_VARS) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
    }
    Object.assign(env, configEnv);
    env.DC_REMOTE_DEVICE = 'true';
    // The remote-device process already owns remote lifecycle/error telemetry.
    // Its spawned local MCP child must not emit a second HTTPS analytics request
    // for every tool call; that traffic competes with the result channel without
    // adding an independent operational signal. Keep the kill-switch scoped to
    // this child so parent captureRemote diagnostics remain available.
    const telemetryKillSwitch = env.DESKTOP_COMMANDER_DISABLE_TELEMETRY?.trim().toLowerCase();
    if (!telemetryKillSwitch || !['1', 'true', 'yes', 'on'].includes(telemetryKillSwitch)) {
        env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';
    }
    return env;
}

export class DesktopCommanderIntegration {
    private mcpClient: Client | null = null;
    private mcpTransport: StdioClientTransport | null = null;
    private isReady: boolean = false;
    private isShuttingDown = false;
    private disconnectHandler: ((reason: string) => void) | null = null;
    private reinitPromise: Promise<void> | null = null;
    private transportGeneration = 0;
    private toolsChangedHandler: (() => void | Promise<void>) | null = null;
    private lastKnownCapabilities: LocalMcpCapabilities | null = null;
    private capabilityDiscoveryTail: Promise<void> = Promise.resolve();

    get ready(): boolean { return this.isReady && this.mcpClient !== null && this.mcpTransport !== null; }

    onDisconnect(handler: ((reason: string) => void) | null): void { this.disconnectHandler = handler; }

    private handleLocalDisconnect(reason: string, generation: number, transport: StdioClientTransport): void {
        if (this.isShuttingDown || generation !== this.transportGeneration || this.mcpTransport !== transport) return;
        const wasReady = this.isReady;
        this.isReady = false;
        this.mcpClient = null;
        this.mcpTransport = null;
        if (!wasReady) return;
        console.error(` - ❌ Local Desktop Commander MCP disconnected (${reason})`);
        void captureRemote('desktop_integration_local_disconnected', { reason });
        this.disconnectHandler?.(reason);
    }

    async ensureReady(): Promise<void> {
        if (this.ready) return;
        if (this.isShuttingDown) throw new Error('Desktop Commander integration is shutting down');
        if (!this.reinitPromise) {
            this.reinitPromise = this.initialize().finally(() => { this.reinitPromise = null; });
        }
        await this.reinitPromise;
    }

    async initialize() {
        if (this.ready) return;
        console.debug('[DEBUG] DesktopCommanderIntegration.initialize() called');
        const config = await this.resolveMcpConfig();

        if (!config) {
            console.debug('[DEBUG] No MCP config found');
            throw new Error('Desktop Commander MCP not found. Please install it globally via `npm install -g @wonderwhy-er/desktop-commander` or build the local project.');
        }

        console.log(` - ⏳ Connecting to Local Desktop Commander MCP using: ${config.command} ${config.args.join(' ')}`);
        console.debug('[DEBUG] MCP config:', JSON.stringify({
            command: config.command,
            args: config.args,
            ...(config.cwd ? { cwd: config.cwd } : {}),
            envKeys: Object.keys(config.env ?? {}).sort(),
        }, null, 2));

        try {
            console.debug('[DEBUG] Creating StdioClientTransport');
            // The MCP SDK intentionally spawns stdio servers with a minimal
            // environment. Forward only the small set of Desktop Commander
            // runtime controls that the local child actually consumes; never
            // leak the foreground process environment wholesale.
            const childEnv = buildLocalMcpChildEnvironment(config.env);
            const traceLocalFrames = ['1', 'true', 'yes', 'on'].includes(
                (childEnv.DC_MCP_STDIO_TRACE ?? '').trim().toLowerCase(),
            );
            const transport = new StdioClientTransport({
                ...config,
                env: childEnv,
                // Never let nested server diagnostics inherit an arbitrary VS
                // Code/host terminal. The pipe is deliberately drained below;
                // frame summaries remain available through explicit tracing.
                stderr: 'pipe',
            });
            transport.stderr?.on('data', () => undefined);
            const generation = ++this.transportGeneration;
            this.mcpTransport = transport;
            transport.onmessage = (message) => {
                const frame = describeMcpJsonRpcFrame(message);
                if (frame?.kind === 'response') {
                    traceMcpStdio('CLIENT_RECV', { generation, ...frame }, traceLocalFrames);
                }
            };
            // Install before connect(): the MCP SDK chains handlers already present
            // when it attaches its own close/error handling for in-flight calls.
            transport.onclose = () => this.handleLocalDisconnect('stdio transport closed', generation, transport);
            transport.onerror = (error: Error) => this.handleLocalDisconnect(`stdio transport error: ${error?.message ?? String(error)}`, generation, transport);

            // Create MCP client
            console.debug('[DEBUG] Creating MCP Client');
            this.mcpClient = new Client(
                {
                    name: "desktop-commander-client",
                    version: "1.0.0"
                },
                {
                    capabilities: {}
                }
            );

            this.mcpClient.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
                console.debug('[DEBUG] MCP tools/list_changed notification received');
                try {
                    await this.toolsChangedHandler?.();
                } catch (error) {
                    console.error('[DEBUG] tools/list_changed handler failed:', error);
                    await captureRemote('desktop_integration_tools_changed_failed', { error });
                }
            });

            // Connect to Desktop Commander under a bounded handshake. If the child
            // starts but never speaks MCP, Remote startup must still recover.
            console.debug('[DEBUG] Connecting MCP client to transport');
            await withDeadline(
                this.mcpClient.connect(transport),
                LOCAL_MCP_CONNECT_TIMEOUT_MS,
                'Local MCP connect'
            );
            this.isReady = true;

            console.log(' - 🔌 Connected to Desktop Commander MCP');
            console.debug('[DEBUG] Desktop Commander MCP connection successful');

        } catch (error) {
            console.error('Failed to connect to Desktop Commander MCP:', error);
            console.debug('[DEBUG] MCP connection error:', error);
            this.isReady = false;
            if (this.mcpTransport) {
                try {
                    await withDeadline(
                        this.mcpTransport.close(),
                        LOCAL_MCP_CLOSE_TIMEOUT_MS,
                        'Local MCP transport cleanup'
                    );
                } catch (cleanupError) {
                    console.debug('[DEBUG] MCP transport cleanup failed:', cleanupError);
                }
            }
            this.mcpClient = null;
            this.mcpTransport = null;
            await captureRemote('desktop_integration_init_failed', { error });
            throw error;
        }
    }

    async resolveMcpConfig(): Promise<McpConfig | null> {
        console.debug('[DEBUG] Resolving MCP config...');
        // Option 1: Development/Local Build
        // Adjusting path resolution since we are now in src/remote-device and dist is in root/dist
        // Original: path.resolve(__dirname, '../../dist/index.js')
        const devPath = path.resolve(__dirname, '../../dist/index.js');
        console.debug('[DEBUG] Checking local dev path:', devPath);
        try {
            await fs.access(devPath);
            console.debug(' - 🔍 Found local MCP server at:', devPath);
            return {
                command: process.execPath, // Use the current node executable
                args: [devPath],
                cwd: path.dirname(devPath)
            };
        } catch {
            console.debug('[DEBUG] Local dev path not found, trying global installation');
            // Local file not found, continue...
        }

        // Option 2: Global Installation
        const commandName = 'desktop-commander';
        console.debug('[DEBUG] Checking for global command:', commandName);
        try {
            await new Promise<void>((resolve, reject) => {
                // Use platform-appropriate command to check if the command exists in PATH.
                // Bound discovery too: a broken PATH helper must not pin Remote startup.
                const whichCommand = process.platform === 'win32' ? 'where' : 'which';
                console.debug('[DEBUG] Using platform command:', whichCommand, 'on platform:', process.platform);
                const check = spawn(whichCommand, [commandName], { windowsHide: true });
                let settled = false;
                const finish = (error?: Error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (error) reject(error);
                    else resolve();
                };
                const timer = setTimeout(() => {
                    check.kill();
                    finish(new Error(`${whichCommand} timed out after ${COMMAND_DISCOVERY_TIMEOUT_MS}ms`));
                }, COMMAND_DISCOVERY_TIMEOUT_MS);
                check.on('error', (err) => {
                    console.debug('[DEBUG] Spawn error for', whichCommand, ':', err.message);
                    finish(err);
                });
                check.on('close', (code) => {
                    console.debug('[DEBUG]', whichCommand, 'exited with code:', code);
                    finish(code === 0 ? undefined : new Error('Command not found'));
                });
            });
            console.debug(' - Found global desktop-commander CLI');
            return {
                command: commandName,
                args: []
            };
        } catch (err) {
            console.debug('[DEBUG] Global command not found:', err);
            // Global command not found
        }

        console.debug('[DEBUG] No MCP config resolved');
        return null;
    }

    setToolsChangedHandler(handler: (() => void | Promise<void>) | null): void {
        this.toolsChangedHandler = handler;
    }

    async callClientTool(toolName: string, args: any, metadata?: any) {
        try {
            await this.ensureReady();
            const client = this.mcpClient;
            if (!client) throw new Error('Local Desktop Commander MCP connection was lost while dispatching');

            // Proxy other tools to MCP server.
            const toolArguments = normalizeMcpArgumentsObject(args, `Remote MCP arguments for ${toolName}`);
            console.debug('[DEBUG] Calling MCP tool:', toolName, 'args:', JSON.stringify(toolArguments).substring(0, 100));
            const requestTimeoutMs = localMcpRequestTimeoutMs(toolName, toolArguments);
            const result = await client.callTool({
                name: toolName,
                arguments: toolArguments,
                // `remote` is transport-owned authority metadata. Untrusted row
                // metadata must never downgrade the call to local and bypass
                // process/session ownership checks in the child MCP server.
                _meta: { ...metadata || {}, remote: true }
            } as any, undefined, requestTimeoutMs === undefined ? undefined : {
                timeout: requestTimeoutMs,
                maxTotalTimeout: requestTimeoutMs,
                resetTimeoutOnProgress: false,
            });
            const normalizedResult = normalizeMcpToolResult(result, `Local MCP result for ${toolName}`);
            console.debug('[DEBUG] Tool call successful:', toolName);
            return normalizedResult;
        } catch (error) {
            console.error(`Error executing tool ${toolName}:`, error);
            console.debug('[DEBUG] Tool call error details:', error);
            // Telemetry is best-effort and must never replace the tool's native
            // error envelope with a rejected promise / MCP server error.
            void captureRemote('desktop_integration_tool_call_failed', { error, toolName }).catch(() => {});
            return createMcpToolErrorResult(error, toolName);
        }
    }

    async listClientTools(): Promise<LocalMcpCapabilities> {
        const operation = this.capabilityDiscoveryTail.then(
            () => this.fetchClientTools(),
            () => this.fetchClientTools(),
        );
        this.capabilityDiscoveryTail = operation.then(() => undefined, () => undefined);
        return operation;
    }

    private async fetchClientTools(): Promise<LocalMcpCapabilities> {
        if (!this.mcpClient) {
            if (this.lastKnownCapabilities) return this.lastKnownCapabilities;
            throw new Error('Local Desktop Commander MCP is not connected; no validated tool catalog is available');
        }

        try {
            // List tools from MCP server
            const mcpTools = await this.mcpClient.listTools();
            if (!Array.isArray(mcpTools.tools)) {
                throw new Error('Local Desktop Commander MCP returned an invalid tools/list envelope');
            }

            // Merge tools
            const instructions = this.mcpClient.getInstructions();
            const capabilities: LocalMcpCapabilities = {
                tools: mcpTools.tools,
                ...(instructions ? { instructions } : {})
            };
            this.lastKnownCapabilities = capabilities;
            return capabilities;
        } catch (error) {
            console.error('Error fetching capabilities:', error);
            await captureRemote('desktop_integration_list_tools_failed', { error });
            // A transient tools/list failure must not erase the device's catalog
            // and make a healthy integration disappear from the remote client.
            if (this.lastKnownCapabilities) return this.lastKnownCapabilities;
            throw error;
        }
    }

    async shutdown() {
        console.debug('[DEBUG] DesktopCommanderIntegration.shutdown() called');
        this.isShuttingDown = true;
        const localServerPid = this.mcpTransport?.pid ?? null;
        let clientCloseError: any = null;
        let transportCloseError: any = null;

        if (this.mcpClient) {
            try {
                console.log('  → Closing MCP client...');
                await withDeadline(
                    this.mcpClient.close(),
                    LOCAL_MCP_CLOSE_TIMEOUT_MS,
                    'MCP client close'
                );
                console.log('  ✓ MCP client closed');
            } catch (error: any) {
                clientCloseError = error;
                console.warn('  ⚠️  MCP client close timeout or error:', error.message);
            } finally {
                this.mcpClient = null;
            }
        }

        if (this.mcpTransport && processExists(localServerPid)) {
            try {
                console.log('  → Closing MCP transport...');
                await withDeadline(
                    this.mcpTransport.close(),
                    LOCAL_MCP_TRANSPORT_FALLBACK_TIMEOUT_MS,
                    'MCP transport close fallback'
                );
            } catch (error: any) {
                transportCloseError = error;
                console.warn('  ⚠️  MCP transport fallback close failed:', error.message);
            }
        }

        if (processExists(localServerPid)) {
            console.warn(`  ⚠️  Local MCP server PID ${localServerPid} is still alive; force-terminating it`);
            const terminated = await forceTerminateProcess(localServerPid);
            if (!terminated) {
                transportCloseError ??= new Error(`Local MCP server PID ${localServerPid} survived forced termination`);
                console.error(`  ❌ Local MCP server PID ${localServerPid} is still running`);
            } else {
                console.log(`  ✓ Local MCP server PID ${localServerPid} terminated`);
            }
        }

        this.mcpTransport = null;
        this.isReady = false;

        if (clientCloseError) {
            void captureRemote('desktop_integration_shutdown_error', {
                error: clientCloseError, component: 'client'
            }).catch(() => {});
        }
        if (transportCloseError) {
            void captureRemote('desktop_integration_shutdown_error', {
                error: transportCloseError, component: 'transport'
            }).catch(() => {});
        }
        console.debug('[DEBUG] Desktop Commander integration shutdown complete');
    }
}
