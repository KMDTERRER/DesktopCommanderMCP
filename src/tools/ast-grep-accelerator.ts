import fs from 'fs/promises';
import path from 'path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validatePath } from './filesystem.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { runBoundedSubprocess, type BoundedSubprocessResult } from '../utils/bounded-subprocess.js';
import { readFileBounded } from '../utils/bounded-file-read.js';

const AST_GREP_TIMEOUT_MS = 30_000;
const AST_GREP_EXPECTED_VERSION = '0.45.0';
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_AST_GREP_RESULTS = 200;
const MAX_AST_GREP_MATCH_CHARS = 8_000;
const MAX_AST_GREP_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_AST_REWRITE_FILES = 100;
const MAX_AST_REWRITE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_AST_REWRITE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_AST_REWRITE_PATCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_AST_REWRITE_PATCH_PREVIEW_CHARS = 60_000;
const MAX_AST_REWRITE_PATCH_PREVIEW_CHARS = 500_000;

interface CompactAstMatch {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  text: string;
  ruleId?: string;
  language?: string;
}

interface AstRewriteMatch extends CompactAstMatch {
  absoluteFile: string;
  repositoryFile: string;
  rawText: string;
  matchStartByte: number;
  matchEndByte: number;
  replacementStartByte: number;
  replacementEndByte: number;
  replacement: string;
}

export interface PreparedAstGrepRewriteFile {
  relative: string;
  absolute: string;
  before: Buffer;
  after: Buffer;
  beforeHash: string;
  afterHash: string;
}

export interface PreparedAstGrepRewrite {
  publicResult: Record<string, unknown>;
  patch: string;
  expectedFiles: string[];
  expectedHashes: Record<string, string>;
  files: PreparedAstGrepRewriteFile[];
}

function normalizeSlash(value: string): string {
  return value.replace(/\\/g, '/');
}

