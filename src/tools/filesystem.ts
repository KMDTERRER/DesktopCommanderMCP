import fs from "fs/promises";
import path from "path";
import os from 'os';
import fetch from 'cross-fetch';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { capture } from '../utils/capture.js';
import { withTimeout, runWithAbortableTimeout } from '../utils/withTimeout.js';
import { configManager } from '../config-manager.js';
import { getFileHandler, TextFileHandler } from '../utils/files/index.js';
import type { ReadOptions, FileResult, PdfPageItem } from '../utils/files/base.js';
import { isPdfFile } from "./mime-types.js";
import { parsePdfToMarkdown, editPdf, PdfOperations, PdfMetadata, parseMarkdownToPdf } from './pdf/index.js';
import { isBinaryFile } from 'isbinaryfile';
import { getAllowedDirs, PATH_VALIDATION_TIMEOUT_MS, validatePathAuthority } from './path-security.js';
import { renameReplacingWithRetry } from '../utils/atomic-rename.js';
import { readFileBounded } from '../utils/bounded-file-read.js';
import {
    AggregateByteBudget,
    MAX_IMAGE_INPUT_BYTES,
    MAX_PDF_INPUT_BYTES,
    MAX_PDF_OUTPUT_BYTES,
    MAX_SINGLE_READ_OUTPUT_BYTES,
    MAX_TEXT_MUTATION_INPUT_BYTES,
    MAX_URL_TEXT_BYTES,
    READ_MULTIPLE_MAX_OUTPUT_BYTES,
    READ_MULTIPLE_PER_FILE_OUTPUT_BYTES,
    assertByteLengthWithin,
    base64EncodedLength,
    normalizeOutputBudget,
    pdfPayloadByteLength,
    resourceLimitError,
} from '../utils/read-resource-limits.js';

// CONSTANTS SECTION - Consolidate all timeouts and thresholds
const FILE_OPERATION_TIMEOUTS = {
    URL_FETCH: 30000,          // 30 seconds
    FILE_READ: 30000,          // 30 seconds
} as const;

// Cap file read operations at 3 minutes. The MCP client's hard per-call limit
// is ~4 minutes; timing out at 3m lets us abort the underlying fs op and return
// a useful error (e.g. the cloud-storage guidance in buildPermissionError)
// BEFORE the client gives up with an opaque "No result received after 4
// minutes". Paired with runWithAbortableTimeout so the read is actually
// cancelled (fd/thread released), not just abandoned.
export const READ_OPERATION_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
export const READ_METADATA_TIMEOUT_MS = 10 * 1000; // 10 seconds

function normalizeReadTimeout(timeoutMs: number): number {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('Read timeout must be a positive finite number.');
    }
    return Math.max(1, Math.min(READ_OPERATION_TIMEOUT_MS, Math.floor(timeoutMs)));
}

function remainingReadTimeout(deadlineAt: number, maximum = READ_OPERATION_TIMEOUT_MS): number {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
        const error = new Error('Read operation deadline exceeded.') as NodeJS.ErrnoException;
        error.code = 'ETIMEDOUT';
        throw error;
    }
    return Math.max(1, Math.min(maximum, remaining));
}

async function readHttpBodyBounded(
    response: Awaited<ReturnType<typeof fetch>>,
    maxBytes: number,
    label: string,
): Promise<Buffer> {
    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw resourceLimitError(label, maxBytes, declared);
    }
    const body = response.body as any;
    if (!body) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let total = 0;
    const push = (chunk: Uint8Array | Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
        total += bytes.length;
        if (total > maxBytes) throw resourceLimitError(label, maxBytes, total);
        chunks.push(bytes);
    };
    try {
        if (typeof body[Symbol.asyncIterator] === 'function') {
            for await (const chunk of body as AsyncIterable<Uint8Array>) push(chunk);
        } else if (typeof body.getReader === 'function') {
            const reader = body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                push(value);
            }
        } else {
            throw new Error('HTTP response body does not support bounded streaming.');
        }
    } catch (error) {
        try { body.destroy?.(error); } catch {}
        try { await body.cancel?.(error); } catch {}
        throw error;
    }
    return Buffer.concat(chunks, total);
}

const FILE_SIZE_LIMITS = {
    LINE_COUNT_LIMIT: 10 * 1024 * 1024,      // 10MB for line counting
} as const;

// UTILITY FUNCTIONS - Eliminate duplication

/**
 * Get MIME type information for a file
 * @param filePath Path to the file
 * @returns Object with mimeType and isImage properties
 */
