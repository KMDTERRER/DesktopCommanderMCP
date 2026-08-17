import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ServerDefinition } from 'mcporter';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { validatePathAuthority as validatePath } from './path-security.js';

type McpServerEntry = { args?: unknown; cwd?: unknown; env?: unknown };
type McporterConfig = { mcpServers?: Record<string, McpServerEntry> };

const MAX_CHANGED_FILES = 5000;

function optionValue(args: unknown, option: string): string | undefined {
  if (!Array.isArray(args)) return undefined;
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (item === option && typeof args[index + 1] === 'string') return args[index + 1] as string;
    if (typeof item === 'string' && item.startsWith(`${option}=`)) return item.slice(option.length + 1);
  }
  return undefined;
}

function envValue(env: unknown, key: string): string | undefined {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return undefined;
  const value = (env as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveConfiguredRoot(rawRoot: string, cwd: string): string {
  if (rawRoot === '~') return os.homedir();
  if (rawRoot.startsWith('~/') || rawRoot.startsWith('~\\')) {
    return path.resolve(os.homedir(), rawRoot.slice(2));
  }
  return path.isAbsolute(rawRoot) ? rawRoot : path.resolve(cwd, rawRoot);
}

function configuredRootValue(args: unknown, env: unknown, cwd: string): string | undefined {
  const rawRoot = optionValue(args, '--repo') ?? envValue(env, 'CRG_REPO_ROOT');
  return rawRoot ? resolveConfiguredRoot(rawRoot, cwd) : undefined;
}

function configuredWorkspaceRootValue(args: unknown, env: unknown, cwd: string): string | undefined {
  const repositoryRoot = configuredRootValue(args, env, cwd);
  if (repositoryRoot) return repositoryRoot;
  if (!Array.isArray(args)) return undefined;
  const serverStart = args.lastIndexOf('start-mcp-server');
  if (serverStart < 0) return undefined;
  const rawProject = optionValue(args.slice(serverStart + 1), '--project');
  return rawProject ? resolveConfiguredRoot(rawProject, cwd) : undefined;
}

function remainingTimeout(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    const error = new Error('External MCP workspace binding deadline exceeded.') as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return remaining;
}

async function validatePathBounded(value: string, deadlineAt: number): Promise<string> {
  return validatePath(value, remainingTimeout(deadlineAt));
}

function normalizeComparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function configuredRepoRoot(configPath: string, server: string, deadlineAt: number): Promise<string | undefined> {
  const raw = await runWithAbortableTimeout(
    (signal) => fs.readFile(configPath, { encoding: 'utf8', signal }),
    remainingTimeout(deadlineAt),
    `Read external MCP config ${configPath}`
  );
  const parsed = JSON.parse(raw) as McporterConfig;
  const entry = parsed.mcpServers?.[server];
  const configDir = path.dirname(configPath);
  const cwd = typeof entry?.cwd === 'string' && entry.cwd.trim()
    ? path.resolve(configDir, entry.cwd)
    : configDir;
  return configuredRootValue(entry?.args, entry?.env, cwd);
}

async function bindToConfiguredRoot(
  server: string,
  configuredRoot: string | undefined,
  rawArgs: Record<string, unknown>,
  deadlineAt: number,
  injectRepoRoot: boolean,
): Promise<Record<string, unknown>> {
  if (!configuredRoot) return rawArgs;

  const boundRoot = await validatePathBounded(configuredRoot, deadlineAt);
  const suppliedRoot = rawArgs.repo_root;
  if (suppliedRoot !== undefined && suppliedRoot !== null) {
    if (typeof suppliedRoot !== 'string' || !suppliedRoot.trim()) {
      throw new Error(`MCP server '${server}' is workspace-bound; repo_root must be a path string.`);
    }
    const requestedRoot = await validatePathBounded(suppliedRoot, deadlineAt);
    if (normalizeComparablePath(requestedRoot) !== normalizeComparablePath(boundRoot)) {
      throw new Error(
        `MCP server '${server}' is bound to '${boundRoot}' and cannot switch repo_root to '${suppliedRoot}'.`,
      );
    }
  }

  const changedFiles = rawArgs.changed_files;
  if (changedFiles !== undefined && changedFiles !== null) {
    if (!Array.isArray(changedFiles)) {
      throw new Error(`MCP server '${server}' is workspace-bound; changed_files must be an array.`);
    }
    if (changedFiles.length > MAX_CHANGED_FILES) {
      throw new Error(`MCP server '${server}' changed_files is limited to ${MAX_CHANGED_FILES} entries.`);
    }
    for (const item of changedFiles) {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error(`MCP server '${server}' received an invalid changed_files entry.`);
      }
      if (path.isAbsolute(item)) {
        throw new Error(`MCP server '${server}' requires changed_files paths relative to its bound workspace.`);
      }
      const candidate = await validatePathBounded(path.resolve(boundRoot, item), deadlineAt);
      if (!isWithin(boundRoot, candidate)) {
        throw new Error(
          `MCP server '${server}' rejected changed_files path '${item}' outside '${boundRoot}'.`,
        );
      }
    }
  }

  return injectRepoRoot ? { ...rawArgs, repo_root: boundRoot } : rawArgs;
}

export async function bindExternalMcpWorkspace(
  configPath: string,
  server: string,
  rawArgs: Record<string, unknown>,
  deadlineAt = Date.now() + 30_000,
): Promise<Record<string, unknown>> {
  return bindToConfiguredRoot(
    server,
    await configuredRepoRoot(configPath, server, deadlineAt),
    rawArgs,
    deadlineAt,
    true,
  );
}

export async function resolveExternalMcpWorkspaceDefinition(
  definition: ServerDefinition,
  deadlineAt = Date.now() + 30_000,
): Promise<string | undefined> {
  const commandArgs = definition.command.kind === 'stdio' ? definition.command.args : [];
  const cwd = definition.command.kind === 'stdio' ? definition.command.cwd : process.cwd();
  const configuredRoot = configuredWorkspaceRootValue(commandArgs, definition.env, cwd);
  return configuredRoot ? validatePathBounded(configuredRoot, deadlineAt) : undefined;
}

export async function bindExternalMcpWorkspaceDefinition(
  definition: ServerDefinition,
  rawArgs: Record<string, unknown>,
  deadlineAt = Date.now() + 30_000,
  injectRepoRoot = true,
): Promise<Record<string, unknown>> {
  const configuredRoot = await resolveExternalMcpWorkspaceDefinition(definition, deadlineAt);
  return bindToConfiguredRoot(definition.name, configuredRoot, rawArgs, deadlineAt, injectRepoRoot);
}
