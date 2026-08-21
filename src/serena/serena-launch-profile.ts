import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

const SERENA_SOURCE_ENV = 'DESKTOP_COMMANDER_SERENA_PROJECT';
const SERENA_HOME_ENV = 'DESKTOP_COMMANDER_SERENA_HOME';
const SERENA_PROJECT_DATA_ROOT_ENV = 'DESKTOP_COMMANDER_SERENA_PROJECT_DATA_ROOT';
const SERENA_UV_CACHE_ENV = 'DESKTOP_COMMANDER_SERENA_UV_CACHE_DIR';
const SERENA_UV_PROJECT_ENV = 'DESKTOP_COMMANDER_SERENA_UV_PROJECT_ENVIRONMENT';
const SERENA_PYTHON_CACHE_ENV = 'DESKTOP_COMMANDER_SERENA_PYTHONPYCACHEPREFIX';
const SERENA_UV_COMMAND_ENV = 'DESKTOP_COMMANDER_SERENA_UV_COMMAND';
const SERENA_CPP_PROFILE_ENV = 'DESKTOP_COMMANDER_SERENA_CPP_PROFILE_JSON';

const CHILD_SERENA_ENV_KEYS = [
  'SERENA_HOME', 'SERENA_PROJECT_DATA_ROOT', 'SERENA_FORCED_LANGUAGE_SERVERS',
  'SERENA_CPP_COMPILATION_DATABASE_PATH', 'SERENA_CPP_QUERY_DRIVERS',
  'SERENA_CPP_TOOLCHAIN_PROFILE_FINGERPRINT', 'UV_CACHE_DIR', 'UV_PROJECT_ENVIRONMENT', 'PYTHONPYCACHEPREFIX',
] as const;

export type SerenaLaunchProfile = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  profileFingerprint: string;
  sourceRoot: string;
  stateRoot: string;
  projectDataRoot: string;
  projectEnvironment: string;
};

type CppProfile = {
  root?: unknown;
  compilationDatabasePath?: unknown;
  queryDrivers?: unknown;
  runtimePathEntries?: unknown;
  profileFingerprint?: unknown;
};