async function getMimeTypeInfo(filePath: string): Promise<{ mimeType: string; isImage: boolean; isPdf: boolean }> {
    const { getMimeType, isImageFile, isPdfFile } = await import('./mime-types.js');
    const mimeType = getMimeType(filePath);
    const isImage = isImageFile(mimeType);
    const isPdf = isPdfFile(mimeType);
    return { mimeType, isImage, isPdf };
}

/**
 * Get file extension for telemetry purposes
 * @param filePath Path to the file
 * @returns Lowercase file extension
 */
function getFileExtension(filePath: string): string {
    return path.extname(filePath).toLowerCase();
}

/**
 * Get default read length from configuration
 * @returns Default number of lines to read
 */
async function getDefaultReadLength(): Promise<number> {
    const config = await configManager.getConfig();
    return config.fileReadLineLimit ?? 1000; // Default to 1000 lines if not set
}

/**
 * Returns a helpful error message when a file operation fails with a permission
 * or timeout error.
 *
 * Lists all common causes without path-based detection — the AI receiving this
 * error should inspect the path and inform the user which cause is most likely
 * (e.g. cloud storage folder, network drive, system file, locked file, etc.)
 */
function buildPermissionError(filePath: string, errCode: string | undefined): Error {
    const isMac = process.platform === 'darwin';
    const isTimeout = errCode === 'ETIMEDOUT';

    const lines = [
        `Cannot read file — ${isTimeout ? 'operation timed out' : 'permission denied'} (${errCode}).`,
        `Path: ${filePath}`,
        ``,
        `[AI: based on the path above, determine which cause is most likely and explain it to the user.]`,
        ``,
        `Possible causes and fixes:`,
        `  1. File is in cloud storage (Google Drive / iCloud / Dropbox / OneDrive) but not downloaded locally.`,
        `       → Right-click the file and choose "Download Now", "Make Available Offline", or "Keep on This Device".`,
        `  2. Cloud storage app is not running or not signed in.`,
        `       → Open your cloud storage app and make sure it is syncing.`,
        `  3. File is on a network drive or virtual filesystem that is currently unavailable.`,
        `       → Check that the network share or drive is mounted and accessible.`,
        `  4. File has restricted permissions (e.g. system file, locked by another process, or chmod 000).`,
        `       → Check file permissions or close any app that may have the file open.`,
        `  5. The app does not have permission to access this location (macOS Full Disk Access).`,
    ];

    if (isMac) {
        lines.push(`       → Go to System Settings → Privacy & Security → Full Disk Access and enable Claude.`);
        lines.push(`       → To open that pane directly, run in terminal:`);
        lines.push(`           open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"`);
        lines.push(`         Then find "Claude" in the list and enable the toggle next to it.`);
    } else {
        lines.push(`       → Check that the app has permission to access this file location.`);
    }

    return new Error(lines.join('\n'));
}

/**
 * Validate a path through the shared filesystem/security authority leaf.
 * Telemetry remains owned by filesystem.ts so the authority module never
 * depends back on server/capture and can be safely reused by MCP boundaries.
 */
export async function validatePath(requestedPath: string, timeoutMs?: number): Promise<string> {
    try {
        return await validatePathAuthority(requestedPath, timeoutMs);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('Path not allowed:')) {
            capture('server_path_validation_error', {
                error: 'Path not allowed',
                allowedDirsCount: (await getAllowedDirs()).length
            });
        } else if (message.startsWith('Path validation failed for path:')) {
            capture('server_path_validation_timeout', {
                timeoutMs: Math.min(PATH_VALIDATION_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs ?? PATH_VALIDATION_TIMEOUT_MS)))
            });
        }
        throw error;
    }
}
// Re-export FileResult from base for consumers
export type { FileResult } from '../utils/files/base.js';

type PdfPayload = {
    metadata: PdfMetadata;
    pages: PdfPageItem[];
}

type FileResultPayloads = PdfPayload;

/**
 * Read file content from a URL
 * @param url URL to fetch content from
 * @returns File content or file result with metadata
 */
