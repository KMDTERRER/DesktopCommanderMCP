import { StringDecoder } from 'string_decoder';
import iconv from 'iconv-lite';
import { runBoundedSubprocess } from './bounded-subprocess.js';
import type { OutputDecodingInfo } from '../types.js';

export interface ProcessOutputDecoder {
  write(data: Buffer): string;
  end(): string;
  diagnostics(): OutputDecodingInfo;
}

type WindowsCodePageProfile = {
  oemCodePage?: number;
  ansiCodePage?: number;
  oemEncoding?: string;
  ansiEncoding?: string;
  probeWarning?: string;
};

const CODE_PAGE_PROBE_TIMEOUT_MS = 5_000;
const CODE_PAGE_PROBE_OUTPUT_BYTES = 16 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;
let windowsProfilePromise: Promise<WindowsCodePageProfile> | undefined;
function encodingForCodePage(codePage: number | undefined): string | undefined {
  if (!codePage) return undefined;
  if (codePage === 65001) return 'utf8';
  const name = `cp${codePage}`;
  return iconv.encodingExists(name) ? name : undefined;
}

function parseCodePageNumbers(output: string): number[] {
  return (output.match(/\b\d{3,5}\b/g) ?? [])
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0 && value <= 65535);
}

async function probeWindowsCodePages(): Promise<WindowsCodePageProfile> {
  try {
    const result = await runBoundedSubprocess('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding.CodePage; [System.Text.Encoding]::Default.CodePage',
    ], {
      timeoutMs: CODE_PAGE_PROBE_TIMEOUT_MS,
      maxOutputBytes: CODE_PAGE_PROBE_OUTPUT_BYTES,
      label: 'Windows output code-page probe',
    });
    if (result.exitCode !== 0) throw new Error(`probe exited ${result.exitCode}`);
    const [oemCodePage, ansiCodePage] = parseCodePageNumbers(result.stdout);
    if (!oemCodePage || !ansiCodePage) throw new Error(`unexpected probe output: ${result.stdout.trim()}`);
    return {
      oemCodePage, ansiCodePage,
      oemEncoding: encodingForCodePage(oemCodePage),
      ansiEncoding: encodingForCodePage(ansiCodePage),
    };
  } catch (error) {
    return { probeWarning: error instanceof Error ? error.message : String(error) };
  }
}
function windowsProfile(): Promise<WindowsCodePageProfile> {
  windowsProfilePromise ??= probeWindowsCodePages();
  return windowsProfilePromise;
}

class Utf8OutputDecoder implements ProcessOutputDecoder {
  private readonly decoder = new StringDecoder('utf8');
  write(data: Buffer): string { return this.decoder.write(data); }
  end(): string { return this.decoder.end(); }
  diagnostics(): OutputDecodingInfo { return { mode: 'utf8', usedEncodings: ['utf8'] }; }
}

function validUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

type Utf8PrefixStatus = 'complete' | 'incomplete' | 'invalid';

function utf8PrefixStatus(bytes: Buffer): Utf8PrefixStatus {
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index];
    if (lead <= 0x7f) { index += 1; continue; }

    let needed: number;
    let secondMin = 0x80;
    let secondMax = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) needed = 1;
    else if (lead === 0xe0) { needed = 2; secondMin = 0xa0; }
    else if (lead >= 0xe1 && lead <= 0xec) needed = 2;
    else if (lead === 0xed) { needed = 2; secondMax = 0x9f; }
    else if (lead >= 0xee && lead <= 0xef) needed = 2;
    else if (lead === 0xf0) { needed = 3; secondMin = 0x90; }
    else if (lead >= 0xf1 && lead <= 0xf3) needed = 3;
    else if (lead === 0xf4) { needed = 3; secondMax = 0x8f; }
    else return 'invalid';

    const available = bytes.length - index - 1;
    const inspect = Math.min(needed, available);
    for (let offset = 1; offset <= inspect; offset += 1) {
      const byte = bytes[index + offset];
      const min = offset === 1 ? secondMin : 0x80;
      const max = offset === 1 ? secondMax : 0xbf;
      if (byte < min || byte > max) return 'invalid';
    }
    if (available < needed) return 'incomplete';
    index += needed + 1;
  }
  return 'complete';
}