function envStrings(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') result[key] = value;
  for (const key of CHILD_SERENA_ENV_KEYS) delete result[key];
  return result;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function directory(value: string, label: string): Promise<string> {
  const resolved = path.resolve(value);
  const stats = await fs.stat(resolved).catch(() => undefined);
  if (!stats?.isDirectory()) throw new Error(`${label} does not exist: ${resolved}`);
  return fs.realpath(resolved);
}

async function serenaSourceRoot(): Promise<string> {
  const configured = process.env[SERENA_SOURCE_ENV]?.trim();
  if (configured) return directory(configured, SERENA_SOURCE_ENV);
  // Both src/serena and dist/serena are three levels below the shared `fork`
  // directory. Resolve from this module, not process.cwd(): the real remote
  // child runs with cwd=<package>/dist while development tests often use the
  // package root, which previously made the test and production paths differ.
  const packageSibling = path.resolve(moduleDirectory, '..', '..', '..', 'serena');
  return directory(packageSibling, `${SERENA_SOURCE_ENV} or sibling fork/serena`);
}

function parseCppProfile(workspaceRoot: string): CppProfile | undefined {
  const raw = process.env[SERENA_CPP_PROFILE_ENV]?.trim();
  if (!raw) return undefined;
  let value: CppProfile;
  try { value = JSON.parse(raw) as CppProfile; } catch {
    throw new Error(`${SERENA_CPP_PROFILE_ENV} must contain valid JSON.`);
  }
  if (typeof value.root !== 'string' || !samePath(value.root, workspaceRoot)) return undefined;
  return value;
}

function applyCppProfile(
  env: Record<string, string>, profile: CppProfile | undefined, forceCpp: boolean,
): string {
  if (!profile && !forceCpp) return 'default';
  env.SERENA_FORCED_LANGUAGE_SERVERS = '[\"cpp\"]';
  if (typeof profile?.compilationDatabasePath === 'string' && profile.compilationDatabasePath.trim()) {
    env.SERENA_CPP_COMPILATION_DATABASE_PATH = path.resolve(profile.compilationDatabasePath);
  }
  if (Array.isArray(profile?.queryDrivers) && profile.queryDrivers.every((item) => typeof item === 'string')) {
    env.SERENA_CPP_QUERY_DRIVERS = JSON.stringify(profile.queryDrivers);
  }
  if (typeof profile?.profileFingerprint === 'string' && profile.profileFingerprint.trim()) {
    env.SERENA_CPP_TOOLCHAIN_PROFILE_FINGERPRINT = profile.profileFingerprint.trim();
  }
  if (Array.isArray(profile?.runtimePathEntries) && profile.runtimePathEntries.every((item) => typeof item === 'string')) {
    const entries = profile.runtimePathEntries.map((item) => path.resolve(item as string));
    env.PATH = [...entries, env.PATH ?? ''].filter(Boolean).join(path.delimiter);
  }
  return typeof profile?.profileFingerprint === 'string' && profile.profileFingerprint.trim()
    ? profile.profileFingerprint.trim()
    : 'cpp';
}

export async function buildSerenaLaunchProfile(
  workspaceRoot: string, templateServer?: string,
): Promise<SerenaLaunchProfile> {
  const sourceRoot = await serenaSourceRoot();
  const environmentRoot = path.resolve(sourceRoot, '..', '..');
  const stateRoot = path.resolve(process.env[SERENA_HOME_ENV]?.trim() || path.join(environmentRoot, 'state', 'serena-internal', 'home'));
  const projectDataRoot = path.resolve(
    process.env[SERENA_PROJECT_DATA_ROOT_ENV]?.trim() || path.join(environmentRoot, 'state', 'serena-internal', 'projects'),
  );
  const uvCache = path.resolve(process.env[SERENA_UV_CACHE_ENV]?.trim() || path.join(environmentRoot, '.cache', 'serena-internal', 'uv'));
  const projectEnvironment = path.resolve(
    process.env[SERENA_UV_PROJECT_ENV]?.trim() || path.join(environmentRoot, '.cache', 'serena-internal', 'venv'),
  );
  const pythonCache = path.resolve(
    process.env[SERENA_PYTHON_CACHE_ENV]?.trim() || path.join(environmentRoot, '.cache', 'serena-internal', 'pycache'),
  );
  await Promise.all([stateRoot, projectDataRoot, uvCache, pythonCache].map((dir) => fs.mkdir(dir, { recursive: true })));

  const env = envStrings();
  env.SERENA_HOME = stateRoot;
  env.SERENA_PROJECT_DATA_ROOT = projectDataRoot;
  env.UV_CACHE_DIR = uvCache;
  env.UV_PROJECT_ENVIRONMENT = projectEnvironment;
  env.UV_NO_ENV_FILE = '1';
  env.PYTHONPYCACHEPREFIX = pythonCache;
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  const cppProfile = parseCppProfile(workspaceRoot);
  const semanticProfile = applyCppProfile(env, cppProfile, templateServer === 'serena-primary-cpp');

  return {
    command: process.env[SERENA_UV_COMMAND_ENV]?.trim() || 'uv',
    args: [
      'run', '--project', sourceRoot, '--exact', '--locked', '--no-dev', '-p', '3.13',
      'serena', 'start-mcp-server', '--transport', 'stdio', '--project', workspaceRoot,
      '--context', 'agent', '--enable-web-dashboard', 'false', '--open-web-dashboard', 'false',
    ],
    cwd: sourceRoot,
    env,
    profileFingerprint: semanticProfile,
    sourceRoot,
    stateRoot,
    projectDataRoot,
    projectEnvironment,
  };
}