export async function readFileFromUrl(url: string, options?: ReadOptions): Promise<FileResult> {
    const { isImageFile } = await import('./mime-types.js');
    const outputLimit = normalizeOutputBudget(options?.maxOutputBytes, MAX_SINGLE_READ_OUTPUT_BYTES);

    try {
        return await runWithAbortableTimeout(async (signal) => {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

        const contentType = response.headers.get('content-type') || 'text/plain';
        const isImage = isImageFile(contentType);
        const isPdf = isPdfFile(contentType) || url.toLowerCase().endsWith('.pdf');
        if (isImage) {
            const rawFromOutput = Math.floor(outputLimit / 4) * 3;
            const bodyLimit = Math.min(MAX_IMAGE_INPUT_BYTES, rawFromOutput);
            const buffer = await readHttpBodyBounded(response, bodyLimit, 'URL image input');
            const encodedBytes = base64EncodedLength(buffer.length);
            if (encodedBytes > outputLimit) {
                throw resourceLimitError('URL image base64 result', outputLimit, encodedBytes);
            }
            return { content: buffer.toString('base64'), mimeType: contentType, metadata: { isImage: true } };
        }
        if (isPdf) {
            const buffer = await readHttpBodyBounded(response, MAX_PDF_INPUT_BYTES, 'URL PDF input');
            const pdfResult = await parsePdfToMarkdown(new Uint8Array(buffer), [], signal);
            const pdfLimit = Math.min(outputLimit, MAX_PDF_OUTPUT_BYTES);
            const outputBytes = pdfPayloadByteLength(pdfResult.pages);
            if (outputBytes > pdfLimit) throw resourceLimitError('URL PDF result', pdfLimit, outputBytes);
            return {
                content: '',
                mimeType: 'text/plain',
                metadata: {
                    isImage: false, isPdf: true, author: pdfResult.metadata.author,
                    title: pdfResult.metadata.title, totalPages: pdfResult.metadata.totalPages, pages: pdfResult.pages
                }
            };
        }
        const buffer = await readHttpBodyBounded(
            response, Math.min(MAX_URL_TEXT_BYTES, outputLimit), 'URL text input'
        );
        const content = buffer.toString('utf8');
        assertByteLengthWithin(content, outputLimit, 'URL text result');
        return { content, mimeType: contentType, metadata: { isImage: false } };
        }, FILE_OPERATION_TIMEOUTS.URL_FETCH, `Read URL ${url}`);
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'EFBIG') throw error;
        const timedOut = err.code === 'ETIMEDOUT' || (error instanceof Error && error.name === 'AbortError');
        const errorMessage = timedOut
            ? `URL fetch timed out after ${FILE_OPERATION_TIMEOUTS.URL_FETCH}ms: ${url}`
            : `Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`;
        throw new Error(errorMessage);
    }
}

/**
 * Read file content from the local filesystem
 * @param filePath Path to the file
 * @param options Read options (offset, length, sheet, range)
 * @returns File content or file result with metadata
 */
export async function readFileFromDisk(
    filePath: string,
    options?: ReadOptions,
    operationTimeoutMs: number = READ_OPERATION_TIMEOUT_MS
): Promise<FileResult> {
    const deadlineAt = Date.now() + normalizeReadTimeout(operationTimeoutMs);
    const { offset = 0, sheet, range } = options ?? {};
    let { length } = options ?? {};

    // Add validation for required parameters
    if (!filePath || typeof filePath !== 'string') {
        throw new Error('Invalid file path provided');
    }

    // Get default length from config if not provided
    if (length === undefined) {
        length = await getDefaultReadLength();
    }

    const validPath = await validatePath(filePath, remainingReadTimeout(deadlineAt, READ_METADATA_TIMEOUT_MS));

    // Get file extension for telemetry
    const fileExtension = getFileExtension(validPath);

    // One bounded metadata probe serves both directory detection and telemetry.
    // fs.stat itself has no AbortSignal API, so the deadline bounds our response
    // even though an OS-level stat already in flight may finish in the background.
    let stats: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
        stats = await runWithAbortableTimeout(
            (_signal) => fs.stat(validPath),
            remainingReadTimeout(deadlineAt, READ_METADATA_TIMEOUT_MS),
            `Read file metadata for ${filePath}`
        );
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ETIMEDOUT') {
            throw buildPermissionError(filePath, err.code);
        }
        console.error('error catch ' + error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        capture('server_read_file_error', { error: errorMessage, fileExtension: fileExtension });
        // Non-timeout metadata failures fall through so the main read returns the canonical error.
    }

    if (stats?.isDirectory()) {
        const dirListOp = async () => {
            const entries = await listDirectory(validPath);
            const listing = entries.join('\n');
            return {
                content: `This is a directory, not a file. Use the list_directory tool instead of read_file for directories.\n\n${listing}`,
                mimeType: 'text/plain',
                metadata: { isImage: false, isDirectory: true }
            } as FileResult;
        };
        const dirResult = await withTimeout(
            dirListOp(), remainingReadTimeout(deadlineAt, FILE_OPERATION_TIMEOUTS.FILE_READ),
            'Directory listing fallback', null
        );
        if (dirResult === null) throw new Error(`Directory listing timed out for: ${filePath}`);
        return dirResult;
    }

    if (stats) {
        capture('server_read_file', { fileExtension, offset, length, fileSize: stats.size });
    }

    // Read under an abortable timeout so a hung/stalled read is cancelled
    // (fd/thread freed) rather than leaked until the OS call returns.
    const readOperation = async (signal: AbortSignal) => {
        // Get appropriate handler for this file type (async - includes binary detection)
        const handler = await getFileHandler(validPath);

        // Use handler to read the file
        const result = await handler.read(validPath, {
            offset,
            length,
            sheet,
            range,
            includeStatusMessage: true,
            signal,
            maxOutputBytes: options?.maxOutputBytes
        });

        // Return with content as string
        // For images: content is already base64-encoded string from handler
        // For text: content may be string or Buffer, convert to UTF-8 string
        let content: string;
        if (typeof result.content === 'string') {
            content = result.content;
        } else if (result.metadata?.isImage) {
            // Image buffer should be base64 encoded, not UTF-8 converted
            content = result.content.toString('base64');
        } else {
            content = result.content.toString('utf8');
        }

        return {
            content,
            mimeType: result.mimeType,
            metadata: result.metadata
        };
    };

    // Execute with a 3-minute, cancellable timeout
    let result;
    try {
        result = await runWithAbortableTimeout(
            (signal) => readOperation(signal),
            remainingReadTimeout(deadlineAt),
            `Read file operation for ${filePath}`
        );
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        // runWithAbortableTimeout rejects with an Error whose .code is 'ETIMEDOUT'
        // on timeout; fs rejects with EPERM/EACCES. Map all to the guidance error.
        if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ETIMEDOUT') {
            throw buildPermissionError(filePath, err.code);
        }
        throw error;
    }

    if (result == null) {
        // Handles the impossible case where withTimeout resolves to null instead of throwing
        throw new Error('Failed to read the file');
    }

    return result;
}

