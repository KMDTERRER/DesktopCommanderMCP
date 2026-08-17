import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { validatePath } from './tools/filesystem.js';
import { capture } from './utils/capture.js';
import { getRipgrepPath } from './utils/ripgrep-resolver.js';
import { isExcelFile } from './utils/files/index.js';
import PizZip from 'pizzip';
import { readFileBounded } from './utils/bounded-file-read.js';
import { preflightZipContainer } from './utils/bounded-zip.js';
import {
  MAX_DOCX_ARCHIVE_ENTRIES, MAX_DOCX_INPUT_BYTES, MAX_DOCX_TOTAL_UNCOMPRESSED_BYTES, MAX_DOCX_XML_BYTES,
  MAX_EXCEL_ARCHIVE_ENTRIES, MAX_EXCEL_INPUT_BYTES, MAX_EXCEL_UNCOMPRESSED_BYTES,
} from './utils/read-resource-limits.js';
import {
  DEFAULT_SEARCH_CONTEXT_LINES, DEFAULT_SEARCH_MAX_RESULTS, DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_BUFFER_CHARS, MAX_SEARCH_CONTEXT_LINES, MAX_SEARCH_ERROR_CHARS,
  MAX_SEARCH_MATCH_CHARS, MAX_SEARCH_RESULTS, MAX_SEARCH_STORED_CONTEXT_RESULTS,
  MAX_SEARCH_TIMEOUT_MS,
} from './utils/search-limits.js';

export interface SearchResult {
  file: string;
  line?: number;
  match?: string;
  type: 'file' | 'content';
}

export interface SearchSession {
  id: string;
  process: ChildProcess;
  results: SearchResult[];
  isComplete: boolean;
  isError: boolean;
  error?: string;
  startTime: number;
  lastReadTime: number;
  options: SearchSessionOptions;
  buffer: string;  // For processing incomplete JSON lines
  totalMatches: number;
  totalContextLines: number;  // Stored context lines; bounded independently from matches
  resultLimitReached?: boolean;
  deadlineReached?: boolean;
  wasIncomplete?: boolean;  // Track whether the search ended before a complete scan
  ripgrepComplete: boolean;
  ripgrepExitCode?: number | null;
  pendingAuxiliary: number;
  auxiliaryAbortController: AbortController;
  deadlineTimer?: NodeJS.Timeout;
}

export interface SearchSessionOptions {
  rootPath: string;
  pattern: string;
  searchType: 'files' | 'content';
  filePattern?: string;
  ignoreCase?: boolean;
  maxResults?: number;
  includeHidden?: boolean;
  contextLines?: number;
  timeout?: number;
  earlyTermination?: boolean;  // Stop search early when exact filename match is found
  literalSearch?: boolean;     // Force literal string matching (-F flag) instead of regex
}

function normalizeBoundedInteger(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const normalized = value === undefined ? fallback : value;
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return normalized;
}

function throwIfSearchAborted(signal: AbortSignal, label: string): void {
  if (!signal.aborted) return;
  const error = new Error(`${label} aborted`) as NodeJS.ErrnoException;
  error.code = 'ABORT_ERR';
  throw error;
}

function awaitSearchIo<T>(signal: AbortSignal, label: string, operation: () => Promise<T>): Promise<T> {
  throwIfSearchAborted(signal, label);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => {
      const error = new Error(`${label} aborted`) as NodeJS.ErrnoException;
      error.code = 'ABORT_ERR';
      reject(error);
    });
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(operation).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function normalizeSearchOptions(options: SearchSessionOptions): SearchSessionOptions {
  return {
    ...options,
    maxResults: normalizeBoundedInteger(options.maxResults, DEFAULT_SEARCH_MAX_RESULTS, 1, MAX_SEARCH_RESULTS, 'maxResults'),
    contextLines: normalizeBoundedInteger(options.contextLines, DEFAULT_SEARCH_CONTEXT_LINES, 0, MAX_SEARCH_CONTEXT_LINES, 'contextLines'),
    timeout: options.timeout === undefined
      ? undefined
      : normalizeBoundedInteger(options.timeout, DEFAULT_SEARCH_TIMEOUT_MS, 0, MAX_SEARCH_TIMEOUT_MS, 'timeout'),
  };
}

