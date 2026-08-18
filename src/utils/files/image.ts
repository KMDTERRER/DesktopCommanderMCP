/**
 * Image file handler
 * Handles reading image files and converting to base64
 */

import fs from "fs/promises";
import { readFileBounded } from '../bounded-file-read.js';
import {
    MAX_IMAGE_INPUT_BYTES,
    MAX_SINGLE_READ_OUTPUT_BYTES,
    base64EncodedLength,
    normalizeOutputBudget,
    resourceLimitError,
} from '../read-resource-limits.js';
import {
    FileHandler,
    ReadOptions,
    FileResult,
    FileInfo,
    WriteOptions
} from './base.js';

/**
 * Image file handler implementation
 * Supports: PNG, JPEG, GIF, WebP, BMP, SVG
 */
export class ImageFileHandler implements FileHandler {
    private static readonly IMAGE_EXTENSIONS = [
        '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'
    ];

    private static readonly IMAGE_MIME_TYPES: { [key: string]: string } = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml'
    };

    canHandle(path: string): boolean {
        const lowerPath = path.toLowerCase();
        return ImageFileHandler.IMAGE_EXTENSIONS.some(ext => lowerPath.endsWith(ext));
    }

    async read(path: string, options?: ReadOptions): Promise<FileResult> {
        // Image tool results are inline base64, so fence both the raw input and
        // the expanded representation before materializing either one.
        const outputLimit = normalizeOutputBudget(options?.maxOutputBytes, MAX_SINGLE_READ_OUTPUT_BYTES);
        const stats = await fs.stat(path);
        if (stats.size > MAX_IMAGE_INPUT_BYTES) {
            throw resourceLimitError('Image input', MAX_IMAGE_INPUT_BYTES, stats.size);
        }
        const encodedBytes = base64EncodedLength(stats.size);
        if (encodedBytes > outputLimit) {
            throw resourceLimitError('Image base64 result', outputLimit, encodedBytes);
        }
        const signal = options?.signal ?? new AbortController().signal;
        const buffer = await readFileBounded(path, stats.size, signal, 'Image input');
        const content = buffer.toString('base64');
        const mimeType = this.getMimeType(path);

        return {
            content,
            mimeType,
            metadata: {
                isImage: true
            }
        };
    }

    async write(
        path: string, content: Buffer | string, mode?: 'rewrite' | 'append', options?: WriteOptions,
    ): Promise<void> {
        if (mode === 'append') {
            throw new Error('Image append is not supported; appending bytes would corrupt the image. Use mode=rewrite.');
        }
        const buffer = typeof content === 'string' ? Buffer.from(content, 'base64') : content;
        await fs.writeFile(path, buffer, { signal: options?.signal, flush: true });
    }

    async getInfo(path: string): Promise<FileInfo> {
        const stats = await fs.stat(path);

        return {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            permissions: stats.mode.toString(8).slice(-3),
            fileType: 'image',
            metadata: {
                isImage: true
            }
        };
    }

    /**
     * Get MIME type for image based on file extension
     */
    private getMimeType(path: string): string {
        const lowerPath = path.toLowerCase();
        for (const [ext, mimeType] of Object.entries(ImageFileHandler.IMAGE_MIME_TYPES)) {
            if (lowerPath.endsWith(ext)) {
                return mimeType;
            }
        }
        return 'application/octet-stream'; // Fallback
    }
}
