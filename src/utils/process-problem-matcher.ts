export type ProcessProblemSeverity = 'error' | 'warning' | 'note' | 'remark';
export type ProcessProblemMatcher = 'gcc-clang' | 'msvc' | 'cmake' | 'ninja' | 'ctest' | 'linker';

export interface ProcessProblem {
  matcher: ProcessProblemMatcher;
  severity: ProcessProblemSeverity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
}

export interface ProcessProblemMatchResult {
  problems: ProcessProblem[];
  truncated: boolean;
  inspectedChars: number;
}

const MAX_INPUT_CHARS = 512 * 1024;
const MAX_PROBLEMS = 50;
const MAX_LINE_CHARS = 4096;
const MAX_MESSAGE_CHARS = 2048;

function clean(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\r$/, '');
}
function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function severity(value: string): ProcessProblemSeverity {
  const normalized = value.toLowerCase();
  if (normalized.includes('error') || normalized === 'failed' || normalized === 'timeout' || normalized === 'not run') return 'error';
  if (normalized.includes('warning')) return 'warning';
  if (normalized === 'remark') return 'remark';
  return 'note';
}

function positive(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function compactMessage(value: string): string {
  return bounded(value.trim().replace(/\s+/g, ' '), MAX_MESSAGE_CHARS);
}

function diagnosticContinuation(lines: string[], index: number): string {
  for (let cursor = index + 1; cursor < Math.min(lines.length, index + 4); cursor += 1) {
    const candidate = clean(lines[cursor]);
    if (!candidate.trim()) continue;
    if (!/^\s+/.test(candidate)) return '';
    return compactMessage(candidate);
  }
  return '';
}
function matchCompiler(line: string): ProcessProblem | null {
  const withColumn = line.match(/^(.+):(\d+):(\d+):\s*(fatal error|error|warning|note|remark):\s*(.+)$/i);
  if (withColumn) {
    return {
      matcher: 'gcc-clang', severity: severity(withColumn[4]),
      file: bounded(withColumn[1].trim(), MAX_LINE_CHARS), line: positive(withColumn[2]),
      column: positive(withColumn[3]), message: compactMessage(withColumn[5]),
    };
  }
  const lineOnly = line.match(/^(.+):(\d+):\s*(fatal error|error|warning|note|remark):\s*(.+)$/i);
  if (!lineOnly) return null;
  return {
    matcher: 'gcc-clang', severity: severity(lineOnly[3]),
    file: bounded(lineOnly[1].trim(), MAX_LINE_CHARS), line: positive(lineOnly[2]),
    message: compactMessage(lineOnly[4]),
  };
}

function matchMsvc(line: string): ProcessProblem | null {
  const located = line.match(/^(?:\d+>)?\s*(.+)\((\d+)(?:,(\d+))?\)\s*:\s*(fatal error|error|warning|note)\s+([A-Za-z]+\d+)\s*:\s*(.+)$/i);
  if (located) {
    return {
      matcher: 'msvc', severity: severity(located[4]),
      file: bounded(located[1].trim(), MAX_LINE_CHARS), line: positive(located[2]),
      ...(positive(located[3]) ? { column: positive(located[3]) } : {}),
      code: located[5], message: compactMessage(located[6]),
    };
  }
  const tool = line.match(/^(?:\d+>)?\s*([A-Za-z0-9_.+\-]+)\s*:\s*(fatal error|error|warning)\s+([A-Za-z]+\d+)\s*:\s*(.+)$/i);
  if (!tool) return null;
  return {
    matcher: /^(?:link|lib)$/i.test(tool[1]) ? 'linker' : 'msvc',
    severity: severity(tool[2]), code: tool[3], message: compactMessage(tool[4]),
  };
}
function matchCmake(lines: string[], index: number): ProcessProblem | null {
  const line = clean(lines[index]);
  const match = line.match(/^CMake (Error|Warning|Deprecation Warning)(?: at (.+?):(\d+)(?: \([^)]+\))?)?:\s*(.*)$/i);
  if (!match) return null;
  const inline = compactMessage(match[4]);
  const continuation = inline ? '' : diagnosticContinuation(lines, index);
  return {
    matcher: 'cmake', severity: severity(match[1]),
    ...(match[2] ? { file: bounded(match[2].trim(), MAX_LINE_CHARS) } : {}),
    ...(positive(match[3]) ? { line: positive(match[3]) } : {}),
    message: inline || continuation || match[1],
  };
}

function matchNinja(line: string): ProcessProblem | null {
  const match = line.match(/^ninja:\s*(error|warning):\s*(.+)$/i);
  if (!match) return null;
  return { matcher: 'ninja', severity: severity(match[1]), message: compactMessage(match[2]) };
}

function matchCtest(line: string): ProcessProblem | null {
  const match = line.match(/^\s*\d+\/\d+\s+Test\s+#\d+:\s+(.+?)\s+\.{2,}\*{3}(Failed|Timeout|Not Run)\b\s*(.*)$/i);
  if (!match) return null;
  const state = match[2].replace(/\s+/g, '_').toUpperCase();
  return {
    matcher: 'ctest', severity: 'error', code: `CTEST_${state}`,
    message: compactMessage(`${match[1]}: ${match[2]}${match[3] ? ` ${match[3]}` : ''}`),
  };
}

function matchLinker(line: string): ProcessProblem | null {
  const match = line.match(/^(?:.*[\\/])?(ld(?:\.exe)?|collect2):\s*(fatal error|error|warning):?\s*(.+)$/i);
  if (!match) return null;
  return { matcher: 'linker', severity: severity(match[2]), message: compactMessage(match[3]) };
}
export function matchProcessProblems(output: string): ProcessProblemMatchResult {
  const sourceTruncated = output.length > MAX_INPUT_CHARS;
  const boundedInput = sourceTruncated ? output.slice(-MAX_INPUT_CHARS) : output;
  const lines = boundedInput.split(/\n/);
  const problems: ProcessProblem[] = [];
  let problemLimitReached = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = bounded(clean(lines[index]), MAX_LINE_CHARS);
    if (!line.trim()) continue;
    const problem = matchCompiler(line)
      ?? matchMsvc(line)
      ?? matchCmake(lines, index)
      ?? matchNinja(line)
      ?? matchCtest(line)
      ?? matchLinker(line);
    if (!problem) continue;
    if (problems.length >= MAX_PROBLEMS) {
      problemLimitReached = true;
      break;
    }
    problems.push(problem);
  }

  return {
    problems,
    truncated: sourceTruncated || problemLimitReached,
    inspectedChars: boundedInput.length,
  };
}

export function processProblemEvidence(output: string): Record<string, unknown> {
  const matched = matchProcessProblems(output);
  if (matched.problems.length === 0 && !matched.truncated) return {};
  return {
    problems: matched.problems,
    problemsTruncated: matched.truncated,
    problemInputChars: matched.inspectedChars,
  };
}