function boundedDiagnostic(value: string, maxChars = 16_000): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}… [${trimmed.length - maxChars} diagnostic chars omitted]`;
}

function pathIdentity(value: string): string {
  const normalized = normalizeSlash(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function validateLanguage(raw: unknown, label: string): string {
  const language = typeof raw === 'string' ? raw.trim() : '';
  if (!language || !/^[A-Za-z][A-Za-z0-9_+.-]{0,63}$/.test(language)) {
    throw new Error(`${label} must be a single ast-grep language name.`);
  }
  return language;
}

function remaining(deadlineAt: number, label: string): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) {
    const error = new Error(`${label} deadline exceeded.`) as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return value;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return numberValue;
}

async function resolveProjectFolder(raw: unknown, deadlineAt: number): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('project_folder is required.');
  const folder = await validatePath(
    raw,
    remaining(deadlineAt, 'ast-grep project path validation'),
  );
  const stats = await runWithAbortableTimeout(
    (_signal) => fs.stat(folder),
    remaining(deadlineAt, 'ast-grep project folder stat'),
    `Stat ast-grep project folder ${folder}`,
  );
  if (!stats.isDirectory()) throw new Error('project_folder must be a directory.');
  return folder;
}

const verifiedAstGrepExecutables = new Map<string, string>();

async function verifyAstGrepExecutable(
  candidate: string,
  stats: { size: number; mtimeMs: number; ctimeMs: number },
  deadlineAt: number,
): Promise<void> {
  const identity = pathIdentity(candidate);
  const signature = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  if (verifiedAstGrepExecutables.get(identity) === signature) return;
  const version = await runBoundedSubprocess(candidate, ['--version'], {
    timeoutMs: Math.max(100, Math.min(3_000, remaining(deadlineAt, 'ast-grep version probe'))),
    maxOutputBytes: 64 * 1024,
    label: 'ast-grep version probe',
  });
  if (version.exitCode !== 0) {
    throw new Error(`AST_GREP_VERSION_PROBE_FAILED: ${boundedDiagnostic(version.stderr || version.stdout, 8_000)}`);
  }
  const rendered = `${version.stdout} ${version.stderr}`.trim();
  const parsed = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(rendered)?.[1];
  if (parsed !== AST_GREP_EXPECTED_VERSION) {
    throw new Error(
      `AST_GREP_VERSION_MISMATCH: expected ${AST_GREP_EXPECTED_VERSION}, got ${(parsed ?? rendered) || 'unknown'}.`,
    );
  }
  verifiedAstGrepExecutables.set(identity, signature);
}

async function resolveExecutable(deadlineAt: number): Promise<string> {
  const configured = process.env.AST_GREP_BIN?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new Error('AST_GREP_BIN must be an absolute executable path.');
  }
  const executableName = process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';
  const candidates = configured
    ? [configured]
    : [path.join(PACKAGE_ROOT, 'node_modules', '@ast-grep', 'cli', executableName)];
  // The package-owned exact dependency is the default authority. User-project
  // cwd, APPDATA globals, and PATH are deliberately not searched: a repository
  // must never be able to substitute the structural rewrite executable.

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const identity = pathIdentity(candidate);
    if (seen.has(identity)) continue;
    seen.add(identity);
    try {
      const stats = await runWithAbortableTimeout(
        (_signal) => fs.stat(candidate),
        remaining(deadlineAt, 'ast-grep executable resolution'),
        `Stat ast-grep executable ${candidate}`,
      );
      if (!stats.isFile()) continue;
      await verifyAstGrepExecutable(candidate, stats, deadlineAt);
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === 'ETIMEDOUT' || message.startsWith('AST_GREP_VERSION_')) throw error;
      // There is normally one authority; retain the loop only for a uniform probe path.
    }
  }
  throw new Error(
    `ast-grep ${AST_GREP_EXPECTED_VERSION} package executable not found under ${PACKAGE_ROOT}. ` +
    'Run npm ci/bootstrap, or set AST_GREP_BIN to an explicit absolute compatible executable.',
  );
}

function parseMatches(stdout: string, projectFolder: string): CompactAstMatch[] {
  const matches: CompactAstMatch[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error('ast-grep returned malformed JSON stream output.');
    }
    const rawFile = String(raw.file ?? '');
    const absoluteFile = path.resolve(projectFolder, rawFile);
    const relative = normalizeSlash(path.relative(projectFolder, absoluteFile));
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error(`ast-grep returned a match outside project_folder: ${raw.file}`);
    }
    const start = raw.range?.start ?? {};
    const end = raw.range?.end ?? {};
    const fullText = typeof raw.text === 'string' ? raw.text : '';
    matches.push({
      file: relative,
      line: Number(start.line ?? 0) + 1,
      column: Number(start.column ?? 0) + 1,
      endLine: Number(end.line ?? start.line ?? 0) + 1,
      endColumn: Number(end.column ?? start.column ?? 0) + 1,
      text: fullText.length > MAX_AST_GREP_MATCH_CHARS
        ? `${fullText.slice(0, MAX_AST_GREP_MATCH_CHARS)}…`
        : fullText,
      ...(typeof raw.ruleId === 'string' ? { ruleId: raw.ruleId } : {}),
      ...(typeof raw.language === 'string' ? { language: raw.language } : {}),
    });
  }
  return matches;
}

function formatMatches(matches: CompactAstMatch[]): string {
  if (matches.length === 0) return 'No structural matches.';
  return matches.map((match) =>
    `${match.file}:${match.line}:${match.column} ${match.text.replace(/\r?\n/g, '\\n')}`,
  ).join('\n');
}

async function runRuleFileScan(
  projectFolder: string,
  ruleText: string,
  maxResults: number,
  deadlineAt: number,
  label: string,
  maxOutputBytes: number,
): Promise<BoundedSubprocessResult> {
  const executable = await resolveExecutable(deadlineAt);
  const tempRoot = await runWithAbortableTimeout(
    (_signal) => fs.mkdtemp(path.join(os.tmpdir(), 'dc-ast-rule-')),
    remaining(deadlineAt, `${label} temp directory`),
    `Create ${label} temp directory`,
  );
  const ruleFile = path.join(tempRoot, 'rule.yml');
  try {
    await runWithAbortableTimeout(
      (signal) => fs.writeFile(ruleFile, ruleText, { encoding: 'utf8', signal }),
      remaining(deadlineAt, `${label} rule write`),
      `Write ${label} rule file`,
    );
    return await runBoundedSubprocess(executable, [
      'scan',
      '--rule', ruleFile,
      '--max-results', String(maxResults),
      '--json=stream',
      projectFolder,
    ], {
      timeoutMs: remaining(deadlineAt, label),
      maxOutputBytes,
      label,
    });
  } finally {
    const cleanup = fs.rm(tempRoot, { recursive: true, force: true });
    await runWithAbortableTimeout(
      (_signal) => cleanup,
      Math.max(100, Math.min(1_500, deadlineAt - Date.now())),
      `Clean ${label} rule directory`,
    ).catch(() => { void cleanup.catch(() => undefined); });
  }
}

async function runSearch(
  projectFolder: string,
  inlineRules: string,
  maxResults: number,
  deadlineAt: number,
): Promise<{ matches: CompactAstMatch[]; stderr: string }> {
  let result: BoundedSubprocessResult;
  try {
    result = await runRuleFileScan(
      projectFolder, inlineRules, maxResults, deadlineAt, 'ast-grep scan', MAX_AST_GREP_OUTPUT_BYTES,
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(
        `ast-grep ${AST_GREP_EXPECTED_VERSION} executable not found. Run the architecture bootstrap or set AST_GREP_BIN.`,
      );
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    throw new Error(`ast-grep scan failed (${result.exitCode}): ${boundedDiagnostic(result.stderr || result.stdout)}`);
  }
  return {
    matches: parseMatches(result.stdout, projectFolder),
    stderr: result.stderr.trim(),
  };
}

function output(
  projectFolder: string,
  matches: CompactAstMatch[],
  maxResults: number,
  outputFormat: unknown,
  stderr: string,
) {
  const format = outputFormat === undefined ? 'text' : outputFormat;
  if (format !== 'text' && format !== 'json') throw new Error("output_format must be 'text' or 'json'.");
  const payload = {
    projectFolder: normalizeSlash(projectFolder),
    returnedMatches: matches.length,
    maxResults,
    limitReached: matches.length >= maxResults,
    ...(stderr ? { warning: stderr.slice(0, 4000) } : {}),
  };
  return format === 'json'
    ? { ...payload, matches }
    : { ...payload, text: formatMatches(matches) };
}

async function astSearch(args: Record<string, unknown>) {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  const language = validateLanguage(args.language, 'ast_search.language');
  if (!pattern) throw new Error('ast_search.pattern is required.');
  if (pattern.length > 64 * 1024) throw new Error('ast_search.pattern is limited to 64 KiB.');
  const maxResults = boundedInteger(args.max_results, 50, 1, MAX_AST_GREP_RESULTS, 'max_results');
  const timeoutMs = boundedInteger(args.timeout_ms, AST_GREP_TIMEOUT_MS, 100, 60_000, 'timeout_ms');
  const deadlineAt = Date.now() + timeoutMs;
  const projectFolder = await resolveProjectFolder(args.project_folder, deadlineAt);
  const inlineRules = [
    'id: desktop-commander-inline-pattern',
    `language: ${language}`,
    'rule:',
    `  pattern: ${JSON.stringify(pattern)}`,
  ].join('\n');
  const { matches, stderr } = await runSearch(projectFolder, inlineRules, maxResults, deadlineAt);
  return output(projectFolder, matches, maxResults, args.output_format, stderr);
}

async function astRuleSearch(args: Record<string, unknown>) {
  const yaml = typeof args.yaml === 'string' ? args.yaml : '';
  if (!yaml.trim()) throw new Error('ast_rule_search.yaml is required.');
  if (yaml.length > 256 * 1024) throw new Error('ast_rule_search.yaml is limited to 256 KiB.');
  const maxResults = boundedInteger(args.max_results, 50, 1, MAX_AST_GREP_RESULTS, 'max_results');
  const timeoutMs = boundedInteger(args.timeout_ms, AST_GREP_TIMEOUT_MS, 100, 60_000, 'timeout_ms');
  const deadlineAt = Date.now() + timeoutMs;
  const projectFolder = await resolveProjectFolder(args.project_folder, deadlineAt);
  const { matches, stderr } = await runSearch(projectFolder, yaml, maxResults, deadlineAt);
  return output(projectFolder, matches, maxResults, args.output_format, stderr);
}

async function resolveRewriteRepositoryRoot(projectFolder: string, deadlineAt: number): Promise<string> {
  const gitExecutable = process.platform === 'win32' ? 'git.exe' : 'git';
  const result = await runBoundedSubprocess(gitExecutable, ['-C', projectFolder, 'rev-parse', '--show-toplevel'], {
    timeoutMs: remaining(deadlineAt, 'ast rewrite repository discovery'),
    maxOutputBytes: 256 * 1024,
    label: 'git rev-parse for ast rewrite',
  });
  if (result.exitCode !== 0) {
    throw new Error(`ast_rewrite requires a Git worktree: ${boundedDiagnostic(result.stderr || result.stdout, 8_000)}`);
  }
  const rawRoot = result.stdout.trim();
  if (!rawRoot) throw new Error('ast_rewrite could not resolve the Git repository root.');
  const validatedRoot = await validatePath(rawRoot, remaining(deadlineAt, 'ast rewrite repository validation'));
  const [canonicalRoot, canonicalProject] = await Promise.all([
    runWithAbortableTimeout((_signal) => fs.realpath(validatedRoot), remaining(deadlineAt, 'ast rewrite repository realpath'), `Resolve ast rewrite repository ${validatedRoot}`),
    runWithAbortableTimeout((_signal) => fs.realpath(projectFolder), remaining(deadlineAt, 'ast rewrite project realpath'), `Resolve ast rewrite project ${projectFolder}`),
  ]);
  if (!isInside(canonicalRoot, canonicalProject)) {
    throw new Error('ast_rewrite.project_folder must be inside the resolved Git repository.');
  }
  return canonicalRoot;
}

function rewriteOffset(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`ast-grep returned invalid ${label}.`);
  return parsed;
}

function buildRewriteRules(args: Record<string, unknown>): { inlineRules: string; mode: 'pattern' | 'yaml' } {
  const yaml = typeof args.yaml === 'string' ? args.yaml : '';
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  const hasRewrite = typeof args.rewrite === 'string';
  if (yaml.trim()) {
    if (pattern || hasRewrite || args.language !== undefined) {
      throw new Error('ast_rewrite accepts either yaml or pattern+rewrite+language, not both.');
    }
    if (yaml.length > 256 * 1024) throw new Error('ast_rewrite.yaml is limited to 256 KiB.');
    return { inlineRules: yaml, mode: 'yaml' };
  }
  if (!pattern) throw new Error('ast_rewrite.pattern is required when yaml is not provided.');
  if (!hasRewrite) throw new Error('ast_rewrite.rewrite is required when yaml is not provided.');
  if (pattern.length > 64 * 1024) throw new Error('ast_rewrite.pattern is limited to 64 KiB.');
  const rewrite = args.rewrite as string;
  if (rewrite.length > 256 * 1024) throw new Error('ast_rewrite.rewrite is limited to 256 KiB.');
  const language = validateLanguage(args.language, 'ast_rewrite.language');
  return {
    mode: 'pattern',
    inlineRules: [
      'id: desktop-commander-inline-rewrite',
      `language: ${language}`,
      'rule:',
      `  pattern: ${JSON.stringify(pattern)}`,
      `fix: ${JSON.stringify(rewrite)}`,
    ].join('\n'),
  };
}

async function runRewriteScan(
  projectFolder: string,
  inlineRules: string,
  maxResults: number,
  deadlineAt: number,
): Promise<BoundedSubprocessResult> {
  let result: BoundedSubprocessResult;
  try {
    result = await runRuleFileScan(
      projectFolder, inlineRules, maxResults + 1, deadlineAt,
      'ast-grep rewrite preview', MAX_AST_GREP_OUTPUT_BYTES * 2,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(
        `ast-grep ${AST_GREP_EXPECTED_VERSION} executable not found. Run the architecture bootstrap or set AST_GREP_BIN.`,
      );
    }
    throw error;
  }
  if (result.exitCode !== 0 && !(result.exitCode === 1 && result.stdout.trim())) {
    throw new Error(`ast-grep rewrite scan failed (${result.exitCode}): ${boundedDiagnostic(result.stderr || result.stdout)}`);
  }
  return result;
}

function parseRewriteMatches(stdout: string, projectFolder: string, repoRoot: string): AstRewriteMatch[] {
  const matches: AstRewriteMatch[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: any;
    try { raw = JSON.parse(line); }
    catch { throw new Error('ast-grep returned malformed JSON stream output for rewrite preview.'); }
    if (typeof raw.replacement !== 'string' || !raw.replacementOffsets) {
      throw new Error('AST_REWRITE_RULE_HAS_NO_FIX: every ast_rewrite match must provide a fix/replacement.');
    }
    const rawFile = String(raw.file ?? '');
    if (!rawFile) throw new Error('ast-grep rewrite result omitted its file path.');
    const absoluteFile = path.isAbsolute(rawFile) ? path.resolve(rawFile) : path.resolve(projectFolder, rawFile);
    const projectRelative = normalizeSlash(path.relative(projectFolder, absoluteFile));
    if (!projectRelative || projectRelative === '..' || projectRelative.startsWith('../') || path.isAbsolute(projectRelative)) {
      throw new Error(`ast-grep returned a rewrite outside project_folder: ${raw.file}`);
    }
    const rawRepositoryFile = path.relative(repoRoot, absoluteFile);
    if (process.platform !== 'win32' && rawRepositoryFile.includes('\\')) {
      throw new Error('AST_REWRITE_UNSUPPORTED_PATH_CHARS: backslash in a Unix filename is not supported by rewrite preview v1.');
    }
    const repositoryFile = normalizeSlash(rawRepositoryFile);
    if (!repositoryFile || repositoryFile === '..' || repositoryFile.startsWith('../') || path.isAbsolute(repositoryFile)) {
      throw new Error(`ast-grep returned a rewrite outside the Git repository: ${raw.file}`);
    }
    if (repositoryFile === '.git' || repositoryFile.startsWith('.git/')) {
      throw new Error('AST_REWRITE_REPOSITORY_METADATA_FORBIDDEN: .git cannot be a rewrite target.');
    }
    if (/[\u0000\r\n\t"]/u.test(repositoryFile)) {
      throw new Error(`AST_REWRITE_UNSUPPORTED_PATH_CHARS: rewrite preview cannot safely encode path ${repositoryFile}.`);
    }
    const start = raw.range?.start ?? {};
    const end = raw.range?.end ?? {};
    const byteRange = raw.range?.byteOffset ?? {};
    const matchStartByte = rewriteOffset(byteRange.start, 'match byte start');
    const matchEndByte = rewriteOffset(byteRange.end, 'match byte end');
    const replacementStartByte = rewriteOffset(raw.replacementOffsets.start, 'replacement byte start');
    const replacementEndByte = rewriteOffset(raw.replacementOffsets.end, 'replacement byte end');
    if (matchEndByte < matchStartByte || replacementEndByte < replacementStartByte) {
      throw new Error('ast-grep returned a reversed rewrite byte range.');
    }
    if (replacementStartByte !== matchStartByte || replacementEndByte !== matchEndByte) {
      throw new Error(
        'AST_REWRITE_UNSUPPORTED_REPLACEMENT_RANGE: v1 only applies fixes whose replacement byte range exactly equals the reported match range.',
      );
    }
    const rawText = typeof raw.text === 'string' ? raw.text : '';
    matches.push({
      file: projectRelative,
      repositoryFile,
      absoluteFile,
      line: Number(start.line ?? 0) + 1,
      column: Number(start.column ?? 0) + 1,
      endLine: Number(end.line ?? start.line ?? 0) + 1,
      endColumn: Number(end.column ?? start.column ?? 0) + 1,
      text: rawText.length > MAX_AST_GREP_MATCH_CHARS ? `${rawText.slice(0, MAX_AST_GREP_MATCH_CHARS)}…` : rawText,
      rawText,
      matchStartByte,
      matchEndByte,
      replacementStartByte,
      replacementEndByte,
      replacement: raw.replacement,
      ...(typeof raw.ruleId === 'string' ? { ruleId: raw.ruleId } : {}),
      ...(typeof raw.language === 'string' ? { language: raw.language } : {}),
    });
  }
  return matches;
}

function rewriteMatchSetHash(matches: AstRewriteMatch[]): string {
  const rows = matches.map((match) => ({
    file: match.repositoryFile,
    matchStartByte: match.matchStartByte,
    matchEndByte: match.matchEndByte,
    replacementStartByte: match.replacementStartByte,
    replacementEndByte: match.replacementEndByte,
    rawText: match.rawText,
    replacement: match.replacement,
    ruleId: match.ruleId ?? null,
  })).sort((a, b) =>
    a.file.localeCompare(b.file) || a.matchStartByte - b.matchStartByte ||
    a.matchEndByte - b.matchEndByte || String(a.ruleId).localeCompare(String(b.ruleId))
  );
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function verifyPreparedRewriteSources(
  files: PreparedAstGrepRewriteFile[], deadlineAt: number,
): Promise<void> {
  for (const file of files) {
    const bytes = await runWithAbortableTimeout(
      (signal) => readFileBounded(file.absolute, MAX_AST_REWRITE_FILE_BYTES, signal, 'ast rewrite stability check'),
      remaining(deadlineAt, 'ast rewrite stability read'),
      `Re-read ast rewrite source ${file.relative}`,
    );
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hash !== file.beforeHash) {
      throw new Error(`AST_REWRITE_SCAN_CHANGED: ${file.relative} changed while structural preview was being prepared.`);
    }
  }
}

function detectEolStyle(text: string): 'lf' | 'crlf' | 'mixed' | 'none' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > 0 && lf > 0) return 'mixed';
  if (crlf > 0) return 'crlf';
  if (lf > 0) return 'lf';
  return 'none';
}

function replacementForFile(beforeText: string, edit: AstRewriteMatch, file: string): string {
  if (!/[\r\n]/.test(edit.replacement)) return edit.replacement;
  let style = detectEolStyle(beforeText);
  if (style === 'mixed') {
    const matchedStyle = detectEolStyle(edit.rawText);
    if (matchedStyle === 'lf' || matchedStyle === 'crlf') style = matchedStyle;
    else {
      throw new Error(
        `AST_REWRITE_AMBIGUOUS_EOL: multiline replacement in mixed-EOL file ${file} has no local newline convention.`,
      );
    }
  }
  if (style === 'crlf') return edit.replacement.replace(/\r\n|\r|\n/g, '\r\n');
  if (style === 'lf') return edit.replacement.replace(/\r\n|\r/g, '\n');
  return edit.replacement;
}

function applyByteRewrites(before: Buffer, edits: AstRewriteMatch[], file: string): Buffer {
  const beforeText = before.toString('utf8');
  const unique = new Map<string, AstRewriteMatch & { normalizedReplacement: string }>();
  for (const edit of edits) {
    if (edit.matchEndByte > before.length || edit.replacementEndByte > before.length) {
      throw new Error(`AST_REWRITE_STALE_SOURCE: byte range exceeds current file size for ${file}.`);
    }
    const observedMatch = before.subarray(edit.matchStartByte, edit.matchEndByte).toString('utf8');
    if (observedMatch !== edit.rawText) {
      throw new Error(`AST_REWRITE_STALE_SOURCE: ${file} changed after ast-grep matched it.`);
    }
    const normalizedReplacement = replacementForFile(beforeText, edit, file);
    const key = `${edit.replacementStartByte}:${edit.replacementEndByte}`;
    const prior = unique.get(key);
    if (prior) {
      if (prior.normalizedReplacement !== normalizedReplacement) {
        throw new Error(`AST_REWRITE_CONFLICT: different fixes target the same byte range in ${file}.`);
      }
      continue;
    }
    unique.set(key, { ...edit, normalizedReplacement });
  }
  const ordered = [...unique.values()].sort((a, b) =>
    a.replacementStartByte - b.replacementStartByte || a.replacementEndByte - b.replacementEndByte
  );
  let cursor = 0;
  const chunks: Buffer[] = [];
  for (const edit of ordered) {
    if (edit.replacementStartByte < cursor) {
      throw new Error(`AST_REWRITE_OVERLAP: overlapping fixes are not applied automatically in ${file}.`);
    }
    chunks.push(before.subarray(cursor, edit.replacementStartByte));
    chunks.push(Buffer.from(edit.normalizedReplacement, 'utf8'));
    cursor = edit.replacementEndByte;
  }
  chunks.push(before.subarray(cursor));
  return Buffer.concat(chunks);
}

async function prepareRewriteFiles(
  matches: AstRewriteMatch[],
  projectFolder: string,
  repoRoot: string,
  deadlineAt: number,
): Promise<PreparedAstGrepRewriteFile[]> {
  const byFile = new Map<string, AstRewriteMatch[]>();
  const absoluteByFile = new Map<string, string>();
  for (const match of matches) {
    const key = process.platform === 'win32' ? match.repositoryFile.toLowerCase() : match.repositoryFile;
    const priorAbsolute = absoluteByFile.get(key);
    if (priorAbsolute && pathIdentity(priorAbsolute) !== pathIdentity(match.absoluteFile)) {
      throw new Error(`AST_REWRITE_PATH_ALIAS: ${match.repositoryFile} resolved to multiple files.`);
    }
    absoluteByFile.set(key, match.absoluteFile);
    const bucket = byFile.get(key) ?? [];
    bucket.push(match);
    byFile.set(key, bucket);
  }
  if (byFile.size > MAX_AST_REWRITE_FILES) {
    throw new Error(`ast_rewrite touches ${byFile.size} files; maximum is ${MAX_AST_REWRITE_FILES}. Narrow the rule.`);
  }
  const [canonicalProject, canonicalRepo] = await Promise.all([
    runWithAbortableTimeout(
      (_signal) => fs.realpath(projectFolder),
      remaining(deadlineAt, 'ast rewrite project realpath'),
      `Resolve ast rewrite project ${projectFolder}`,
    ),
    runWithAbortableTimeout(
      (_signal) => fs.realpath(repoRoot),
      remaining(deadlineAt, 'ast rewrite repository realpath'),
      `Resolve ast rewrite repository ${repoRoot}`,
    ),
  ]);
  const prepared: PreparedAstGrepRewriteFile[] = [];
  let totalBytes = 0;
  for (const edits of byFile.values()) {
    const first = edits[0];
    const valid = await validatePath(first.absoluteFile, remaining(deadlineAt, 'ast rewrite file validation'));
    const lstat = await runWithAbortableTimeout((_signal) => fs.lstat(valid), remaining(deadlineAt, 'ast rewrite lstat'), `Inspect ast rewrite file ${valid}`);
    if (!lstat.isFile() || lstat.isSymbolicLink()) throw new Error(`ast_rewrite only accepts regular files: ${first.repositoryFile}`);
    if (lstat.size > MAX_AST_REWRITE_FILE_BYTES) {
      throw new Error(`ast_rewrite file exceeds ${MAX_AST_REWRITE_FILE_BYTES} bytes: ${first.repositoryFile}`);
    }
    const canonical = await runWithAbortableTimeout((_signal) => fs.realpath(valid), remaining(deadlineAt, 'ast rewrite realpath'), `Resolve ast rewrite file ${valid}`);
    if (!isInside(canonicalProject, canonical) || !isInside(canonicalRepo, canonical)) {
      throw new Error(`ast_rewrite path escapes its project/repository through an alias: ${first.repositoryFile}`);
    }
    const before = await runWithAbortableTimeout(
      (signal) => readFileBounded(valid, MAX_AST_REWRITE_FILE_BYTES, signal, 'ast rewrite input'),
      remaining(deadlineAt, 'ast rewrite read'),
      `Read ast rewrite file ${first.repositoryFile}`,
    );
    totalBytes += before.length;
    if (totalBytes > MAX_AST_REWRITE_TOTAL_BYTES) {
      throw new Error(`ast_rewrite matched files exceed ${MAX_AST_REWRITE_TOTAL_BYTES} total bytes. Narrow the rule.`);
    }
    if (before.includes(0)) {
      throw new Error(`ast_rewrite does not accept NUL-containing/binary source files: ${first.repositoryFile}`);
    }
    const decoded = before.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(before)) {
      throw new Error(`ast_rewrite requires UTF-8 source files: ${first.repositoryFile}`);
    }
    const after = applyByteRewrites(before, edits, first.repositoryFile);
    if (after.equals(before)) continue;
    prepared.push({
      relative: first.repositoryFile,
      absolute: valid,
      before,
      after,
      beforeHash: crypto.createHash('sha256').update(before).digest('hex'),
      afterHash: crypto.createHash('sha256').update(after).digest('hex'),
    });
  }
  return prepared.sort((a, b) => a.relative.localeCompare(b.relative));
}

function normalizeNoIndexPatchPaths(patchText: string, expectedFiles: string[]): string {
  const identity = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const expected = new Map(expectedFiles.map((file) => [identity(file), file]));
  const parseHeaderPath = (line: string, prefix: string) => {
    const payload = line.slice(prefix.length);
    const tab = payload.indexOf('\t');
    return { path: tab >= 0 ? payload.slice(0, tab) : payload, suffix: tab >= 0 ? payload.slice(tab) : '' };
  };
  const canonical = (raw: string) => {
    const file = expected.get(identity(raw));
    if (!file) throw new Error(`AST_REWRITE_PATCH_FILESET_MISMATCH: preview diff referenced unexpected file ${raw}.`);
    return file;
  };
  const lines = patchText.split(/\r?\n/);
  return lines.map((line, index) => {
    if (line.startsWith('--- a/before/')) {
      const parsed = parseHeaderPath(line, '--- a/before/');
      return `--- a/${canonical(parsed.path)}${parsed.suffix}`;
    }
    if (line.startsWith('+++ b/after/')) {
      const parsed = parseHeaderPath(line, '+++ b/after/');
      return `+++ b/${canonical(parsed.path)}${parsed.suffix}`;
    }
    if (!line.startsWith('diff --git a/before/')) return line;
    const sourceHeader = lines.slice(index + 1, index + 4).find((candidate) => candidate.startsWith('--- a/before/'));
    if (!sourceHeader) throw new Error(`Unexpected git --no-index header without source marker: ${line}`);
    const parsed = parseHeaderPath(sourceHeader, '--- a/before/');
    const file = canonical(parsed.path);
    return `diff --git a/${file} b/${file}`;
  }).join('\n');
}

async function ensureRewritePreviewDirectory(
  directory: string, tempRoot: string, deadlineAt: number,
): Promise<void> {
  const pending = fs.mkdir(directory, { recursive: true });
  try {
    await runWithAbortableTimeout(
      (_signal) => pending,
      remaining(deadlineAt, 'ast rewrite temp directory creation'),
      `Create ast rewrite preview directory ${directory}`,
    );
  } catch (error) {
    // mkdir itself is not AbortSignal-aware. If it finishes after our deadline,
    // schedule a second cleanup so a late directory cannot recreate tempRoot.
    void pending.catch(() => undefined).finally(() => fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined));
    throw error;
  }
}

async function buildRewritePatch(files: PreparedAstGrepRewriteFile[], deadlineAt: number): Promise<string> {
  if (files.length === 0) return '';
  const tempRoot = await runWithAbortableTimeout(
    (_signal) => fs.mkdtemp(path.join(os.tmpdir(), 'dc-ast-rewrite-')),
    remaining(deadlineAt, 'ast rewrite temp directory'),
    'Create ast rewrite preview directory',
  );
  try {
    for (const file of files) {
      for (const [side, bytes] of [['before', file.before], ['after', file.after]] as const) {
        const target = path.join(tempRoot, side, ...file.relative.split('/'));
        await ensureRewritePreviewDirectory(path.dirname(target), tempRoot, deadlineAt);
        await runWithAbortableTimeout(
          (signal) => fs.writeFile(target, bytes, { signal }),
          remaining(deadlineAt, 'ast rewrite temp write'),
          `Write ast rewrite ${side} ${file.relative}`,
        );
      }
    }
    const gitExecutable = process.platform === 'win32' ? 'git.exe' : 'git';
    const diff = await runBoundedSubprocess(gitExecutable, [
      '-c', 'core.quotePath=false',
      'diff', '--no-index', '--text', '--no-ext-diff',
      '--src-prefix=a/', '--dst-prefix=b/', '--', 'before', 'after',
    ], {
      cwd: tempRoot,
      timeoutMs: remaining(deadlineAt, 'ast rewrite patch generation'),
      maxOutputBytes: MAX_AST_REWRITE_PATCH_BYTES + 64 * 1024,
      label: 'git diff for ast rewrite preview',
    });
    if (diff.exitCode !== 0 && diff.exitCode !== 1) {
      throw new Error(`Could not generate ast rewrite patch: ${boundedDiagnostic(diff.stderr || diff.stdout)}`);
    }
    const patch = normalizeNoIndexPatchPaths(diff.stdout, files.map((file) => file.relative));
    if (Buffer.byteLength(patch, 'utf8') > MAX_AST_REWRITE_PATCH_BYTES) {
      throw new Error(`ast_rewrite patch exceeds ${MAX_AST_REWRITE_PATCH_BYTES} bytes. Narrow the rule.`);
    }
    return patch;
  } finally {
    const cleanup = fs.rm(tempRoot, { recursive: true, force: true });
    await runWithAbortableTimeout(
      (_signal) => cleanup,
      Math.max(100, Math.min(2_000, deadlineAt - Date.now())),
      'Clean ast rewrite preview directory',
    ).catch(() => { void cleanup.catch(() => undefined); });
  }
}

export async function prepareAstGrepRewrite(
  args: Record<string, unknown>,
  timeoutMs = AST_GREP_TIMEOUT_MS,
): Promise<PreparedAstGrepRewrite> {
  const requestedTimeout = boundedInteger(args.timeout_ms, timeoutMs, 100, 60_000, 'timeout_ms');
  const deadlineAt = Date.now() + Math.min(requestedTimeout, timeoutMs);
  const maxResults = boundedInteger(args.max_results, 100, 1, MAX_AST_GREP_RESULTS, 'max_results');
  const maxPatchChars = boundedInteger(
    args.max_patch_chars, DEFAULT_AST_REWRITE_PATCH_PREVIEW_CHARS, 1, MAX_AST_REWRITE_PATCH_PREVIEW_CHARS, 'max_patch_chars',
  );
  const projectFolder = await resolveProjectFolder(args.project_folder, deadlineAt);
  const repoRoot = await resolveRewriteRepositoryRoot(projectFolder, deadlineAt);
  const rule = buildRewriteRules(args);
  const scan = await runRewriteScan(projectFolder, rule.inlineRules, maxResults, deadlineAt);
  const matches = parseRewriteMatches(scan.stdout, projectFolder, repoRoot);
  if (matches.length > maxResults) {
    const error = new Error(`AST_REWRITE_MATCH_LIMIT_EXCEEDED: more than ${maxResults} matches; no partial rewrite preview was produced.`) as NodeJS.ErrnoException;
    error.code = 'ERESULTLIMIT';
    throw error;
  }
  const files = await prepareRewriteFiles(matches, projectFolder, repoRoot, deadlineAt);
  if (args.dry_run === false && matches.length > 0) {
    const verificationScan = await runRewriteScan(projectFolder, rule.inlineRules, maxResults, deadlineAt);
    const verificationMatches = parseRewriteMatches(verificationScan.stdout, projectFolder, repoRoot);
    if (verificationMatches.length > maxResults) {
      throw new Error(`AST_REWRITE_MATCH_LIMIT_EXCEEDED: more than ${maxResults} matches during apply revalidation.`);
    }
    if (rewriteMatchSetHash(verificationMatches) !== rewriteMatchSetHash(matches)) {
      throw new Error('AST_REWRITE_SCAN_CHANGED: structural matches changed while apply preview was being prepared.');
    }
    await verifyPreparedRewriteSources(files, deadlineAt);
  }
  const patch = await buildRewritePatch(files, deadlineAt);
  const expectedFiles = files.map((file) => file.relative);
  const expectedHashes = Object.fromEntries(files.map((file) => [file.relative, `sha256:${file.beforeHash}`]));
  const ruleHash = `sha256:${crypto.createHash('sha256').update(rule.inlineRules).digest('hex')}`;
  const patchHash = `sha256:${crypto.createHash('sha256').update(patch).digest('hex')}`;
  const previewId = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    version: 1,
    repositoryRoot: normalizeSlash(repoRoot),
    projectFolder: normalizeSlash(projectFolder),
    ruleHash, patchHash, expectedHashes,
  })).digest('hex')}`;
  const patchTruncated = patch.length > maxPatchChars;
  const patchPreview = patchTruncated
    ? `${patch.slice(0, maxPatchChars)}\n[AST rewrite patch preview truncated: ${patch.length - maxPatchChars} chars omitted]`
    : patch;
  const matchDetailLimit = 30;
  const publicMatches = matches.slice(0, matchDetailLimit).map((match) => ({
    file: match.repositoryFile,
    line: match.line,
    column: match.column,
    endLine: match.endLine,
    endColumn: match.endColumn,
    text: match.text.length > 300 ? `${match.text.slice(0, 300)}…` : match.text,
    replacement: match.replacement.length > 300 ? `${match.replacement.slice(0, 300)}…` : match.replacement,
    ...(match.ruleId ? { ruleId: match.ruleId } : {}),
  }));
  const matchDetailsTruncated = matches.length > matchDetailLimit;
  return {
    patch, expectedFiles, expectedHashes, files,
    publicResult: {
      repositoryRoot: normalizeSlash(repoRoot),
      projectFolder: normalizeSlash(projectFolder),
      engine: 'ast-grep',
      ruleMode: rule.mode,
      dryRun: true,
      changed: expectedFiles.length > 0,
      returnedMatches: matches.length,
      changedFiles: expectedFiles,
      matches: publicMatches,
      matchDetailsTruncated,
      omittedMatchDetails: Math.max(0, matches.length - publicMatches.length),
      patchPreview,
      patchChars: patch.length,
      patchTruncated,
      requiresTruncatedPreviewAcknowledgement: patchTruncated || matchDetailsTruncated,
      patchHash,
      ruleHash,
      previewId,
      applyExpectedFiles: expectedFiles,
      applyExpectedHashes: expectedHashes,
      previewSourceUnchanged: true,
      ...(scan.stderr.trim() ? { warning: scan.stderr.trim().slice(0, 4000) } : {}),
      note: expectedFiles.length > 0
        ? 'Preview only. To apply, call ast_rewrite again with dry_run=false, this previewId as expected_preview_id, and the exact applyExpectedFiles.'
        : 'No source changes are produced by this rewrite.',
    },
  };
}

