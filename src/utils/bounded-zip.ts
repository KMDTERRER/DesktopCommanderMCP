import { resourceLimitError } from './read-resource-limits.js';

export interface ZipPreflightLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxSelectedUncompressedBytes?: number;
  selectEntry?: (name: string) => boolean;
  label: string;
}

function findZipEocd(buf: Buffer, label: string): number {
  const minimum = Math.max(0, buf.length - 65_557);
  for (let offset = buf.length - 22; offset >= minimum; offset -= 1) {
    if (buf.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = buf.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buf.length) return offset;
  }
  throw new Error(`Invalid ${label}: ZIP end-of-central-directory record not found`);
}

export function preflightZipContainer(buf: Buffer, limits: ZipPreflightLimits): void {
  if (buf.length < 22) throw new Error(`Invalid ${limits.label}: ZIP archive is too small`);
  const eocd = findZipEocd(buf, limits.label);
  const diskNumber = buf.readUInt16LE(eocd + 4);
  const centralDisk = buf.readUInt16LE(eocd + 6);
  const diskEntries = buf.readUInt16LE(eocd + 8);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error(`Multi-disk ${limits.label} ZIP archives are not supported`);
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error(`ZIP64 ${limits.label} archives are not accepted by the bounded reader`);
  }
  if (totalEntries > limits.maxEntries) {
    throw resourceLimitError(`${limits.label} archive entry count`, limits.maxEntries, totalEntries);
  }
  if (centralOffset + centralSize > eocd || centralOffset > buf.length) {
    throw new Error(`Invalid ${limits.label} ZIP central-directory bounds`);
  }

  let cursor = centralOffset;
  let totalUncompressed = 0;
  let selectedUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Invalid ${limits.label} ZIP central-directory entry ${index}`);
    }
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const fileNameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    if (uncompressedSize === 0xffffffff) {
      throw new Error(`ZIP64 ${limits.label} entries are not accepted by the bounded reader`);
    }
    const next = cursor + 46 + fileNameLength + extraLength + commentLength;
    const centralEnd = centralOffset + centralSize;
    if (next > centralEnd || next > buf.length) {
      throw new Error(`Invalid ${limits.label} ZIP entry bounds at index ${index}`);
    }

    totalUncompressed += uncompressedSize;
    if (!Number.isSafeInteger(totalUncompressed) || totalUncompressed > limits.maxTotalUncompressedBytes) {
      throw resourceLimitError(
        `${limits.label} total uncompressed content`, limits.maxTotalUncompressedBytes, totalUncompressed
      );
    }

    if (limits.selectEntry) {
      const name = buf.toString('utf8', cursor + 46, cursor + 46 + fileNameLength);
      if (limits.selectEntry(name)) {
        selectedUncompressed += uncompressedSize;
        const selectedLimit = limits.maxSelectedUncompressedBytes ?? limits.maxTotalUncompressedBytes;
        if (!Number.isSafeInteger(selectedUncompressed) || selectedUncompressed > selectedLimit) {
          throw resourceLimitError(
            `${limits.label} selected uncompressed content`, selectedLimit, selectedUncompressed
          );
        }
      }
    }
    cursor = next;
  }
}
