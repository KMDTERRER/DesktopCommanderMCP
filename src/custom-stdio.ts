import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import process from "node:process";
import { inspect } from "node:util";
import { parseMcpJsonRpcFrame, traceMcpStdio } from "./utils/mcp-stdio-trace.js";

type LogLevel = "emergency" | "alert" | "critical" | "error" | "warning" | "notice" | "info" | "debug";
const MAX_BUFFERED_LOG_MESSAGES = 128;
const MAX_LOG_NOTIFICATION_CHARS = 8 * 1024;
const VERBOSE_LOG_NOTIFICATIONS = process.env.DEBUG_MODE === 'true';

interface LogNotification {
  jsonrpc: "2.0";
  method: "notifications/message";
  params: {
    level: LogLevel;
    logger?: string;
    data: any;
  };
}

/**
 * Enhanced StdioServerTransport that wraps console output in valid JSON-RPC structures
 * instead of filtering them out. This prevents crashes while maintaining debug visibility.
 */
export class FilteredStdioServerTransport extends StdioServerTransport {
  private originalConsole: {
    log: typeof console.log;
    warn: typeof console.warn;
    error: typeof console.error;
    debug: typeof console.debug;
    info: typeof console.info;
  };
  private originalStdoutWrite: typeof process.stdout.write;
  private isInitialized: boolean = false;
  private messageBuffer: Array<{
    level: LogLevel;
    args: any[];
    timestamp: number;
  }> = [];
  private droppedBufferedMessages = 0;
  private clientName: string = 'unknown';
  private disableNotifications: boolean = false;

  constructor() {
    super();
    
    // Store original methods
    this.originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
      info: console.info,
    };
    
    this.originalStdoutWrite = process.stdout.write;
    
    // Setup console redirection
    this.setupConsoleRedirection();
    
    // Setup stdout filtering for any other output
    this.setupStdoutFiltering();
    