/**
 * Read a file from either the local filesystem or a URL
 * @param filePath Path to the file or URL
 * @param options Read options (isUrl, offset, length, sheet, range)
 * @returns File content or file result with metadata
 */
export async function readFile(
    filePath: string,
    options?: ReadOptions,
    operationTimeoutMs: number = READ_OPERATION_TIMEOUT_MS
): Promise<FileResult> {
    const { isUrl, offset, length, sheet, range, maxOutputBytes } = options ?? {};
    return isUrl
        ? readFileFromUrl(filePath, { ...options, maxOutputBytes })
        : readFileFromDisk(filePath, { offset, length, sheet, range, maxOutputBytes }, operationTimeoutMs);
}

/**
 * Read file content without status messages for internal operations
 * This function preserves exact file content including original line endings,
 * which is essential for edit operations that need to maintain file formatting.
 * @param filePath Path to the file
 * @param offset Starting line number to read from (default: 0)
 * @param length Maximum number of lines to read (default: from config or 1000)
 * @returns File content without status headers, with preserved line endings
 */
export async function readFileInternal(filePath: string, offset: number = 0, length?: number): Promise<string> {
    // Get default length from config if not provided
    if (length === undefined) {
        length = await getDefaultReadLength();
    }

    const validPath = await validatePath(filePath);

    // Get file extension and MIME type
    const fileExtension = getFileExtension(validPath);
    const { mimeType, isImage } = await getMimeTypeInfo(validPath);

    if (isImage) {
        throw new Error('Cannot read image files as text for internal operations');
    }

    // IMPORTANT: For internal operations (especially edit operations), we must
    // preserve exact file content including original line endings.
    // We cannot use readline-based reading as it strips line endings.

    // Read entire file content preserving line endings, under a 3-minute,
    // cancellable timeout so an edit on a stalled/cloud path can't hang forever
    // (previously this read had no timeout at all).
    const contentBuffer = await runWithAbortableTimeout(
        (signal) => readFileBounded(validPath, MAX_TEXT_MUTATION_INPUT_BYTES, signal, 'Internal text mutation input'),
        READ_OPERATION_TIMEOUT_MS,
        `Internal read for ${filePath}`
    );
    const content = contentBuffer.toString('utf8');

    // If we need to apply offset/length, do it while preserving line endings
    if (offset === 0 && length >= Number.MAX_SAFE_INTEGER) {
        // Most common case for edit operations: read entire file
        return content;
    }

    // Handle offset/length by splitting on line boundaries while preserving line endings
    const lines = TextFileHandler.splitLinesPreservingEndings(content);

    // Apply offset and length
    const selectedLines = lines.slice(offset, offset + length);

    // Join back together (this preserves the original line endings)
    return selectedLines.join('');
}

