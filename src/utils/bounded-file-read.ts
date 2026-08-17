import { createReadStream } from 'fs';

export function readFileBounded(
  filePath: string,
  maxBytes: number,
  signal: AbortSignal,
  label = 'File',
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('readFileBounded.maxBytes must be a non-negative safe integer.');
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = createReadStream(filePath, { start: 0, end: maxBytes, signal });
    stream.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        const error = new Error(`${label} exceeds ${maxBytes} bytes: ${filePath}`) as NodeJS.ErrnoException;
        error.code = 'EFBIG';
        stream.destroy(error);
        return;
      }
      chunks.push(bytes);
    });
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks, total)));
  });
}