    // Note: We defer the initialization notification until enableNotifications() is called
    // to ensure MCP protocol compliance - notifications must not be sent before initialization
  }

  /**
   * Call this method after MCP initialization is complete to enable JSON-RPC notifications
   */
  public enableNotifications() {
    this.isInitialized = true;
    
    // Check if notifications should be disabled based on client
    if (this.disableNotifications) {
      // Clear buffer without sending - just log to stderr instead
      if (this.messageBuffer.length > 0) {
        process.stderr.write(`[INFO] ${this.messageBuffer.length} buffered messages suppressed for ${this.clientName}\n`);
      }
      this.messageBuffer = [];
      this.droppedBufferedMessages = 0;
      return;
    }
    
    if (VERBOSE_LOG_NOTIFICATIONS) {
      this.sendLogNotification('debug', ['Filtered stdio log notifications enabled']);
    }

    // Replay only bounded warning/error diagnostics retained before initialize.
    if (this.messageBuffer.length > 0) {
      this.messageBuffer
        .sort((a, b) => a.timestamp - b.timestamp)
        .forEach(msg => this.sendLogNotification(msg.level, msg.args));
      this.messageBuffer = [];
    }
    if (this.droppedBufferedMessages > 0) {
      this.sendLogNotification('warning', [
        `${this.droppedBufferedMessages} pre-initialization log messages were omitted by the bounded log buffer.`
      ]);
      this.droppedBufferedMessages = 0;
    }
  }

  /**
   * Configure client-specific behavior
   * Call this BEFORE enableNotifications()
   */
  public configureForClient(clientName: string) {
    this.clientName = clientName.toLowerCase();
    
    // Detect Cline and disable notifications
    if (this.clientName.includes('cline') || 
        this.clientName.includes('vscode') ||
        this.clientName === 'claude-dev' ||
        this.clientName === 'desktop-commander-client' ||
        process.env.DC_REMOTE_DEVICE === 'true') {
      this.disableNotifications = true;
      process.stderr.write(`[INFO] Desktop Commander: Notifications disabled for ${clientName}\n`);
    }
  }

  /**
   * Check if notifications are enabled
   */
  public get isNotificationsEnabled(): boolean {
    return this.isInitialized;
  }

  /**
   * Get the current count of buffered messages
   */
  public get bufferedMessageCount(): number {
    return this.messageBuffer.length;
  }

  private shouldEmitLog(level: LogLevel): boolean {
    return VERBOSE_LOG_NOTIFICATIONS ||
      level === 'emergency' || level === 'alert' || level === 'critical' ||
      level === 'error' || level === 'warning';
  }

  private compactLogArgs(args: any[]): any[] {
    const rendered = args.map((arg) => {
      if (typeof arg === 'string') return arg;
      try {
        return inspect(arg, { depth: 3, maxArrayLength: 20, maxStringLength: 2048, compact: true, breakLength: 120 });
      } catch {
        return String(arg);
      }
    }).join(' ');
    if (rendered.length <= MAX_LOG_NOTIFICATION_CHARS) return [rendered];
    const omitted = rendered.length - MAX_LOG_NOTIFICATION_CHARS;
    return [`${rendered.slice(0, MAX_LOG_NOTIFICATION_CHARS)}… [${omitted} log chars omitted]`];
  }

  private bufferLog(level: LogLevel, args: any[]): void {
    if (!this.shouldEmitLog(level)) return;
    if (this.messageBuffer.length >= MAX_BUFFERED_LOG_MESSAGES) {
      this.messageBuffer.shift();
      this.droppedBufferedMessages += 1;
    }
    this.messageBuffer.push({ level, args: this.compactLogArgs(args), timestamp: Date.now() });
  }

  private setupConsoleRedirection() {
    console.log = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("info", args);
      } else {
        this.bufferLog("info", args);
      }
    };

    console.info = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("info", args);
      } else {
        this.bufferLog("info", args);
      }
    };

    console.warn = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("warning", args);
      } else {
        this.bufferLog("warning", args);
      }
    };

    console.error = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("error", args);
      } else {
        this.bufferLog("error", args);
      }
    };

    console.debug = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("debug", args);
      } else {
        this.bufferLog("debug", args);
      }
    };
  }

  private setupStdoutFiltering() {
    process.stdout.write = (buffer: any, encoding?: any, callback?: any): boolean => {
      // The MCP SDK writes complete JSON-RPC frames as strings. Also validate
      // Buffer/Uint8Array writes so binary-form debug output cannot bypass the
      // protocol guard and become model-visible stdout garbage.
      if (typeof buffer === 'string' || buffer instanceof Uint8Array) {
        const text = typeof buffer === 'string' ? buffer : Buffer.from(buffer).toString('utf8');
        const trimmed = text.trim();

        // Only an actually parsed JSON-RPC 2.0 frame may pass to protocol stdout.
        // Debug JSON such as {"id":1} must remain a log, not impersonate a response.
        const frame = trimmed.length > 0 ? parseMcpJsonRpcFrame(trimmed) : null;
        if (frame) {
          const startedAt = Date.now();
          const bytes = Buffer.byteLength(text, 'utf8');
          try {
            const accepted = this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);
            traceMcpStdio('WRITE', { ...frame, bytes, backpressure: !accepted });
            if (!accepted) {
              process.stdout.once('drain', () => {
                traceMcpStdio('DRAIN', { ...frame, waitMs: Date.now() - startedAt });
              });
            }
            return accepted;
          } catch (error) {
            traceMcpStdio('WRITE_THROW', {
              ...frame, bytes, error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        } else if (trimmed.length > 0) {
          if (this.isInitialized) {
            this.sendLogNotification("info", [text.replace(/\n$/, '')]);
          } else {
            this.bufferLog("info", [text.replace(/\n$/, '')]);
          }
          if (callback) callback();
          return true;
        }
      }

      return this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);
    };
  }

  private sendLogNotification(level: LogLevel, args: any[]) {
    if (this.disableNotifications || !this.shouldEmitLog(level)) return;

    try {
      const data = this.compactLogArgs(args)[0] ?? '';

      const notification: LogNotification = {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
          level: level,
          logger: "desktop-commander",
          data: data
        }
      };

      // Send as valid JSON-RPC notification
      this.originalStdoutWrite.call(process.stdout, JSON.stringify(notification) + '\n');
    } catch (error) {
      // Fallback to a simple JSON-RPC error notification if JSON serialization fails
      const fallbackNotification = {
        jsonrpc: "2.0" as const,
        method: "notifications/message",
        params: {
          level: "error",
          logger: "desktop-commander",
          data: 'Log serialization failed while preparing a bounded diagnostic.'
        }
      };
      this.originalStdoutWrite.call(process.stdout, JSON.stringify(fallbackNotification) + '\n');
    }
  }

  /**
   * Public method to send log notifications from anywhere in the application
   * Now properly buffers messages before MCP initialization to avoid breaking stdio protocol
   */
  public sendLog(level: LogLevel, message: string, data?: any) {
    // Skip if notifications are disabled (e.g., for Cline)
    if (this.disableNotifications) {
      return;
    }
    
    // Buffer messages before initialization to avoid breaking MCP protocol
    // MCP requires client to send first message - server cannot write to stdout before that
    if (!this.isInitialized) {
      this.bufferLog(level, [data ? { message, ...data } : message]);
      return;
    }
    
    this.sendLogNotification(level, [data ? { message, ...data } : message]);
  }

  /**
   * Send a progress notification (useful for long-running operations)
   */
  public sendProgress(token: string, value: number, total?: number) {
    // Don't send progress before initialization - would break MCP protocol
    if (!this.isInitialized) {
      return;
    }
    
    try {
      const notification = {
        jsonrpc: "2.0" as const,
        method: "notifications/progress",
        params: {
          progressToken: token,
          value: value,
          ...(total && { total })
        }
      };
      
      this.originalStdoutWrite.call(process.stdout, JSON.stringify(notification) + '\n');
    } catch (error) {
      // Fallback to basic JSON-RPC notification for progress
      const fallbackNotification = {
        jsonrpc: "2.0" as const,
        method: "notifications/message",
        params: {
          level: "info",
          logger: "desktop-commander",
          data: `Progress ${token}: ${value}${total ? `/${total}` : ''}`
        }
      };
      this.originalStdoutWrite.call(process.stdout, JSON.stringify(fallbackNotification) + '\n');
    }
  }

  /**
   * Send a custom notification with any method name
   */
  public sendCustomNotification(method: string, params: any) {
    // Don't send custom notifications before initialization - would break MCP protocol
    if (!this.isInitialized) {
      return;
    }
    
    try {
      const notification = {
        jsonrpc: "2.0" as const,
        method: method,
        params: params
      };
      
      this.originalStdoutWrite.call(process.stdout, JSON.stringify(notification) + '\n');
    } catch (error) {
      // Fallback to basic JSON-RPC notification for custom notifications
      const fallbackNotification = {
        jsonrpc: "2.0" as const,
        method: "notifications/message",
        params: {
          level: "error",
          logger: "desktop-commander",
          data: `Custom notification failed: ${method}: ${JSON.stringify(params)}`
        }
      };
      this.originalStdoutWrite.call(process.stdout, JSON.stringify(fallbackNotification) + '\n');
    }
  }

  /**
   * Cleanup method to restore original console methods if needed
   */
  public cleanup() {
    if (this.originalConsole) {
      console.log = this.originalConsole.log;
      console.warn = this.originalConsole.warn;
      console.error = this.originalConsole.error;
      console.debug = this.originalConsole.debug;
      console.info = this.originalConsole.info;
    }
    
    if (this.originalStdoutWrite) {
      process.stdout.write = this.originalStdoutWrite;
    }
  }
}