export async function writeFile(filePath: string, content: string, mode: 'rewrite' | 'append' = 'rewrite'): Promise<void> {
    const validPath = await validatePath(filePath);

    // Get file extension for telemetry
    const fileExtension = getFileExtension(validPath);

    // Calculate content metrics
    const contentBytes = Buffer.from(content).length;
    const lineCount = TextFileHandler.countLines(content);

    // Capture file extension and operation details in telemetry without capturing the file path
    capture('server_write_file', {
        fileExtension: fileExtension,
        mode: mode,
        contentBytes: contentBytes,
        lineCount: lineCount
    });

    // Get appropriate handler for this file type (async - includes binary detection)
    const handler = await getFileHandler(validPath);

    // Use handler to write the file
    await handler.write(validPath, content, mode);
}

export interface MultiFileResult {
    path: string;
    content?: string;
    mimeType?: string;
    isImage?: boolean;
    error?: string;
    isPdf?: boolean;
    payload?: FileResultPayloads;
}

const READ_MULTIPLE_FILES_CONCURRENCY = 8;

function multiFileResultByteLength(result: MultiFileResult): number {
    let total = result.content ? Buffer.byteLength(result.content, 'utf8') : 0;
    if (result.payload?.pages) total += pdfPayloadByteLength(result.payload.pages);
    return total;
}

export async function readMultipleFiles(
    paths: string[],
    operationTimeoutMs: number = READ_OPERATION_TIMEOUT_MS
): Promise<MultiFileResult[]> {
    const deadlineAt = Date.now() + normalizeReadTimeout(operationTimeoutMs);
    const results = new Array<MultiFileResult>(paths.length);
    const budget = new AggregateByteBudget(READ_MULTIPLE_MAX_OUTPUT_BYTES);
    let nextIndex = 0;
    const worker = async () => {
        for (;;) {
            const index = nextIndex++;
            if (index >= paths.length) return;
            const filePath = paths[index];
            let lease: { maxBytes: number; commit(bytes: number): void; release(): void } | undefined;
            try {
                lease = await budget.acquire(READ_MULTIPLE_PER_FILE_OUTPUT_BYTES);
                const fileResult = await readFile(
                    filePath, { maxOutputBytes: lease.maxBytes }, remainingReadTimeout(deadlineAt)
                );
                let content: string;
                if (typeof fileResult.content === 'string') content = fileResult.content;
                else if (fileResult.metadata?.isImage) content = fileResult.content.toString('base64');
                else content = fileResult.content.toString('utf8');

                const item: MultiFileResult = {
                    path: filePath, content, mimeType: fileResult.mimeType,
                    isImage: fileResult.metadata?.isImage ?? false,
                    isPdf: fileResult.metadata?.isPdf ?? false,
                    payload: fileResult.metadata?.isPdf ? {
                        metadata: {
                            author: fileResult.metadata.author, title: fileResult.metadata.title,
                            totalPages: fileResult.metadata.totalPages ?? 0
                        },
                        pages: fileResult.metadata.pages ?? []
                    } : undefined
                };
                lease.commit(multiFileResultByteLength(item));
                lease = undefined;
                results[index] = item;
            } catch (error) {
                lease?.release();
                const errorMessage = error instanceof Error ? error.message : String(error);
                results[index] = { path: filePath, error: errorMessage };
            }
        }
    };
    const workers = Math.min(READ_MULTIPLE_FILES_CONCURRENCY, paths.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return results;
}

export async function createDirectory(dirPath: string): Promise<void> {
    const validPath = await validatePath(dirPath);
    await fs.mkdir(validPath, { recursive: true });
}

export async function listDirectory(dirPath: string, depth: number = 2): Promise<string[]> {
    if (!Number.isInteger(depth) || depth < 1 || depth > 10) {
        throw new Error('Directory listing depth must be an integer from 1 to 10.');
    }
    const validPath = await validatePath(dirPath);
    const results: string[] = [];
    const MAX_NESTED_ITEMS = 100;
    const MAX_DIRECTORY_RESULTS = 2000;
    const MAX_DIRECTORY_OUTPUT_BYTES = 1024 * 1024;
    const WARNING_RESERVE_BYTES = 256;
    let retainedBytes = 0;
    let globallyTruncated = false;

    const appendResult = (line: string): boolean => {
        const bytes = Buffer.byteLength(line, 'utf8') + 1;
        if (results.length >= MAX_DIRECTORY_RESULTS - 1 ||
            retainedBytes + bytes > MAX_DIRECTORY_OUTPUT_BYTES - WARNING_RESERVE_BYTES) {
            globallyTruncated = true;
            return false;
        }
        results.push(line);
        retainedBytes += bytes;
        return true;
    };

    async function listRecursive(currentPath: string, currentDepth: number, relativePath = '', isTopLevel = true): Promise<void> {
        if (currentDepth <= 0 || globallyTruncated) return;
        let directory;
        try {
            directory = await fs.opendir(currentPath);
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            const displayPath = relativePath || path.basename(currentPath);
            if (err.code === 'ENOENT') appendResult(`[NOT_FOUND] ${displayPath} — path does not exist`);
            else if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ETIMEDOUT') {
                appendResult(`[DENIED] ${displayPath} — not accessible (permission denied, cloud-only file, or Full Disk Access not granted)`);
            } else appendResult(`[DENIED] ${displayPath}`);
            return;
        }

        let shownHere = 0;
        let nestedTruncated = false;
        try {
            for await (const entry of directory) {
                if (globallyTruncated) break;
                if (!isTopLevel && shownHere >= MAX_NESTED_ITEMS) { nestedTruncated = true; break; }
                const fullPath = path.join(currentPath, entry.name);
                const displayPath = relativePath ? path.join(relativePath, entry.name) : entry.name;
                if (!appendResult(`${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${displayPath}`)) break;
                shownHere += 1;
                if (entry.isDirectory() && currentDepth > 1) {
                    try {
                        await validatePath(fullPath);
                        await listRecursive(fullPath, currentDepth - 1, displayPath, false);
                    } catch {
                        continue;
                    }
                }
            }
        } finally {
            await directory.close().catch(() => {});
        }
        if (nestedTruncated && !globallyTruncated) {
            appendResult(`[WARNING] ${relativePath || path.basename(currentPath)}: additional items hidden (showing first ${MAX_NESTED_ITEMS}; listing is bounded)`);
        }
    }

    await listRecursive(validPath, depth, '', true);
    if (globallyTruncated) {
        const warning = '[WARNING] Directory listing truncated by the global 2000-item / 1 MiB output limit. Use search for narrower discovery.';
        while (results.length > 0 && retainedBytes + Buffer.byteLength(warning, 'utf8') + 1 > MAX_DIRECTORY_OUTPUT_BYTES) {
            const removed = results.pop()!;
            retainedBytes -= Buffer.byteLength(removed, 'utf8') + 1;
        }
        if (results.length < MAX_DIRECTORY_RESULTS) results.push(warning);
    }
    return results;
}