function legacyPenalty(text: string): number {
  let penalty = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0xfffd) penalty += 100;
    else if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) penalty += 40;
    else if (code >= 0x2500 && code <= 0x259f) penalty += 10;
  }
  return penalty;
}

function allAscii(bytes: Buffer): boolean {
  for (const byte of bytes) if (byte >= 0x80) return false;
  return true;
}
class WindowsAdaptiveOutputDecoder implements ProcessOutputDecoder {
  private pending = Buffer.alloc(0);
  private readonly used = new Set<string>();

  constructor(private readonly profile: WindowsCodePageProfile) {}

  private decodeSegment(bytes: Buffer): string {
    if (bytes.length === 0) return '';
    if (allAscii(bytes)) {
      this.used.add('ascii');
      return bytes.toString('ascii');
    }
    const utf8 = validUtf8(bytes);
    if (utf8 !== null) {
      this.used.add('utf8');
      return utf8;
    }

    const candidates = [this.profile.oemEncoding, this.profile.ansiEncoding]
      .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
    if (candidates.length === 0) {
      this.used.add('utf8-fallback');
      return bytes.toString('utf8');
    }
    let selected = candidates[0];
    let selectedText = iconv.decode(bytes, selected);
    let selectedPenalty = legacyPenalty(selectedText);
    for (const encoding of candidates.slice(1)) {
      const text = iconv.decode(bytes, encoding);
      const penalty = legacyPenalty(text);
      if (penalty < selectedPenalty) {
        selected = encoding;
        selectedText = text;
        selectedPenalty = penalty;
      }
    }
    this.used.add(selected);
    return selectedText;
  }
  write(data: Buffer): string {
    if (data.length === 0) return '';
    this.pending = this.pending.length === 0 ? Buffer.from(data) : Buffer.concat([this.pending, data]);
    let output = '';
    let newline = this.pending.indexOf(0x0a);
    while (newline >= 0) {
      output += this.decodeSegment(this.pending.subarray(0, newline + 1));
      this.pending = this.pending.subarray(newline + 1);
      newline = this.pending.indexOf(0x0a);
    }

    if (this.pending.length > 0) {
      const utf8Status = allAscii(this.pending) ? 'complete' : utf8PrefixStatus(this.pending);
      if (utf8Status === 'complete' || utf8Status === 'invalid' || this.pending.length > MAX_PENDING_BYTES) {
        output += this.decodeSegment(this.pending);
        this.pending = Buffer.alloc(0);
      }
    }
    return output;
  }

  end(): string {
    const output = this.decodeSegment(this.pending);
    this.pending = Buffer.alloc(0);
    return output;
  }

  diagnostics(): OutputDecodingInfo {
    return {
      mode: 'windows-adaptive',
      usedEncodings: [...this.used].sort(),
      ...(this.profile.oemCodePage ? { oemCodePage: this.profile.oemCodePage } : {}),
      ...(this.profile.ansiCodePage ? { ansiCodePage: this.profile.ansiCodePage } : {}),
      ...(this.profile.probeWarning ? { probeWarning: this.profile.probeWarning } : {}),
    };
  }
}
export async function createProcessOutputDecoder(): Promise<ProcessOutputDecoder> {
  if (process.platform !== 'win32') return new Utf8OutputDecoder();
  return new WindowsAdaptiveOutputDecoder(await windowsProfile());
}

export function resetWindowsOutputDecodingProfileForTests(): void {
  windowsProfilePromise = undefined;
}

export function mergeOutputDecodingInfo(...values: OutputDecodingInfo[]): OutputDecodingInfo {
  const windows = values.find((value) => value.mode === 'windows-adaptive');
  const warnings = [...new Set(values.map((value) => value.probeWarning).filter((value): value is string => Boolean(value)))];
  return {
    mode: windows ? 'windows-adaptive' : 'utf8',
    usedEncodings: [...new Set(values.flatMap((value) => value.usedEncodings))].sort(),
    ...(windows?.oemCodePage ? { oemCodePage: windows.oemCodePage } : {}),
    ...(windows?.ansiCodePage ? { ansiCodePage: windows.ansiCodePage } : {}),
    ...(warnings.length > 0 ? { probeWarning: warnings.join('; ') } : {}),
  };
}
