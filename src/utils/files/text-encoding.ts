import fs from 'fs/promises';
import { StringDecoder } from 'string_decoder';
import { Transform } from 'stream';

export type Utf16BomEncoding = 'utf16le' | 'utf16be';

export function detectUtf16Bom(buffer: Uint8Array): Utf16BomEncoding | null {
    if (buffer.length < 2) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le';
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf16be';
    return null;
}

export async function detectUtf16BomFile(filePath: string): Promise<Utf16BomEncoding | null> {
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
        handle = await fs.open(filePath, 'r');
        const prefix = Buffer.alloc(2);
        const { bytesRead } = await handle.read(prefix, 0, 2, 0);
        return detectUtf16Bom(prefix.subarray(0, bytesRead));
    } catch {
        // Classification is advisory: missing/new/unreadable targets must fall
        // through to the normal handler, which owns the canonical operation error.
        return null;
    } finally {
        await handle?.close().catch(() => {});
    }
}

export function decodeTextBuffer(buffer: Buffer): string {
    const encoding = detectUtf16Bom(buffer);
    if (!encoding) return buffer.toString('utf8');
    const body = buffer.subarray(2);
    if (encoding === 'utf16le') return body.toString('utf16le');
    const swapped = Buffer.allocUnsafe(body.length);
    for (let i = 0; i + 1 < body.length; i += 2) { swapped[i] = body[i + 1]; swapped[i + 1] = body[i]; }
    if (body.length % 2 !== 0) swapped[body.length - 1] = body[body.length - 1];
    return swapped.toString('utf16le');
}

export function createUtf16DecodeTransform(encoding: Utf16BomEncoding): Transform {
    const decoder = new StringDecoder('utf16le');
    let carry = Buffer.alloc(0);
    return new Transform({
        transform(chunk: Buffer, _sourceEncoding, callback) {
            let bytes = carry.length ? Buffer.concat([carry, chunk]) : Buffer.from(chunk);
            carry = bytes.length % 2 === 0 ? Buffer.alloc(0) : bytes.subarray(bytes.length - 1);
            bytes = bytes.subarray(0, bytes.length - carry.length);
            if (encoding === 'utf16be') {
                const swapped = Buffer.allocUnsafe(bytes.length);
                for (let i = 0; i < bytes.length; i += 2) { swapped[i] = bytes[i + 1]; swapped[i + 1] = bytes[i]; }
                bytes = swapped;
            }
            this.push(decoder.write(bytes));
            callback();
        },
        flush(callback) {
            if (carry.length) return callback(new Error('Truncated UTF-16 code unit at end of file'));
            const tail = decoder.end();
            if (tail) this.push(tail);
            callback();
        },
    });
}