export const AST_GREP_ACCELERATOR_TOOLS = [
  {
    name: 'ast_search',
    purpose: 'Run bounded syntax-aware structural search with ast-grep and return compact file/position matches.',
    when_to_use: 'When grep creates formatting false positives or too many follow-up reads.',
    when_not_to_use: 'For type-aware symbol identity, definitions, references, or implementations; use Serena/LSP.',
    readOnly: true,
    mutating: false,
    inputSchema: {
      type: 'object',
      required: ['project_folder', 'pattern', 'language'],
      additionalProperties: false,
      properties: {
        project_folder: { type: 'string' },
        pattern: { type: 'string', minLength: 1 },
        language: { type: 'string', minLength: 1 },
        max_results: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        output_format: { type: 'string', enum: ['text', 'json'], default: 'text' },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 60000, default: 30000 },
      },
    },
    recommended_workflow: [
      'Use workspace_snapshot first for repository-scoped work.',
      'Reduce candidate files with ast_search before reading them.',
      'Escalate exact symbol/reference identity to Serena.',
    ],
    related_capabilities: ['Serena references/implementations', 'start_search', 'ast_rule_search'],
  },
  {
    name: 'ast_rule_search',
    purpose: 'Run bounded ast-grep YAML rules for relational and compound structural queries.',
    when_to_use: 'For inside/has/not/any/all structural constraints beyond a single pattern.',
    when_not_to_use: 'For semantic type resolution or mutation; this capability is search-only.',
    readOnly: true,
    mutating: false,
    inputSchema: {
      type: 'object',
      required: ['project_folder', 'yaml'],
      additionalProperties: false,
      properties: {
        project_folder: { type: 'string' },
        yaml: { type: 'string', minLength: 1 },
        max_results: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        output_format: { type: 'string', enum: ['text', 'json'], default: 'text' },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 60000, default: 30000 },
      },
    },
    recommended_workflow: [
      'Keep the rule and max_results narrow.',
      'Inspect only returned locations.',
      'Use Serena where symbol identity matters.',
    ],
    related_capabilities: ['ast_search', 'Serena diagnostics/references', 'start_search'],
  },
  {
    name: 'ast_rewrite',
    purpose: 'Preview bounded ast-grep structural rewrites and apply byte-exact post-images through the existing Desktop Commander Workspace mutation owner.',
    when_to_use: 'For repeated syntax-shaped codemods where textual replacement is risky.',
    when_not_to_use: 'For semantic rename or type-aware refactoring; use Serena/LSP.',
    readOnly: false,
    mutating: true,
    inputSchema: {
      type: 'object',
      required: ['project_folder'],
      additionalProperties: false,
      oneOf: [
        { required: ['pattern', 'rewrite', 'language'], not: { required: ['yaml'] } },
        {
          required: ['yaml'],
          not: { anyOf: [{ required: ['pattern'] }, { required: ['rewrite'] }, { required: ['language'] }] },
        },
      ],
      allOf: [{
        if: { required: ['dry_run'], properties: { dry_run: { const: false } } },
        then: { required: ['expected_preview_id', 'expected_files'] },
      }],
      properties: {
        project_folder: { type: 'string' },
        pattern: { type: 'string', minLength: 1 },
        rewrite: { type: 'string' },
        language: { type: 'string', minLength: 1 },
        yaml: { type: 'string', minLength: 1 },
        max_results: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
        max_patch_chars: { type: 'integer', minimum: 1, maximum: 500000, default: 60000 },
        dry_run: { type: 'boolean', default: true },
        allow_truncated_preview: { type: 'boolean', default: false },
        expected_preview_id: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
        expected_files: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 60000, default: 30000 },
      },
    },
    recommended_workflow: [
      'Preview with dry_run=true.',
      'Apply only with the returned previewId and exact applyExpectedFiles; if preview content was truncated, explicitly set allow_truncated_preview=true.',
      'The apply path regenerates the structural preview, revalidates the exact file set/hashes, then commits byte-exact post-images under one multi-file Workspace mutation lock.',
      'Run focused verification after application.',
    ],
    related_capabilities: ['ast_search', 'ast_rule_search', 'apply_patch preview semantics', 'edit_file', 'Serena refactoring'],
  },
];

export async function callAstGrepAcceleratorTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (tool) {
    case 'ast_search':
      return astSearch(args);
    case 'ast_rule_search':
      return astRuleSearch(args);
    default:
      throw new Error(`Unknown ast-grep accelerator '${tool}'.`);
  }
}
