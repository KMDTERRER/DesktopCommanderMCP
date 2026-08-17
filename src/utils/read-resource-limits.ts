const MiB = 1024 * 1024;

export const MAX_IMAGE_INPUT_BYTES = 16 * MiB;
export const MAX_PDF_INPUT_BYTES = 32 * MiB;
export const MAX_PDF_OUTPUT_BYTES = 32 * MiB;
export const MAX_DOCX_INPUT_BYTES = 32 * MiB;
export const MAX_DOCX_XML_BYTES = 16 * MiB;
export const MAX_DOCX_TOTAL_UNCOMPRESSED_BYTES = 64 * MiB;
export const MAX_DOCX_ARCHIVE_ENTRIES = 4096;
export const MAX_DOCX_OUTPUT_BYTES = 8 * MiB;
export const MAX_EXCEL_INPUT_BYTES = 10 * MiB;
export const MAX_EXCEL_ARCHIVE_ENTRIES = 4096;
export const MAX_EXCEL_UNCOMPRESSED_BYTES = 64 * MiB;
export const MAX_EXCEL_OUTPUT_BYTES = 8 * MiB;
export const MAX_TEXT_LINE_BYTES = 8 * MiB;
export const MAX_TEXT_READ_OUTPUT_BYTES = 8 * MiB;
export const MAX_TEXT_MUTATION_INPUT_BYTES = 16 * MiB;
export const MAX_URL_TEXT_BYTES = 8 * MiB;
export const MAX_SINGLE_READ_OUTPUT_BYTES = 32 * MiB;
export const READ_MULTIPLE_MAX_OUTPUT_BYTES = 32 * MiB;
export const READ_MULTIPLE_PER_FILE_OUTPUT_BYTES = 8 * MiB;

export function resourceLimitError(label: string, limit: number, actual?: number): NodeJS.ErrnoException {
  const actualText = actual === undefined ? '' : ` (observed ${actual} bytes)`;
  const error = new Error(`${label} exceeds the ${limit}-byte resource limit${actualText}.`) as NodeJS.ErrnoException;
  error.code = 'EFBIG';
  return error;
}

export function base64EncodedLength(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

export function normalizeOutputBudget(requested: number | undefined, hardMaximum: number): number {
  if (requested === undefined) return hardMaximum;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error('Read output budget must be a positive finite number.');
  }
  return Math.max(1, Math.min(hardMaximum, Math.floor(requested)));
}

export function assertByteLengthWithin(value: string | Buffer, limit: number, label: string): number {
  const bytes = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.length;
  if (bytes > limit) throw resourceLimitError(label, limit, bytes);
  return bytes;
}

export function pdfPayloadByteLength(pages: Array<{ text?: string; images?: Array<{ data?: string }> }> = []): number {
  let total = 0;
  for (const page of pages) {
    total += Buffer.byteLength(page.text ?? '', 'utf8');
    for (const image of page.images ?? []) total += Buffer.byteLength(image.data ?? '', 'utf8');
  }
  return total;
}

export interface ByteBudgetLease {
  readonly maxBytes: number;
  commit(actualBytes: number): void;
  release(): void;
}

export class AggregateByteBudget {
  private committed = 0;
  private reserved = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Aggregate byte budget must be positive.');
  }

  get usedBytes(): number { return this.committed; }

  async acquire(maxBytes: number): Promise<ByteBudgetLease> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Reservation size must be positive.');
    for (;;) {
      const available = this.limit - this.committed - this.reserved;
      if (available > 0) {
        const reservation = Math.min(maxBytes, available);
        this.reserved += reservation;
        return this.createLease(reservation);
      }
      if (this.committed >= this.limit) throw resourceLimitError('Aggregate read result', this.limit, this.committed);
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wakeWaiters(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private createLease(reservation: number): ByteBudgetLease {
    let settled = false;
    const finish = (actualBytes: number | null) => {
      if (settled) return;
      settled = true;
      this.reserved -= reservation;
      if (actualBytes !== null) {
        if (!Number.isSafeInteger(actualBytes) || actualBytes < 0 || actualBytes > reservation) {
          this.wakeWaiters();
          throw resourceLimitError('Reserved read result', reservation, actualBytes);
        }
        this.committed += actualBytes;
      }
      this.wakeWaiters();
    };
    return {
      maxBytes: reservation,
      commit: (actualBytes) => finish(actualBytes),
      release: () => finish(null),
    };
  }
}