export async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
    const validSourcePath = await validatePath(sourcePath);
    const validDestPath = await validatePath(destinationPath);
    await renameReplacingWithRetry(validSourcePath, validDestPath);
}

export async function searchFiles(rootPath: string, pattern: string): Promise<string[]> {
    // Use the new search manager for better performance
    // This provides a temporary compatibility layer until we fully migrate to search sessions
    const { searchManager } = await import('../search-manager.js');

    try {
        const result = await searchManager.startSearch({
            rootPath,
            pattern,
            searchType: 'files',
            ignoreCase: true,
            maxResults: 5000, // Higher limit for compatibility
            earlyTermination: true, // Use early termination for better performance
        });

        const sessionId = result.sessionId;

        // Poll for results until complete
        const allResults: string[] = [];
        let isComplete = result.isComplete;
        const startTime = Date.now();
        let nextOffset = result.results.length;

        // Add initial results
        for (const searchResult of result.results) {
            if (searchResult.type === 'file') {
                allResults.push(searchResult.file);
            }
        }

        while (!isComplete) {
            await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms

            const results = searchManager.readSearchResults(sessionId, nextOffset, 1000);
            isComplete = results.isComplete;

            for (const searchResult of results.results) {
                if (searchResult.file !== '__LAST_READ_MARKER__' && searchResult.type === 'file') {
                    allResults.push(searchResult.file);
                }
            }
            nextOffset += results.returnedCount;

            // Safety check to prevent infinite loops (30 second timeout)
            if (Date.now() - startTime > 30000) {
                searchManager.terminateSearch(sessionId);
                break;
            }
        }

        // Log only the count of found files, not their paths
        capture('server_search_files_complete', {
            resultsCount: allResults.length,
            patternLength: pattern.length,
            usedRipgrep: true
        });

        return allResults;
    } catch (error) {
        // Fallback to original Node.js implementation if ripgrep fails
        capture('server_search_files_ripgrep_fallback', {
            error: error instanceof Error ? error.message : 'Unknown error'
        });

        return await searchFilesNodeJS(rootPath, pattern);
    }
}

