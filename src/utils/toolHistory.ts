import { ServerResult } from '../types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';

export interface ToolCallRecord {
  timestamp: string;
  toolName: string;
  arguments: any;
  output: ServerResult;
  duration?: number;
}

interface FormattedToolCallRecord extends Omit<ToolCallRecord, 'timestamp'> {
  timestamp: string; // formatted local time string
}

// Format timestamp in local timezone for display
function formatLocalTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

export class ToolHistory {
  private history: ToolCallRecord[] = [];
  private readonly MAX_ENTRIES = 1000;
  private readonly MAX_WRITE_QUEUE_ENTRIES = 1000;
  private readonly MAX_STORED_ARGUMENT_BYTES = 8 * 1024;
  private readonly MAX_ARGUMENT_STRING_CHARS = 512;
  private readonly MAX_ARGUMENT_DEPTH = 8;
  private readonly MAX_ARGUMENT_NODES = 500;
  // History is diagnostic telemetry, not a result cache: raw arguments/output
  // are redacted or summarized before they enter either memory or disk.
  private readonly MAX_HISTORY_FILE_SIZE_BYTES = 5 * 1024 * 1024;
  // When the file exceeds the cap we trim it down to this target instead of
  // all the way to zero, so a single overflow doesn't cause every subsequent
  // flush to re-trim.
  private readonly HISTORY_FILE_TRIM_TARGET_BYTES = 4 * 1024 * 1024;
  private readonly historyFile: string;
  private writeQueue: ToolCallRecord[] = [];
  private isWriting = false;
  private writeInterval?: NodeJS.Timeout;

