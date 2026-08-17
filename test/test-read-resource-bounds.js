import assert from 'assert';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import PizZip from 'pizzip';
import { configManager } from '../dist/config-manager.js';
import { readFile, readFileInternal, readMultipleFiles } from '../dist/tools/filesystem.js';
import { editPdf } from '../dist/tools/pdf/manipulations.js';
import { PdfFileHandler } from '../dist/utils/files/pdf.js';

const MiB = 1024 * 1024;
const BATCH_LIMIT = 32 * MiB;

function batchContentBytes(results) {
  return results.reduce((total, result) => {
    let bytes = result.content ? Buffer.byteLength(result.content, 'utf8') : 0;
    for (const page of result.payload?.pages ?? []) {
      bytes += Buffer.byteLength(page.text ?? '', 'utf8');
      for (const image of page.images ?? []) bytes += Buffer.byteLength(image.data ?? '', 'utf8');
    }
    return total + bytes;
  }, 0);
}

async function expectResourceRejection(operation, label) {
  await assert.rejects(operation, /exceed|limit|budget|too large/i, label);
}
async function main() {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-dc-read-bounds-'));
  const originalAllowed = (await configManager.getConfig()).allowedDirectories;
  try {
    await configManager.setValue('allowedDirectories', [root]);

    const batchFiles = [];
    const sixMiBLine = 'a'.repeat(6 * MiB);
    for (let index = 0; index < 6; index += 1) {
      const file = path.join(root, `batch-${index}.txt`);
      await fs.writeFile(file, sixMiBLine, 'utf8');
      batchFiles.push(file);
    }
    const batch = await readMultipleFiles(batchFiles);
    const batchBytes = batchContentBytes(batch);
    assert(batchBytes <= BATCH_LIMIT, `batch retained ${batchBytes} bytes; expected <= ${BATCH_LIMIT}`);
    assert(batch.some((result) => result.error), 'oversized aggregate batch should fail closed for at least one item');

    const imagePath = path.join(root, 'oversized.png');
    await fs.writeFile(imagePath, Buffer.alloc(17 * MiB, 0x41));
    await expectResourceRejection(readFile(imagePath), 'oversized image must be rejected before base64 expansion');

    const hugeLinePath = path.join(root, 'huge-line.txt');
    await fs.writeFile(hugeLinePath, 'z'.repeat(9 * MiB), 'utf8');
    await expectResourceRejection(readFile(hugeLinePath), 'single huge text line must not bypass output bounds');

    const mutationTextPath = path.join(root, 'oversized-mutation.txt');
    await fs.writeFile(mutationTextPath, 'm'.repeat(17 * MiB), 'utf8');
    await expectResourceRejection(
      readFileInternal(mutationTextPath, 0, Number.MAX_SAFE_INTEGER),
      'legacy text mutation input must be bounded before full-file replacement',
    );

    const mutationPdfPath = path.join(root, 'oversized-mutation.pdf');
    await fs.writeFile(mutationPdfPath, Buffer.alloc(33 * MiB, 0x25));
    await expectResourceRejection(
      editPdf(mutationPdfPath, []),
      'PDF mutation input must be bounded before pdf-lib parsing',
    );

    const zip = new PizZip();
    const largeXmlText = 'x'.repeat(18 * MiB);
    zip.file('word/document.xml',
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t>${largeXmlText}</w:t></w:r></w:p></w:body></w:document>`);
    const docxPath = path.join(root, 'compressed-bomb.docx');
    await fs.writeFile(docxPath, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
    await expectResourceRejection(readFile(docxPath), 'DOCX uncompressed XML budget must be enforced before extraction');

    const xlsxZip = new PizZip();
    xlsxZip.file('xl/worksheets/sheet1.xml', '<worksheet/>');
    const forgedXlsx = xlsxZip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    const centralDirectory = forgedXlsx.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert(centralDirectory >= 0, 'XLSX fixture is missing a central-directory entry');
    forgedXlsx.writeUInt32LE(65 * MiB, centralDirectory + 24);
    const xlsxPath = path.join(root, 'compressed-bomb.xlsx');
    await fs.writeFile(xlsxPath, forgedXlsx);
    await expectResourceRejection(readFile(xlsxPath), 'XLSX uncompressed archive budget must be checked before ExcelJS extraction');

    const legacyXls = path.join(root, 'legacy.xls');
    await fs.writeFile(legacyXls, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));
    const legacyResult = await readFile(legacyXls);
    assert.equal(legacyResult.metadata?.isBinary, true, '.xls must use the generic binary path, not the XLSX parser');

    const pdfPath = path.join(root, 'signal.pdf');
    await fs.writeFile(pdfPath, Buffer.from('%PDF-invalid'));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      new PdfFileHandler().read(pdfPath, { signal: controller.signal }),
      /abort/i,
      'PdfFileHandler must propagate caller AbortSignal into local PDF I/O',
    );

    const oversizedBody = Buffer.alloc(17 * MiB, 0x42);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(oversizedBody.length),
      });
      res.end(oversizedBody);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert(address && typeof address === 'object');
      await expectResourceRejection(
        readFile(`http://127.0.0.1:${address.port}/large.png`, { isUrl: true }),
        'URL image body must be size-bounded before base64 conversion',
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    console.log('read resource bounds: PASS');
  } finally {
    await configManager.setValue('allowedDirectories', originalAllowed);
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