// Keep the original Node.js implementation as fallback
async function searchFilesNodeJS(rootPath: string, pattern: string): Promise<string[]> {
    const results: string[] = [];
    const maxResults = 5000;

    async function search(currentPath: string): Promise<void> {
        if (results.length >= maxResults) return;
        let directory;
        try { directory = await fs.opendir(currentPath); }
        catch { return; }

        try {
            for await (const entry of directory) {
                if (results.length >= maxResults) break;
                const fullPath = path.join(currentPath, entry.name);
                try {
                    await validatePath(fullPath);
                    if (entry.name.toLowerCase().includes(pattern.toLowerCase())) results.push(fullPath);
                    if (entry.isDirectory()) await search(fullPath);
                } catch {
                    continue;
                }
            }
        } finally {
            await directory.close().catch(() => {});
        }
    }

    try {
        // Validate root path before starting search
        const validPath = await validatePath(rootPath);
        await search(validPath);

        // Log only the count of found files, not their paths
        capture('server_search_files_complete', {
            resultsCount: results.length,
            patternLength: pattern.length,
            usedRipgrep: false
        });

        return results;
    } catch (error) {
        // For telemetry only - sanitize error info
        capture('server_search_files_error', {
            errorType: error instanceof Error ? error.name : 'Unknown',
            error: 'Error with root path',
            isRootPathError: true
        });

        // Re-throw the original error for the caller
        throw error;
    }
}

export async function getFileInfo(filePath: string): Promise<Record<string, any>> {
    const validPath = await validatePath(filePath);

    // Bound metadata before the type-specific handler. A stalled network/cloud
    // path must not wedge get_file_info (or write_file's safety preflight).
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
        stats = await runWithAbortableTimeout(
            (_signal) => fs.stat(validPath),
            READ_METADATA_TIMEOUT_MS,
            `Get file metadata for ${filePath}`,
        );
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ETIMEDOUT') throw buildPermissionError(filePath, err.code);
        throw error;
    }
    const fallbackInfo = {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        permissions: stats.mode.toString(8).slice(-3),
        fileType: 'text' as const,
        metadata: undefined as Record<string, any> | undefined,
    };

    // Get appropriate handler for this file type (async - includes binary detection)
    const handler = await getFileHandler(validPath);

    // Use handler to get file info, with fallback
    let fileInfo;
    try {
        fileInfo = await runWithAbortableTimeout(
            (_signal) => handler.getInfo(validPath),
            READ_METADATA_TIMEOUT_MS,
            `Get typed file info for ${filePath}`,
        );
    } catch (error) {
        // Type-specific metadata is optional; a slow/failing parser must not
        // prevent the already-confirmed filesystem metadata from returning.
        fileInfo = fallbackInfo;
    }

    // Convert to legacy format (for backward compatibility)
    // Use handler values with fallback to fs.stat values for any missing fields
    const info: Record<string, any> = {
        size: fileInfo.size ?? fallbackInfo.size,
        created: fileInfo.created ?? fallbackInfo.created,
        modified: fileInfo.modified ?? fallbackInfo.modified,
        accessed: fileInfo.accessed ?? fallbackInfo.accessed,
        isDirectory: fileInfo.isDirectory ?? fallbackInfo.isDirectory,
        isFile: fileInfo.isFile ?? fallbackInfo.isFile,
        permissions: fileInfo.permissions ?? fallbackInfo.permissions,
        fileType: fileInfo.fileType ?? fallbackInfo.fileType,
    };

    // Add type-specific metadata from file handler
    if (fileInfo.metadata) {
        // For text files
        if (fileInfo.metadata.lineCount !== undefined) {
            info.lineCount = fileInfo.metadata.lineCount;
            info.lastLine = fileInfo.metadata.lineCount - 1;
            info.appendPosition = fileInfo.metadata.lineCount;
        }

        // For Excel files
        if (fileInfo.metadata.sheets) {
            info.sheets = fileInfo.metadata.sheets;
            info.isExcelFile = true;
        }

        // For images
        if (fileInfo.metadata.isImage) {
            info.isImage = true;
        }

        // For PDF files
        if (fileInfo.metadata.isPdf) {
            info.isPdf = true;
            info.totalPages = fileInfo.metadata.totalPages;
            if (fileInfo.metadata.title) info.title = fileInfo.metadata.title;
            if (fileInfo.metadata.author) info.author = fileInfo.metadata.author;
        }

        // For binary files
        if (fileInfo.metadata.isBinary) {
            info.isBinary = true;
        }
    }

    return info;
}