/**
 * Search Session Manager - handles ripgrep processes like terminal sessions
 * Supports both file search and content search with progressive results
 */export class SearchManager {
  private sessions = new Map<string, SearchSession>();
  private sessionCounter = 0;

  /**
   * Start a new search session (like start_process)
   * Returns immediately with initial state and results
   */

  async startSearch(options: SearchSessionOptions): Promise<{
    sessionId: string;
    isComplete: boolean;
    isError: boolean;
    results: SearchResult[];
    totalResults: number;
    runtime: number;
  }> {
    const sessionId = `search_${++this.sessionCounter}_${Date.now()}`;
    options = normalizeSearchOptions(options);
    const timeoutMs = options.timeout ?? (this.isExactFilename(options.pattern) ? 1500 : DEFAULT_SEARCH_TIMEOUT_MS);
    
    // Path authority consumes the same operation budget when a timeout is enabled.
    const validationBudgetMs = timeoutMs > 0 ? Math.min(timeoutMs, 10_000) : 10_000;
    const validPath = await validatePath(options.rootPath, validationBudgetMs);

    // Build ripgrep arguments
    const args = this.buildRipgrepArgs({ ...options, rootPath: validPath });
    
    // Get ripgrep path with fallback resolution
    let rgPath: string;
    try {
      rgPath = await getRipgrepPath();
    } catch (err) {
      throw new Error(`Failed to locate ripgrep binary: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    // Start ripgrep process
    const rgProcess = spawn(rgPath, args, { windowsHide: true });  // Prevent visible console windows on Windows
    
    if (!rgProcess.pid) {
      throw new Error('Failed to start ripgrep process');
    }

    // Create session
    const session: SearchSession = {
      id: sessionId,
      process: rgProcess,
      results: [],
      isComplete: false,
      isError: false,
      startTime: Date.now(),
      lastReadTime: Date.now(),
      options,
      buffer: '',
      totalMatches: 0,
      totalContextLines: 0,
      ripgrepComplete: false,
      pendingAuxiliary: 0,
      auxiliaryAbortController: new AbortController(),
    };

    this.sessions.set(sessionId, session);

    // Set up process event handlers
    this.setupProcessHandlers(session);

    // Start cleanup interval now that we have a session
    startCleanupIfNeeded();

    // One deadline owns the whole composite search: ripgrep plus Office providers.
    // Finishing ripgrep early must not leave Excel/DOCX work unbounded.
    if (timeoutMs) {
      session.deadlineTimer = setTimeout(() => {
        if (session.isComplete) return;
        session.deadlineReached = true;
        session.wasIncomplete = true;
        this.stopSearchProcess(session);
        // ripgrep may already have closed while a non-abortable auxiliary parser
        // is still running. The deadline itself is terminal for the session.
        this.finalizeSearchSessionIfReady(session);
      }, timeoutMs);
    }

    capture('search_session_started', {
      sessionId,
      searchType: options.searchType,
      hasTimeout: !!timeoutMs,
      timeoutMs,
      requestedPath: options.rootPath,
      validatedPath: validPath
    });

    // For content searches, only search Excel files when contextually relevant:
    // - filePattern explicitly targets Excel files (*.xlsx)
    // - or rootPath is an Excel file itself
    const shouldSearchExcel = options.searchType === 'content' &&
      this.shouldIncludeExcelSearch(options.filePattern, validPath);

    if (shouldSearchExcel) {
      session.pendingAuxiliary += 1;
      this.searchExcelFiles(
        validPath,
        options.pattern,
        options.ignoreCase !== false,
        options.maxResults,
        options.filePattern,  // Pass filePattern to filter Excel files too
        options.literalSearch, // Respect literalSearch flag for Office files
        session.auxiliaryAbortController.signal
      ).then(excelResults => {
        if (session.isComplete || session.deadlineReached) return;
        // Merge through the same global session budget as ripgrep results.
        for (const result of excelResults) {
          if (!this.storeSearchResult(session, result, false)) break;
        }
      }).catch((err) => {
        if (session.auxiliaryAbortController.signal.aborted &&
            (session.deadlineReached || session.resultLimitReached || session.isComplete)) return;
        const message = err instanceof Error ? err.message : String(err);
        session.wasIncomplete = true;
        this.appendSearchError(session, `Excel search incomplete: ${message}\n`);
        capture('excel_search_error', { error: message });
      }).finally(() => {
        session.pendingAuxiliary = Math.max(0, session.pendingAuxiliary - 1);
        this.finalizeSearchSessionIfReady(session);
      });
    }

    // For content searches, also search DOCX files
    const shouldSearchDocx = options.searchType === 'content' &&
      this.shouldIncludeDocxSearch(options.filePattern, validPath);

    if (shouldSearchDocx) {
      session.pendingAuxiliary += 1;
      this.searchDocxFiles(
        validPath,
        options.pattern,
        options.ignoreCase !== false,
        options.maxResults,
        options.filePattern,
        options.literalSearch, // Respect literalSearch flag for Office files
        session.auxiliaryAbortController.signal
      ).then(docxResults => {
        if (session.isComplete || session.deadlineReached) return;
        for (const result of docxResults) {
          if (!this.storeSearchResult(session, result, false)) break;
        }
      }).catch((err) => {
        if (session.auxiliaryAbortController.signal.aborted &&
            (session.deadlineReached || session.resultLimitReached || session.isComplete)) return;
        const message = err instanceof Error ? err.message : String(err);
        session.wasIncomplete = true;
        this.appendSearchError(session, `DOCX search incomplete: ${message}\n`);
        capture('docx_search_error', { error: message });
      }).finally(() => {
        session.pendingAuxiliary = Math.max(0, session.pendingAuxiliary - 1);
        this.finalizeSearchSessionIfReady(session);
      });
    }

    // Wait for first chunk of data or early completion instead of fixed delay
    // Excel search runs in background and results are merged via readSearchResults
    const firstChunk = new Promise<void>(resolve => {
      const onData = () => {
        session.process.stdout?.off('data', onData);
        resolve();
      };
      session.process.stdout?.once('data', onData);
      setTimeout(resolve, 40); // cap at 40ms instead of 50-100ms
    });

    // Only wait for ripgrep first chunk - Excel results merge asynchronously
    await firstChunk;

    return {
      sessionId,
      isComplete: session.isComplete,
      isError: session.isError,
      results: [...session.results],
      totalResults: session.totalMatches,
      runtime: Date.now() - session.startTime
    };
  }

  /**
   * Read search results with offset-based pagination (like read_file)
   * Supports both range reading and tail behavior
   */
  readSearchResults(
    sessionId: string, 
    offset: number = 0, 
    length: number = 100
  ): {
    results: SearchResult[];
    returnedCount: number;        // Renamed from newResultsCount
    totalResults: number;
    totalMatches: number;         // Actual matches (excluding context)
    isComplete: boolean;
    isError: boolean;
    error?: string;
    hasMoreResults: boolean;      // New field
    runtime: number;
    wasIncomplete?: boolean;
    limitReached?: boolean;
  } {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      throw new Error(`Search session ${sessionId} not found`);
    }

    // Get all results (excluding internal markers)
    const allResults = session.results.filter(r => r.file !== '__LAST_READ_MARKER__');
    
    // Handle negative offsets (tail behavior) - like file reading
    if (offset < 0) {
      const tailCount = Math.abs(offset);
      const tailResults = allResults.slice(-tailCount);
      return {
        results: tailResults,
        returnedCount: tailResults.length,
        totalResults: session.totalMatches + session.totalContextLines,
        totalMatches: session.totalMatches, // Actual matches only
        isComplete: session.isComplete,
        isError: session.isError && !!session.error?.trim(), // Only error if we have actual errors
        error: session.error?.trim() || undefined,
        hasMoreResults: false, // Tail always returns what's available
        runtime: Date.now() - session.startTime,
        wasIncomplete: session.wasIncomplete,
        limitReached: session.resultLimitReached
      };
    }

    // Handle positive offsets (range behavior) - like file reading
    const slicedResults = allResults.slice(offset, offset + length);
    const hasMoreResults = offset + length < allResults.length || !session.isComplete;

    session.lastReadTime = Date.now();

    return {
      results: slicedResults,
      returnedCount: slicedResults.length,
      totalResults: session.totalMatches + session.totalContextLines,
      totalMatches: session.totalMatches, // Actual matches only
      isComplete: session.isComplete,
      isError: session.isError && !!session.error?.trim(), // Only error if we have actual errors
      error: session.error?.trim() || undefined,
      hasMoreResults,
      runtime: Date.now() - session.startTime,
      wasIncomplete: session.wasIncomplete,
      limitReached: session.resultLimitReached
    };
  }

  /**
   * Terminate a search session (like force_terminate)
   */
  terminateSearch(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return false;
    }

    session.wasIncomplete = true;
    this.stopSearchProcess(session);

    // Don't delete session immediately - let user read final results
    // It will be cleaned up by cleanup process
    
    return true;
  }

  /**
   * Get list of active search sessions (like list_sessions)
   */
  listSearchSessions(): Array<{
    id: string;
    searchType: string;
    pattern: string;
    isComplete: boolean;
    isError: boolean;
    runtime: number;
    totalResults: number;
  }> {
    return Array.from(this.sessions.values()).map(session => ({
      id: session.id,
      searchType: session.options.searchType,
      pattern: session.options.pattern,
      isComplete: session.isComplete,
      isError: session.isError,
      runtime: Date.now() - session.startTime,
      totalResults: session.totalMatches + session.totalContextLines
    }));
  }

  /**
   * Search Excel files for content matches
   * Called during content search to include Excel files alongside text files
   * Searches ALL sheets in each Excel file (row-wise for cross-column matching)
   *
   * TODO: Refactor - Extract Excel search logic to separate module (src/utils/search/excel-search.ts)
   * and inject into SearchManager, similar to how file handlers are structured in src/utils/files/
   * This would allow adding other file type searches (PDF, etc.) without bloating search-manager.ts
   */
  private async searchExcelFiles(
    rootPath: string,
    pattern: string,
    ignoreCase: boolean,
    maxResults?: number,
    filePattern?: string,
    _literalSearch?: boolean,
    signal: AbortSignal = new AbortController().signal
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    // Office file search always uses literal matching to prevent ReDoS.
    // Regex patterns are treated as literal strings — this is intentional.
    const searchTerm = ignoreCase ? pattern.toLowerCase() : pattern;

    // Find Excel files recursively
    let excelFiles = await this.findExcelFiles(rootPath, signal);

    // Filter by filePattern if provided
    if (filePattern) {
      const patterns = filePattern.split('|').map(p => p.trim()).filter(Boolean);
      excelFiles = excelFiles.filter(filePath => {
        const fileName = path.basename(filePath);
        return patterns.some(pat => {
          // Support glob-like patterns
          if (pat.includes('*')) {
            // Escape all regex metacharacters first (preserving * for glob expansion),
            // then convert the remaining * wildcards to .* for glob matching.
            // Without this, patterns like report(2024).xlsx or [draft].xlsx would be
            // misinterpreted as regex groups/character-classes.
            const regexPat = pat
              .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape metacharacters except *
              .replace(/\*/g, '.*');                  // glob * → regex .*
            return new RegExp(`^${regexPat}$`, 'i').test(fileName);
          }
          // Exact match (case-insensitive)
          return fileName.toLowerCase() === pat.toLowerCase();
        });
      });
    }

    // Dynamically import ExcelJS to search all sheets
    const ExcelJS = await import('exceljs');

    for (const filePath of excelFiles) {
      if (maxResults && results.length >= maxResults) break;

      try {
        throwIfSearchAborted(signal, 'Excel search');
        const buffer = await readFileBounded(filePath, MAX_EXCEL_INPUT_BYTES, signal, 'Excel search input');
        preflightZipContainer(buffer, {
          maxEntries: MAX_EXCEL_ARCHIVE_ENTRIES,
          maxTotalUncompressedBytes: MAX_EXCEL_UNCOMPRESSED_BYTES,
          label: 'Excel search XLSX',
        });
        const workbook = new ExcelJS.default.Workbook();
        const workbookBytes = buffer.buffer.slice(
          buffer.byteOffset, buffer.byteOffset + buffer.byteLength
        ) as ArrayBuffer;
        await workbook.xlsx.load(workbookBytes);
        throwIfSearchAborted(signal, 'Excel search');

        // Search ALL sheets in the workbook (row-wise for speed and cross-column matching)
        for (const worksheet of workbook.worksheets) {
          if (maxResults && results.length >= maxResults) break;

          const sheetName = worksheet.name;

          // Iterate through rows (faster than cell-by-cell)
          worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            throwIfSearchAborted(signal, 'Excel search');
            if (maxResults && results.length >= maxResults) return;

            // Build a concatenated string of all cell values in the row
            const rowValues: string[] = [];
            row.eachCell({ includeEmpty: false }, (cell) => {
              if (cell.value === null || cell.value === undefined) return;

              let cellStr: string;
              if (typeof cell.value === 'object') {
                if ('result' in cell.value) {
                  cellStr = String(cell.value.result ?? '');
                } else if ('richText' in cell.value) {
                  cellStr = (cell.value as any).richText.map((rt: any) => rt.text).join('');
                } else if ('text' in cell.value) {
                  cellStr = String((cell.value as any).text);
                } else {
                  cellStr = String(cell.value);
                }
              } else {
                cellStr = String(cell.value);
              }

              if (cellStr.trim()) {
                rowValues.push(cellStr);
              }
            });

            // Join all cell values with space for cross-column matching
            const rowText = rowValues.join(' ');

            const textToSearch = ignoreCase ? rowText.toLowerCase() : rowText;
            const matchIndex = textToSearch.indexOf(searchTerm);
            if (matchIndex !== -1) {
              const matchContext = this.getMatchContext(rowText, matchIndex, searchTerm.length);

              results.push({
                file: `${filePath}:${sheetName}!Row${rowNumber}`,
                line: rowNumber,
                match: matchContext,
                type: 'content'
              });
            }
          });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (signal.aborted || code === 'ABORT_ERR' || code === 'EFBIG') throw error;
        // Skip files that can't be read (permission issues, corrupted, etc.)
        continue;
      }
    }

    return results;
  }

  /**
   * Find all Excel files in a directory recursively
   */
  private async findExcelFiles(rootPath: string, signal: AbortSignal): Promise<string[]> {
    const excelFiles: string[] = [];

    async function walk(dir: string): Promise<void> {
      try {
        throwIfSearchAborted(signal, 'Excel file discovery');
        const entries = await awaitSearchIo(
          signal, `Excel file discovery readdir ${dir}`,
          () => fs.readdir(dir, { withFileTypes: true }),
        );
        throwIfSearchAborted(signal, 'Excel file discovery');

        for (const entry of entries) {
          throwIfSearchAborted(signal, 'Excel file discovery');
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            // Skip node_modules, .git, etc.
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              await walk(fullPath);
            }
          } else if (entry.isFile() && isExcelFile(entry.name)) {
            excelFiles.push(fullPath);
          }
        }
      } catch (error) {
        if (signal.aborted || (error as NodeJS.ErrnoException)?.code === 'ABORT_ERR') throw error;
        // Skip directories we can't read.
      }
    }

    // Check if rootPath is a file or directory
    try {
      throwIfSearchAborted(signal, 'Excel file discovery');
      const stats = await awaitSearchIo(
        signal, `Excel file discovery stat ${rootPath}`, () => fs.stat(rootPath),
      );
      if (stats.isFile() && isExcelFile(rootPath)) {
        return [rootPath];
      } else if (stats.isDirectory()) {
        await walk(rootPath);
      }
    } catch (error) {
      if (signal.aborted || (error as NodeJS.ErrnoException)?.code === 'ABORT_ERR') throw error;
      // Path doesn't exist or can't be accessed
    }

    return excelFiles;
  }

  /**
   * Determine if DOCX search should be included based on context
   */
  private shouldIncludeDocxSearch(filePattern?: string, rootPath?: string): boolean {
    const docxExtensions = ['.docx'];

    if (rootPath) {
      const lowerPath = rootPath.toLowerCase();
      if (docxExtensions.some(ext => lowerPath.endsWith(ext))) {
        return true;
      }
    }

    if (filePattern) {
      const lowerPattern = filePattern.toLowerCase();
      if (docxExtensions.some(ext =>
        lowerPattern.includes(`*${ext}`) || lowerPattern.endsWith(ext)
      )) {
        return true;
      }
    }

    return false;
  }

  /**
   * Search DOCX files for content matches
   * Extracts <w:t> text from document.xml and searches it
   */
  private async searchDocxFiles(
    rootPath: string,
    pattern: string,
    ignoreCase: boolean,
    maxResults?: number,
    filePattern?: string,
    _literalSearch?: boolean,
    signal: AbortSignal = new AbortController().signal
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    // Office file search always uses literal matching to prevent ReDoS.
    // Regex patterns are treated as literal strings — this is intentional.
    const searchTerm = ignoreCase ? pattern.toLowerCase() : pattern;

    let docxFiles = await this.findDocxFiles(rootPath, signal);

    if (filePattern) {
      const patterns = filePattern.split('|').map(p => p.trim()).filter(Boolean);
      docxFiles = docxFiles.filter(filePath => {
        const fileName = path.basename(filePath);
        return patterns.some(pat => {
          if (pat.includes('*')) {
            const regexPat = pat
              .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape metacharacters except *
              .replace(/\*/g, '.*');                  // glob * → regex .*
            return new RegExp(`^${regexPat}$`, 'i').test(fileName);
          }
          return fileName.toLowerCase() === pat.toLowerCase();
        });
      });
    }

    const xmlParts = ['word/document.xml', 'word/header1.xml', 'word/header2.xml',
      'word/header3.xml', 'word/footer1.xml', 'word/footer2.xml', 'word/footer3.xml'];
    const searchableXmlParts = new Set(xmlParts);

    for (const filePath of docxFiles) {
      if (maxResults && results.length >= maxResults) break;

      try {
        throwIfSearchAborted(signal, 'DOCX search');
        const buf = await readFileBounded(filePath, MAX_DOCX_INPUT_BYTES, signal, 'DOCX search input');
        preflightZipContainer(buf, {
          maxEntries: MAX_DOCX_ARCHIVE_ENTRIES,
          maxTotalUncompressedBytes: MAX_DOCX_TOTAL_UNCOMPRESSED_BYTES,
          maxSelectedUncompressedBytes: MAX_DOCX_XML_BYTES,
          selectEntry: (name) => searchableXmlParts.has(name),
          label: 'DOCX search',
        });
        const zip = new PizZip(buf);

        for (const xmlPath of xmlParts) {
          throwIfSearchAborted(signal, 'DOCX search');
          if (maxResults && results.length >= maxResults) break;

          const file = zip.file(xmlPath);
          if (!file) continue;

          const xml = file.asText();
          // Extract all <w:t> text with position tracking
          const wtRe = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
          let m;
          let lineNum = 0;

          while ((m = wtRe.exec(xml)) !== null) {
            throwIfSearchAborted(signal, 'DOCX search');
            if (maxResults && results.length >= maxResults) break;
            const text = m[1];
            if (!text || !text.trim()) continue;
            lineNum++;

            const textToSearch = ignoreCase ? text.toLowerCase() : text;
            const matchIndex = textToSearch.indexOf(searchTerm);
            if (matchIndex !== -1) {
              const matchContext = this.getMatchContext(text, matchIndex, searchTerm.length);

              const partName = xmlPath === 'word/document.xml' ? '' : `:${xmlPath.replace('word/', '')}`;
              results.push({
                file: `${filePath}${partName}`,
                line: lineNum,
                match: matchContext,
                type: 'content'
              });
            }
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (signal.aborted || code === 'ABORT_ERR' || code === 'EFBIG') throw error;
        continue;
      }
    }

    return results;
  }

  /**
   * Find all DOCX files in a directory recursively
   */
  private async findDocxFiles(rootPath: string, signal: AbortSignal): Promise<string[]> {
    const docxFiles: string[] = [];
    const isDocx = (name: string) => name.toLowerCase().endsWith('.docx');

    async function walk(dir: string): Promise<void> {
      try {
        throwIfSearchAborted(signal, 'DOCX file discovery');
        const entries = await awaitSearchIo(
          signal, `DOCX file discovery readdir ${dir}`,
          () => fs.readdir(dir, { withFileTypes: true }),
        );
        throwIfSearchAborted(signal, 'DOCX file discovery');
        for (const entry of entries) {
          throwIfSearchAborted(signal, 'DOCX file discovery');
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              await walk(fullPath);
            }
          } else if (entry.isFile() && isDocx(entry.name)) {
            docxFiles.push(fullPath);
          }
        }
      } catch (error) {
        if (signal.aborted || (error as NodeJS.ErrnoException)?.code === 'ABORT_ERR') throw error;
        // Skip unreadable directories.
      }
    }

    try {
      throwIfSearchAborted(signal, 'DOCX file discovery');
      const stats = await awaitSearchIo(
        signal, `DOCX file discovery stat ${rootPath}`, () => fs.stat(rootPath),
      );
      if (stats.isFile() && isDocx(rootPath)) {
        return [rootPath];
      } else if (stats.isDirectory()) {
        await walk(rootPath);
      }
    } catch (error) {
      if (signal.aborted || (error as NodeJS.ErrnoException)?.code === 'ABORT_ERR') throw error;
      // Skip an unreadable root.
    }

    return docxFiles;
  }

  /**
   * Extract context around a match for display (show surrounding text)
   */
  private getMatchContext(text: string, matchStart: number, matchLength: number): string {
    const contextChars = 50; // chars before and after match
    const start = Math.max(0, matchStart - contextChars);
    const end = Math.min(text.length, matchStart + matchLength + contextChars);

    let context = text.substring(start, end);

    // Add ellipsis if truncated
    if (start > 0) context = '...' + context;
    if (end < text.length) context = context + '...';

    return context;
  }

  /**
   * Clean up completed sessions older than specified time
   * Called automatically by cleanup interval
   */
  cleanupSessions(maxAge: number = 5 * 60 * 1000): void {
    const cutoffTime = Date.now() - maxAge;
    
    for (const [sessionId, session] of this.sessions) {
      if (session.isComplete && session.lastReadTime < cutoffTime) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Get total number of active sessions (excluding completed ones)
   */
  getActiveSessionCount(): number {
    return Array.from(this.sessions.values()).filter(session => !session.isComplete).length;
  }

  /**
   * Detect if pattern looks like an exact filename
   * (has file extension and no glob wildcards)
   */
  private isExactFilename(pattern: string): boolean {
    return /\.[a-zA-Z0-9]+$/.test(pattern) &&
           !this.isGlobPattern(pattern);
  }

  /**
   * Detect if pattern contains glob wildcards
   */
  private isGlobPattern(pattern: string): boolean {
    return pattern.includes('*') ||
           pattern.includes('?') ||
           pattern.includes('[') ||
           pattern.includes('{') ||
           pattern.includes(']') ||
           pattern.includes('}');
  }

  /**
   * Determine if Excel search should be included based on context
   * Only searches Excel files when:
   * - filePattern explicitly targets Excel files (*.xlsx, *.xls, *.xlsm, *.xlsb)
   * - or the rootPath itself is an Excel file
   */
  private shouldIncludeExcelSearch(filePattern?: string, rootPath?: string): boolean {
    const excelExtensions = ['.xlsx'];

    // Check if rootPath is an Excel file
    if (rootPath) {
      const lowerPath = rootPath.toLowerCase();
      if (excelExtensions.some(ext => lowerPath.endsWith(ext))) {
        return true;
      }
    }

    // Check if filePattern targets Excel files
    if (filePattern) {
      const lowerPattern = filePattern.toLowerCase();
      // Check for patterns like *.xlsx, *.xls, or explicit Excel extensions
      if (excelExtensions.some(ext =>
        lowerPattern.includes(`*${ext}`) ||
        lowerPattern.endsWith(ext)
      )) {
        return true;
      }
    }

    return false;
  }

  private buildRipgrepArgs(options: SearchSessionOptions): string[] {
    const args: string[] = [];
    
    if (options.searchType === 'content') {
      // Content search mode
      args.push('--json', '--line-number');
      
      // Add literal search support for content searches
      if (options.literalSearch) {
        args.push('-F'); // Fixed string matching (literal)
      }

      if (options.contextLines && options.contextLines > 0) {
        args.push('-C', options.contextLines.toString());
      }
    } else {
      // File search mode
      args.push('--files');
    }
    
    // Case-insensitive: content searches use -i flag, file searches use --iglob
    if (options.searchType === 'content' && options.ignoreCase !== false) {
      args.push('-i');
    }
    
    if (options.includeHidden) {
      args.push('--hidden');
    }
    
    if (options.maxResults && options.maxResults > 0) {
      args.push('-m', options.maxResults.toString());
    }

    // File pattern filtering (for file type restrictions like *.js, *.d.ts)
    if (options.filePattern) {
      const patterns = options.filePattern
        .split('|')
        .map(p => p.trim())
        .filter(Boolean);
      
      for (const p of patterns) {
        if (options.searchType === 'content') {
          args.push('-g', p);
        } else {
          // For file search: use --iglob for case-insensitive or --glob for case-sensitive
          if (options.ignoreCase !== false) {
            args.push('--iglob', p);
          } else {
            args.push('--glob', p);
          }
        }
      }
    }
    
    // Handle the main search pattern
    if (options.searchType === 'files') {
      // For file search: determine how to treat the pattern
      const globFlag = options.ignoreCase !== false ? '--iglob' : '--glob';
      
      if (this.isExactFilename(options.pattern)) {
        // Exact filename: use appropriate glob flag with the exact pattern
        args.push(globFlag, options.pattern);
      } else if (this.isGlobPattern(options.pattern)) {
        // Already a glob pattern: use appropriate glob flag as-is
        args.push(globFlag, options.pattern);
      } else {
        // Substring/fuzzy search: wrap with wildcards
        args.push(globFlag, `*${options.pattern}*`);
      }
      // Add the root path for file mode
      args.push(options.rootPath);
    } else {
      // Content search: terminate options before the pattern to prevent 
      // patterns starting with '-' being interpreted as flags
      args.push('--', options.pattern, options.rootPath);
    }
    
    return args;
  }

  private appendSearchError(session: SearchSession, message: string): void {
    if (!message) return;
    const combined = `${session.error ?? ''}${message}`;
    session.error = combined.length <= MAX_SEARCH_ERROR_CHARS
      ? combined
      : combined.slice(-MAX_SEARCH_ERROR_CHARS);
  }

  private stopSearchProcess(session: SearchSession): void {
    if (!session.auxiliaryAbortController.signal.aborted) session.auxiliaryAbortController.abort();
    if (!session.isComplete && !session.process.killed) session.process.kill('SIGTERM');
  }

  private storeSearchResult(session: SearchSession, result: SearchResult, isContext: boolean): boolean {
    if (session.isComplete || session.deadlineReached) return false;
    const maxMatches = session.options.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
    if (isContext) {
      if (session.resultLimitReached) return false;
      const contextLines = session.options.contextLines ?? DEFAULT_SEARCH_CONTEXT_LINES;
      const contextBudget = Math.min(MAX_SEARCH_STORED_CONTEXT_RESULTS, maxMatches * contextLines * 2);
      if (session.totalContextLines >= contextBudget) return true;
      session.results.push({
        ...result,
        ...(result.match !== undefined ? { match: result.match.slice(0, MAX_SEARCH_MATCH_CHARS) } : {}),
      });
      session.totalContextLines += 1;
      return true;
    }

    if (session.totalMatches >= maxMatches) {
      session.resultLimitReached = true;
      this.stopSearchProcess(session);
      return false;
    }
    session.results.push({
      ...result,
      ...(result.match !== undefined ? { match: result.match.slice(0, MAX_SEARCH_MATCH_CHARS) } : {}),
    });
    session.totalMatches += 1;
    if (session.totalMatches >= maxMatches) {
      session.resultLimitReached = true;
      this.stopSearchProcess(session);
      return false;
    }
    return true;
  }

  private finalizeSearchSessionIfReady(session: SearchSession): void {
    if (session.isComplete || !session.ripgrepComplete) return;
    const terminalWithoutAuxiliary = session.deadlineReached || session.resultLimitReached;
    if (!terminalWithoutAuxiliary && session.pendingAuxiliary > 0) return;
    if (session.deadlineTimer) {
      clearTimeout(session.deadlineTimer);
      session.deadlineTimer = undefined;
    }
    session.isComplete = true;
    if (session.totalMatches > 0) session.isError = false;
    capture('search_session_completed', {
      sessionId: session.id,
      exitCode: session.ripgrepExitCode ?? -1,
      totalResults: session.totalMatches + session.totalContextLines,
      totalMatches: session.totalMatches,
      runtime: Date.now() - session.startTime,
      wasIncomplete: session.wasIncomplete || false,
      limitReached: session.resultLimitReached || false,
    });
  }

  private setupProcessHandlers(session: SearchSession): void {
    const { process } = session;

    process.stdout?.on('data', (data: Buffer) => {
      session.buffer += data.toString();
      this.processBufferedOutput(session);
      if (session.buffer.length > MAX_SEARCH_BUFFER_CHARS) {
        session.wasIncomplete = true;
        this.appendSearchError(session, `Search output line exceeded ${MAX_SEARCH_BUFFER_CHARS} characters.\n`);
        session.buffer = '';
        this.stopSearchProcess(session);
      }
    });

    process.stderr?.on('data', (data: Buffer) => {
      const errorText = data.toString();

      // Filter stderr before retaining it; raw ripgrep diagnostics can be noisy and
      // session.error itself is a bounded user-visible buffer.
      // Filter meaningful errors
      const filteredErrors = errorText
        .split('\n')
        .filter(line => {
          const trimmed = line.trim();

          // Skip empty lines and lines with just symbols/numbers/colons
          if (!trimmed || trimmed.match(/^[\)\(\s\d:]*$/)) return false;

          // Skip all ripgrep system errors that start with "rg:"
          if (trimmed.startsWith('rg:')) return false;

          return true;
        });

      // Only add to session.error if there are actual meaningful errors after filtering
      if (filteredErrors.length > 0) {
        const meaningfulErrors = filteredErrors.join('\n').trim();
        if (meaningfulErrors) {
          this.appendSearchError(session, `${meaningfulErrors}\n`);
          capture('search_session_error', {
            sessionId: session.id,
            error: meaningfulErrors.substring(0, 200)
          });
        }
      }
    });

    process.on('close', (code: number) => {
      // Process any remaining buffer content
      if (session.buffer.trim()) {
        this.processBufferedOutput(session, true);
      }

      session.ripgrepComplete = true;
      session.ripgrepExitCode = code;

      // Track if search was incomplete due to access issues
      // Ripgrep exit code 2 means "some files couldn't be searched"
      if (code === 2) {
        session.wasIncomplete = true;
      }

      // Only treat as error if:
      // 1. Unexpected exit code (not 0, 1, or 2) AND
      // 2. We have meaningful errors after filtering AND
      // 3. We found no results at all
      if (code !== 0 && code !== 1 && code !== 2) {
        // Codes 0=success, 1=no matches, 2=some files couldn't be searched
        if (session.error?.trim() && session.totalMatches === 0) {
          session.isError = true;
          session.error = session.error || `ripgrep exited with code ${code}`;
        }
      }

      this.finalizeSearchSessionIfReady(session);

      // Rely on cleanupSessions(maxAge) only; no per-session timer
    });

    process.on('error', (error: Error) => {
      session.isError = true;
      this.appendSearchError(session, `Process error: ${error.message}\n`);
      // Completion remains owned by 'close', which follows process/stdio shutdown.
    });
  }

  private processBufferedOutput(session: SearchSession, isFinal: boolean = false): void {
    const lines = session.buffer.split('\n');
    
    // Keep the last incomplete line in the buffer unless this is final processing
    if (!isFinal) {
      session.buffer = lines.pop() || '';
    } else {
      session.buffer = '';
    }
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      const result = this.parseLine(line, session.options.searchType);
      if (result) {
        const isContext = result.type === 'content' && line.includes('"type":"context"');
        if (!this.storeSearchResult(session, result, isContext)) break;

        // Early termination for exact filename matches (if enabled)
        if (session.options.earlyTermination !== false && // Default to true
            session.options.searchType === 'files' &&
            this.isExactFilename(session.options.pattern)) {
          const pat = path.normalize(session.options.pattern);
          const filePath = path.normalize(result.file);
          const ignoreCase = session.options.ignoreCase !== false;
          const ends = ignoreCase
            ? filePath.toLowerCase().endsWith(pat.toLowerCase())
            : filePath.endsWith(pat);
          if (ends) {
            // Found exact match, terminate search early
            setTimeout(() => {
              if (!session.process.killed) {
                session.process.kill('SIGTERM');
              }
            }, 100); // Small delay to allow any remaining results
            break;
          }
        }
      }
    }
  }

  private parseLine(line: string, searchType: 'files' | 'content'): SearchResult | null {
    if (searchType === 'content') {
      // Parse JSON output from content search
      try {
        const parsed = JSON.parse(line);
        
        if (parsed.type === 'match') {
          // Handle multiple submatches per line - return first submatch
          const submatch = parsed.data?.submatches?.[0];
          return {
            file: parsed.data.path.text,
            line: parsed.data.line_number,
            match: submatch?.match?.text || parsed.data.lines.text,
            type: 'content'
          };
        }
        
        if (parsed.type === 'context') {
          return {
            file: parsed.data.path.text,
            line: parsed.data.line_number,
            match: parsed.data.lines.text.trim(),
            type: 'content'
          };
        }
        
        // Handle summary to reconcile totals
        if (parsed.type === 'summary') {
          // Optional: could reconcile totalMatches with parsed.data.stats?.matchedLines
          return null;
        }
        
        return null;
      } catch (error) {
        // Skip invalid JSON lines
        return null;
      }
    } else {
      // File search - each line is a file path
      return {
        file: line.trim(),
        type: 'file'
      };
    }
  }
}

// Global search manager instance
export const searchManager = new SearchManager();

// Cleanup management - run on fixed schedule
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Start cleanup interval - now runs on fixed schedule
 */
function startCleanupIfNeeded(): void {
  if (!cleanupInterval) {
    cleanupInterval = setInterval(() => {
      searchManager.cleanupSessions();
    }, 5 * 60 * 1000);
    cleanupInterval.unref();
    
    // Also check immediately after a short delay (let search process finish).
    const initialCleanup = setTimeout(() => {
      searchManager.cleanupSessions();
    }, 1000);
    initialCleanup.unref();
  }
}