  constructor() {
    // Store history in same directory as config to keep everything together
    const historyDir = path.join(os.homedir(), '.claude-server-commander');
    
    // Use append-only JSONL format (JSON Lines)
    this.historyFile = path.join(historyDir, 'tool-history.jsonl');

    // A remote-device child is a latency-sensitive tool host. Its MCP handshake
    // must not wait on diagnostic history I/O from a previous process. The normal
    // local product keeps historical startup loading; the remote child starts with
    // an empty in-memory history and persists new records asynchronously after the
    // bounded config bootstrap has prepared this directory.
    if (process.env.DC_REMOTE_DEVICE !== 'true') {
      if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir, { recursive: true });
      }
      this.loadFromDisk();
    }

    // Start async write processor
    this.startWriteProcessor();
  }

  /**
   * Load history from disk (all instances share the same file)
   */
  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.historyFile)) {
        return;
      }

      // If the file is over the cap, trim it down before reading so we
      // load a bounded amount.
      this.trimHistoryFileIfTooLarge();

      const content = fs.readFileSync(this.historyFile, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());

      // Parse each line as JSON
      const records: ToolCallRecord[] = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line));
        } catch (e) {
          // Silently skip invalid lines
        }
      }

      // Keep only last 1000 entries, and cap on the way IN as well as on the
      // way out. Entries written before the cap existed are still on disk and
      // are well under the whole-file trim threshold, so without this the cap
      // does nothing for anyone upgrading with an existing history file — i.e.
      // for everyone it was written for.
      this.history = records
        .slice(-this.MAX_ENTRIES)
        .map(record => ({
          ...record,
          arguments: this.sanitizeArguments(record.arguments),
          output: this.capOutput(record.output),
        }));

      // If file is getting too large, trim it
      if (lines.length > this.MAX_ENTRIES * 2) {
        this.trimHistoryFile();
      }
    } catch (error) {
      // Silently fail
    }
  }

  /**
   * Trim the on-disk history file to stay under the size cap by dropping the
   * oldest entries (lines) until the kept tail fits within the trim target.
   * Returns true only when the file was actually rewritten with a smaller
   * tail, so callers can fall through to their normal path on failure or
   * no-op rather than mutating in-memory state.
   *
   * Always keeps at least the most recent entry, even if a single record
   * exceeds the trim target — there is no useful state below that.
   */
  private trimHistoryFileIfTooLarge(): boolean {
    let stats: fs.Stats;
    try {
      if (!fs.existsSync(this.historyFile)) {
        return false;
      }
      stats = fs.statSync(this.historyFile);
      if (stats.size <= this.MAX_HISTORY_FILE_SIZE_BYTES) {
        return false;
      }
    } catch (error) {
      return false;
    }

    try {
      const content = fs.readFileSync(this.historyFile, 'utf-8');
      const lines = content.split('\n').filter(line => line.length > 0);
      if (lines.length === 0) {
        return false;
      }

      // Walk lines from newest to oldest, accumulating bytes (line + '\n'),
      // and keep as many as fit within the trim target. Always keep at
      // least the last line.
      const kept: string[] = [];
      let bytes = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + 1; // +1 for '\n'
        if (kept.length > 0 && bytes + lineBytes > this.HISTORY_FILE_TRIM_TARGET_BYTES) {
          break;
        }
        kept.push(lines[i]);
        bytes += lineBytes;
      }
      kept.reverse();

      fs.writeFileSync(this.historyFile, kept.join('\n') + '\n', 'utf-8');
      return true;
    } catch (error) {
      // Trim failed; do not claim the file was changed.
      return false;
    }
  }

  private async trimHistoryFileIfTooLargeAsync(): Promise<void> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(this.historyFile);
      if (stats.size <= this.MAX_HISTORY_FILE_SIZE_BYTES) return;
      const content = await fs.promises.readFile(this.historyFile, 'utf-8');
      const lines = content.split('\n').filter(line => line.length > 0);
      if (lines.length === 0) return;
      const kept: string[] = [];
      let bytes = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + 1;
        if (kept.length > 0 && bytes + lineBytes > this.HISTORY_FILE_TRIM_TARGET_BYTES) break;
        kept.push(lines[i]);
        bytes += lineBytes;
      }
      kept.reverse();
      await fs.promises.writeFile(this.historyFile, kept.join('\n') + '\n', 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }

  /**
   * Trim history file to prevent it from growing indefinitely
   */
  private trimHistoryFile(): void {
    try {
      // Keep last 1000 entries in memory
      const keepEntries = this.history.slice(-this.MAX_ENTRIES);

      // Write them back
      const lines = keepEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
      fs.writeFileSync(this.historyFile, lines, 'utf-8');
    } catch (error) {
      // Silently fail
    }
  }

  /**
   * Async write processor - batches writes to avoid blocking
   */
  private startWriteProcessor(): void {
    this.writeInterval = setInterval(() => {
      if (this.writeQueue.length > 0 && !this.isWriting) {
        this.flushToDisk();
      }
    }, 1000); // Flush every second
    
    // Prevent interval from keeping process alive during shutdown/tests
    this.writeInterval.unref();
  }

  /**
   * Flush queued writes to disk
   */
  private async flushToDisk(): Promise<void> {
    if (this.isWriting || this.writeQueue.length === 0) return;

    this.isWriting = true;
    const toWrite = [...this.writeQueue];
    this.writeQueue = [];

    try {
      // If the on-disk file has grown past the cap, trim it down to the
      // target size (keeping the most recent entries) before appending.
      // The in-memory cache is unaffected — it is already bounded by
      // MAX_ENTRIES via addCall.
      await this.trimHistoryFileIfTooLargeAsync();

      // Keep diagnostic persistence off the event loop so a slow history disk
      // cannot stall unrelated MCP response serialization/delivery.
      const lines = toWrite.map(entry => JSON.stringify(entry)).join('\n') + '\n';
      await fs.promises.appendFile(this.historyFile, lines, 'utf-8');
    } catch (error) {
      // Put back in queue on failure, but keep diagnostic history bounded even
      // during a persistent disk error. Oldest pending records are expendable.
      this.writeQueue.unshift(...toWrite);
      if (this.writeQueue.length > this.MAX_WRITE_QUEUE_ENTRIES) {
        this.writeQueue.splice(0, this.writeQueue.length - this.MAX_WRITE_QUEUE_ENTRIES);
      }
    } finally {
      this.isWriting = false;
    }
  }

  private historyMarker(label: string, value: string): string {
    const bytes = Buffer.byteLength(value, 'utf8');
    const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
    return `[${label} omitted from history: ${bytes} bytes, sha256:${digest}]`;
  }

  private redactInlineSecrets(value: string): string {
    return value
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[=:]\s*)([^\s"'&]+)/gi, '$1<redacted>')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi, '$1<redacted>');
  }

  private sanitizeArguments(args: unknown): unknown {
    const sensitiveKeys = new Set([
      'token', 'accesstoken', 'refreshtoken', 'claimtoken', 'authtoken', 'bearertoken',
      'apitoken', 'idtoken', 'password', 'passwd', 'secret', 'apikey', 'authorization',
      'cookie', 'privatekey', 'credential', 'credentials',
    ]);
    const payloadKeys = new Set([
      'content', 'oldstring', 'newstring', 'oldtext', 'newtext', 'patch', 'code',
      'stdin', 'data', 'blob', 'markdown',
    ]);
    const seen = new WeakSet<object>();
    let nodes = 0;
    const normalizeKey = (key: string) => key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const walk = (value: unknown, key: string, depth: number): unknown => {
      nodes += 1;
      if (nodes > this.MAX_ARGUMENT_NODES || depth > this.MAX_ARGUMENT_DEPTH) return '[history structure truncated]';
      const normalizedKey = normalizeKey(key);
      if (sensitiveKeys.has(normalizedKey)) return '[redacted]';
      if (typeof value === 'string') {
        if (payloadKeys.has(normalizedKey)) return this.historyMarker('payload', value);
        const redacted = this.redactInlineSecrets(value);
        return redacted.length > this.MAX_ARGUMENT_STRING_CHARS
          ? this.historyMarker('string', redacted)
          : redacted;
      }
      if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof value === 'bigint') return value.toString();
      if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return `[binary payload omitted from history: ${value.byteLength} bytes]`;
      }
      if (Array.isArray(value)) {
        if (seen.has(value)) return '[circular value omitted]';
        seen.add(value);
        return value.slice(0, 50).map((item) => walk(item, '', depth + 1));
      }
      if (typeof value === 'object' && value) {
        if (seen.has(value)) return '[circular value omitted]';
        seen.add(value);
        const out: Record<string, unknown> = {};
        for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
          out[childKey] = walk(childValue, childKey, depth + 1);
        }
        return out;
      }
      return `[${typeof value} omitted from history]`;
    };

    const sanitized = walk(args, '', 0);
    let serialized: string;
    try { serialized = JSON.stringify(sanitized) ?? ''; }
    catch { return { _history: '[arguments omitted: unserialisable]' }; }
    if (Buffer.byteLength(serialized, 'utf8') <= this.MAX_STORED_ARGUMENT_BYTES) return sanitized;
    return { _history: this.historyMarker('arguments', serialized) };
  }

  /**
   * Build a diagnostic output marker without materializing JSON.stringify(output).
   * Large tool results often contain one or two very large text fields; hashing
   * those strings incrementally avoids a second multi-megabyte temporary string
   * and the associated event-loop/GC spike on the result-delivery path.
   */
  private outputHistoryMarker(output: ServerResult): string {
    const digest = createHash('sha256');
    let payloadBytes = 0;
    const feed = (label: string, value: string) => {
      digest.update(label);
      digest.update('\0');
      digest.update(value);
      digest.update('\0');
      payloadBytes += Buffer.byteLength(value, 'utf8');
    };

    const content = Array.isArray(output?.content) ? output.content : [];
    const maxContentItems = 2048;
    for (let index = 0; index < Math.min(content.length, maxContentItems); index++) {
      const item = content[index] as unknown as Record<string, unknown>;
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      if (typeof item.type === 'string') feed('type', item.type);
      if (typeof item.text === 'string') feed('text', item.text);
      if (typeof item.data === 'string') feed('data', item.data);
      const resource = item.resource;
      if (resource && typeof resource === 'object' && !Array.isArray(resource)) {
        const record = resource as Record<string, unknown>;
        if (typeof record.text === 'string') feed('resource.text', record.text);
        if (typeof record.blob === 'string') feed('resource.blob', record.blob);
      }
    }
    if (content.length > maxContentItems) feed('content.truncated', String(content.length - maxContentItems));

    const structured = (output as any)?.structuredContent;
    if (structured !== undefined) {
      // sanitizeArguments is cardinality/depth/string bounded; serializing this
      // reduced representation is cheap even when structuredContent is huge.
      try {
        const reduced = JSON.stringify(this.sanitizeArguments(structured)) ?? '';
        feed('structured', reduced);
      } catch {
        feed('structured', '[unserialisable]');
      }
    }
    feed('isError', (output as any)?.isError === true ? 'true' : 'false');
    return `[tool output omitted from history: ${payloadBytes} bytes, sha256:${digest.digest('hex').slice(0, 16)}]`;
  }

  /** Keep result shape/error status, but never persist raw tool output. */
  private capOutput(output: ServerResult): ServerResult {
    const marker = this.outputHistoryMarker(output);
    return {
      ...((output as any)?.isError ? { isError: true } : {}),
      content: [{ type: 'text', text: marker }],
    } as ServerResult;
  }

  /** Add a tool call to diagnostic history. */

  addCall(
    toolName: string,
    args: any,
    output: ServerResult,
    duration?: number
  ): void {
    const record: ToolCallRecord = {
      timestamp: new Date().toISOString(),
      toolName,
      arguments: this.sanitizeArguments(args),
      output: this.capOutput(output),
      duration
    };

    this.history.push(record);

    // Keep only last 1000 in memory
    if (this.history.length > this.MAX_ENTRIES) {
      this.history.shift();
    }
    
    // Queue for async write; diagnostic history must not become durable-work
    // backpressure if the history file is temporarily unwritable.
    this.writeQueue.push(record);
    if (this.writeQueue.length > this.MAX_WRITE_QUEUE_ENTRIES) {
      this.writeQueue.splice(0, this.writeQueue.length - this.MAX_WRITE_QUEUE_ENTRIES);
    }
  }

  /**
   * Get recent tool calls with filters
   */
  getRecentCalls(options: {
    maxResults?: number;
    toolName?: string;
    since?: string;
  }): ToolCallRecord[] {
    let results = [...this.history];

    // Filter by tool name
    if (options.toolName) {
      results = results.filter(r => r.toolName === options.toolName);
    }

    // Filter by timestamp
    if (options.since) {
      const sinceDate = new Date(options.since);
      results = results.filter(r => new Date(r.timestamp) >= sinceDate);
    }

    // Limit results (default 50, max 1000)
    const limit = Math.min(options.maxResults || 50, 1000);
    return results.slice(-limit);
  }

  /**
   * Get recent calls formatted with local timezone
   */
  getRecentCallsFormatted(options: {
    maxResults?: number;
    toolName?: string;
    since?: string;
  }): FormattedToolCallRecord[] {
    const calls = this.getRecentCalls(options);
    
    // Format timestamps to local timezone
    return calls.map(call => ({
      ...call,
      timestamp: formatLocalTimestamp(call.timestamp)
    }));
  }

  /**
   * Get current stats
   */
  getStats() {
    return {
      totalEntries: this.history.length,
      oldestEntry: this.history[0]?.timestamp,
      newestEntry: this.history[this.history.length - 1]?.timestamp,
      historyFile: this.historyFile,
      queuedWrites: this.writeQueue.length
    };
  }

  /**
   * Cleanup method - clears interval and flushes pending writes
   * Call this during shutdown or in tests
   */
  async cleanup(): Promise<void> {
    // Clear the interval
    if (this.writeInterval) {
      clearInterval(this.writeInterval);
      this.writeInterval = undefined;
    }
    
    // Flush any remaining writes
    if (this.writeQueue.length > 0) {
      await this.flushToDisk();
    }
  }
}

export const toolHistory = new ToolHistory();