/**
 * Write content to a PDF file.
 * Can create a new PDF from Markdown string, or modify an existing PDF using operations.
 * 
 * @param filePath Path to the output PDF file
 * @param content Markdown string (for creation) or array of operations (for modification)
 * @param options Options for PDF generation or modification. For modification, can include `sourcePdf`.
 */
export async function writePdf(
    filePath: string,
    content: string | PdfOperations[],
    outputPath?: string,
    options: any = {}
): Promise<void> {
    const validPath = await validatePath(filePath);
    const fileExtension = getFileExtension(validPath);

    if (typeof content === 'string') {
        // --- PDF CREATION MODE ---
        capture('server_write_pdf', {
            fileExtension: fileExtension,
            contentLength: content.length,
            mode: 'create'
        });

        const pdfBuffer = await parseMarkdownToPdf(content, options);
        // Use outputPath if provided, otherwise overwrite input file
        const targetPath = outputPath ? await validatePath(outputPath) : validPath;
        await fs.writeFile(targetPath, pdfBuffer);
    } else if (Array.isArray(content)) {

        // Use outputPath if provided, otherwise overwrite input file
        const targetPath = outputPath ? await validatePath(outputPath) : validPath;

        const operations: PdfOperations[] = [];

        // Validate paths in operations
        for (const o of content) {
            if (o.type === 'insert') {
                if (o.sourcePdfPath) {
                    o.sourcePdfPath = await validatePath(o.sourcePdfPath);
                }
            }
            operations.push(o);
        }

        capture('server_write_pdf', {
            fileExtension: fileExtension,
            operationCount: operations.length,
            mode: 'modify',
            deleteCount: operations.filter(op => op.type === 'delete').length,
            insertCount: operations.filter(op => op.type === 'insert').length
        });

        // Perform the PDF editing
        const modifiedPdfBuffer = await editPdf(validPath, operations);

        // Write the modified PDF to the output path
        await fs.writeFile(targetPath, modifiedPdfBuffer);
    } else {
        throw new Error('Invalid content type for writePdf. Expected string (markdown) or array of operations.');
    }
}

const execFileAsync = promisify(execFile);
type DefaultEditorMetadata = { defaultEditorName?: string; defaultEditorPath?: string };
type DefaultEditorCacheEntry = { metadata: DefaultEditorMetadata; expiresAt?: number };
const DEFAULT_EDITOR_NEGATIVE_CACHE_MS = 5 * 60 * 1000;
const defaultEditorCache = new Map<string, DefaultEditorCacheEntry>();

function escapeAppleScriptString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function getDefaultEditorMetadata(filePath: string): Promise<DefaultEditorMetadata> {
    if (os.platform() !== 'darwin') {
        return {};
    }

    let cacheKey = '';
    try {
        const extension = path.extname(filePath).toLowerCase();
        cacheKey = extension || path.basename(filePath).toLowerCase();
        const cached = defaultEditorCache.get(cacheKey);
        if (cached) {
            if (!cached.expiresAt || cached.expiresAt > Date.now()) {
                return cached.metadata;
            }
            defaultEditorCache.delete(cacheKey);
        }

        const script = `set appAlias to default application of (info for POSIX file "${escapeAppleScriptString(filePath)}")\nreturn (name of (info for appAlias)) & linefeed & POSIX path of appAlias`;
        const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 12000 });
        const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
        const defaultEditorName = lines[lines.length - 2]?.replace(/\.app$/i, '') ?? '';
        const defaultEditorPath = lines[lines.length - 1] ?? '';

        if (defaultEditorName && defaultEditorPath.startsWith('/')) {
            const metadata = { defaultEditorName, defaultEditorPath };
            defaultEditorCache.set(cacheKey, { metadata });
            return metadata;
        }

        defaultEditorCache.set(cacheKey, { metadata: {}, expiresAt: Date.now() + DEFAULT_EDITOR_NEGATIVE_CACHE_MS });
    } catch {
        if (cacheKey) {
            defaultEditorCache.set(cacheKey, { metadata: {}, expiresAt: Date.now() + DEFAULT_EDITOR_NEGATIVE_CACHE_MS });
        }
        // Generic UI fallback is good enough if detection fails.
    }

    return {};
}
