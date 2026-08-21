import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const SERVER = path.join(REPO_ROOT, 'dist', 'index.js');
let failures = 0;

function textOf(result) {
  return (result?.content ?? []).map((item) => item?.type === 'text' ? item.text ?? '' : '').join('\n');
}

function utf16Le(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

function utf16Be(text) {
  const body = Buffer.from(text, 'utf16le');
  for (let i = 0; i + 1 < body.length; i += 2) {
    const byte = body[i]; body[i] = body[i + 1]; body[i + 1] = byte;
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
}

async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error?.stack || error}`); }
}

async function call(client, name, args, timeout = 15_000) {
  return client.callTool({ name, arguments: args }, undefined, { timeout });
}

function sha256Text(text) {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

async function compatMutation(client, tool, payload, conversationId, timeout = 35_000) {
  return client.callTool({
    name: 'write_file',
    arguments: {
      path: `mcp://desktop-accelerators/${tool}?timeout_ms=30000`,
      content: JSON.stringify(payload),
      mode: 'rewrite',
    },
    _meta: { conversation_id: conversationId },
  }, undefined, { timeout });
}

async function compatRead(client, tool, payload, timeout = 35_000) {
  return client.callTool({
    name: 'read_file',
    arguments: {
      path: `mcp://desktop-accelerators/${tool}?timeout_ms=30000`,
      options: payload,
    },
  }, undefined, { timeout });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-write-e2e-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-write-e2e-home-'));
  const configDir = path.join(home, '.claude-server-commander');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    telemetryEnabled: false, allowedDirectories: [root], fileWriteLineLimit: 50,
  }), 'utf8');

  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER, '--no-onboarding'], cwd: REPO_ROOT, stderr: 'pipe',
    env: { ...process.env, HOME: home, USERPROFILE: home, DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true' },
  });
  const client = new Client({ name: 'dc-write-tools-e2e', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: 30_000 });
    const tools = await client.listTools(undefined, { timeout: 15_000 });
    for (const name of ['write_file', 'read_file', 'edit_block', 'file_put']) {
      assert(tools.tools.some((tool) => tool.name === name), `missing MCP tool ${name}`);
    }

    const base = path.join(root, 'base.txt');
    await check('write_file rewrite and read_file round trip', async () => {
      const wrote = await call(client, 'write_file', { path: base, content: 'alpha\n', mode: 'rewrite' });
      assert.notEqual(wrote.isError, true, textOf(wrote));
      const read = await call(client, 'read_file', { path: base, offset: 0, length: 10 });
      assert.notEqual(read.isError, true, textOf(read));
      assert.match(textOf(read), /alpha/);
      assert.equal(await fs.readFile(base, 'utf8'), 'alpha\n');
    });

    await check('read_file decodes UTF-16 BOM files and text edits use the same decoder', async () => {
      for (const [label, encode] of [['le', utf16Le], ['be', utf16Be]]) {
        const file = path.join(root, `utf16-${label}.txt`);
        await fs.writeFile(file, encode('ALPHA\r\nБЕТА\r\n'));
        const read = await call(client, 'read_file', { path: file, offset: 0, length: 10 });
        assert.notEqual(read.isError, true, textOf(read));
        assert.match(textOf(read), /ALPHA/);
        assert.match(textOf(read), /БЕТА/);
        assert(!textOf(read).includes('\u0000'), `UTF-16 ${label} leaked NUL bytes`);
        const edit = await call(client, 'edit_block', {
          file_path: file, old_string: 'ALPHA', new_string: 'OMEGA', expected_replacements: 1,
        });
        assert.notEqual(edit.isError, true, textOf(edit));
        const reread = await call(client, 'read_file', { path: file, offset: 0, length: 10 });
        assert.match(textOf(reread), /OMEGA/);
        assert.match(textOf(reread), /БЕТА/);
        const rawAfter = await fs.readFile(file);
        assert.deepEqual(
          rawAfter, encode('OMEGA\r\nБЕТА\r\n'),
          `edit_block changed UTF-16 ${label} encoding, BOM, or byte order`,
        );
      }
    });

    await check('write_file append preserves UTF-16 encoding and byte order', async () => {
      for (const [label, encode] of [['le', utf16Le], ['be', utf16Be]]) {
        const file = path.join(root, `utf16-append-${label}.txt`);
        await fs.writeFile(file, encode('ALPHA\r\n'));
        const appended = await call(client, 'write_file', {
          path: file, content: 'БЕТА\r\n', mode: 'append',
        });
        assert.notEqual(appended.isError, true, textOf(appended));
        assert.deepEqual(
          await fs.readFile(file), encode('ALPHA\r\nБЕТА\r\n'),
          `write_file append mixed encodings or changed UTF-16 ${label} BOM/byte order`,
        );
      }
    });

    await check('nested mcp mutation never silently materializes control escapes', async () => {
      const file = path.join(root, 'compat-control-escape.txt');
      await fs.writeFile(file, 'TOKEN', 'utf8');
      const intendedLiteral = String.raw`C:\temp\foo|\u0007`;
      const rawPayload = [
        '{"path":', JSON.stringify(file.replace(/\\/g, '/')),
        ',"edits":[{"oldText":"TOKEN","newText":"', intendedLiteral,
        '","expectedReplacements":1}],"dryRun":false}',
      ].join('');
      const result = await client.callTool({
        name: 'write_file',
        arguments: {
          path: 'mcp://desktop-accelerators/edit_file?timeout_ms=30000',
          content: rawPayload,
          mode: 'rewrite',
        },
        _meta: { conversation_id: 'compat-control-escape' },
      }, undefined, { timeout: 35_000 });
      const after = await fs.readFile(file, 'utf8');
      if (result.isError === true) {
        assert.equal(after, 'TOKEN', `rejected nested payload still changed bytes: ${textOf(result)}`);
      } else {
        assert.equal(
          after, intendedLiteral,
          `nested compatibility JSON reinterpreted literal backslash escapes as control characters: ${JSON.stringify(after)}`,
        );
      }
    });

    await check('write_file append is serialized and lossless', async () => {
      const appendFile = path.join(root, 'append.txt');
      await call(client, 'write_file', { path: appendFile, content: 'HEAD\n', mode: 'rewrite' });
      const tokens = Array.from({ length: 12 }, (_, i) => `TOKEN_${i}\n`);
      const results = await Promise.all(tokens.map((content) =>
        call(client, 'write_file', { path: appendFile, content, mode: 'append' }, 30_000)));
      assert(results.every((result) => result.isError !== true), results.map(textOf).join('\n'));
      const actual = await fs.readFile(appendFile, 'utf8');
      assert(actual.startsWith('HEAD\n'));
      for (const token of tokens) assert.equal(actual.split(token).length - 1, 1, `lost/duplicated ${token.trim()}`);
    });

    await check('concurrent rewrites publish one complete payload', async () => {
      const rewriteFile = path.join(root, 'rewrite.txt');
      const payloads = Array.from({ length: 8 }, (_, i) => `OWNER_${i}\n${String(i).repeat(32_000)}\nEND_${i}\n`);
      const results = await Promise.all(payloads.map((content) =>
        call(client, 'write_file', { path: rewriteFile, content, mode: 'rewrite' }, 30_000)));
      assert(results.every((result) => result.isError !== true), results.map(textOf).join('\n'));
      const actual = await fs.readFile(rewriteFile, 'utf8');
      assert(payloads.includes(actual), 'final rewrite was torn or mixed');
      const leftovers = (await fs.readdir(root)).filter((name) => name.includes('.write.tmp'));
      assert.deepEqual(leftovers, []);
    });

    await check('write_file omitted mode protects existing data', async () => {
      const guarded = path.join(root, 'guarded.txt');
      await fs.writeFile(guarded, 'KEEP', 'utf8');
      const result = await call(client, 'write_file', { path: guarded, content: 'DROP' });
      assert.equal(result.isError, true, `expected error, got: ${textOf(result)}`);
      assert.equal(await fs.readFile(guarded, 'utf8'), 'KEEP');
    });

    await check('file_put omission preserves write_file data-loss guard', async () => {
      const aliasFile = path.join(root, 'alias-guard.txt');
      await fs.writeFile(aliasFile, 'KEEP_ALIAS', 'utf8');
      const result = await call(client, 'file_put', { path: aliasFile, data: 'DROP_ALIAS' });
      assert.equal(result.isError, true, `expected guard error, got: ${textOf(result)}`);
      assert.equal(await fs.readFile(aliasFile, 'utf8'), 'KEEP_ALIAS');
    });

    await check('file_put explicit append round trip', async () => {
      const aliasFile = path.join(root, 'alias-append.txt');
      const first = await call(client, 'file_put', { path: aliasFile, data: 'A', append: false });
      assert.notEqual(first.isError, true, textOf(first));
      const second = await call(client, 'file_put', { path: aliasFile, data: 'B', append: true });
      assert.notEqual(second.isError, true, textOf(second));
      const read = await call(client, 'read_file', { path: aliasFile, offset: 0, length: 10 });
      assert.match(textOf(read), /AB/);
      assert.equal(await fs.readFile(aliasFile, 'utf8'), 'AB');
    });

    await check('edit_block exact replacement reports mutation and persists', async () => {
      const editFile = path.join(root, 'edit.txt');
      await fs.writeFile(editFile, 'left TARGET right', 'utf8');
      const result = await call(client, 'edit_block', {
        file_path: editFile, old_string: 'TARGET', new_string: 'DONE', expected_replacements: 1,
      });
      assert.notEqual(result.isError, true, textOf(result));
      assert.equal(await fs.readFile(editFile, 'utf8'), 'left DONE right');
      const read = await call(client, 'read_file', { path: editFile, offset: 0, length: 10 });
      assert.match(textOf(read), /DONE/);
    });

    await check('edit_block count mismatch is a machine-visible failure', async () => {
      const editFile = path.join(root, 'edit-count.txt');
      await fs.writeFile(editFile, 'X X', 'utf8');
      const result = await call(client, 'edit_block', {
        file_path: editFile, old_string: 'X', new_string: 'Y', expected_replacements: 1,
      });
      assert.equal(result.isError, true, `count mismatch looked successful: ${textOf(result)}`);
      assert.equal(await fs.readFile(editFile, 'utf8'), 'X X');
    });

    await check('edit_block fuzzy suggestion is a machine-visible non-mutation', async () => {
      const editFile = path.join(root, 'edit-fuzzy.txt');
      await fs.writeFile(editFile, 'Desktop Commander target', 'utf8');
      const result = await call(client, 'edit_block', {
        file_path: editFile, old_string: 'Desktop Comander target', new_string: 'changed', expected_replacements: 1,
      });
      assert.equal(result.isError, true, `fuzzy miss looked successful: ${textOf(result)}`);
      assert.match(textOf(result), /similar text|not found/i);
      assert.equal(await fs.readFile(editFile, 'utf8'), 'Desktop Commander target');
    });

    await check('edit_block rejects invalid replacement cardinality', async () => {
      const editFile = path.join(root, 'edit-cardinality.txt');
      await fs.writeFile(editFile, 'X', 'utf8');
      const zero = await call(client, 'edit_block', {
        file_path: editFile, old_string: 'X', new_string: 'Y', expected_replacements: 0,
      });
      assert.equal(zero.isError, true, `zero replacement count accepted: ${textOf(zero)}`);
      const fractional = await call(client, 'edit_block', {
        file_path: editFile, old_string: 'X', new_string: 'Y', expected_replacements: 1.5,
      });
      assert.equal(fractional.isError, true, `fractional replacement count accepted: ${textOf(fractional)}`);
      assert.equal(await fs.readFile(editFile, 'utf8'), 'X');
    });

    await check('mcp edit_file rebases sibling patches only within the same conversation lineage', async () => {
      const editFile = path.join(root, 'mcp-edit-lineage.txt');
      const base = 'LEFT_0\nMIDDLE\nRIGHT_0\n';
      const baseHash = sha256Text(base);
      await fs.writeFile(editFile, base, 'utf8');
      const sibling = (oldText, newText, conversationId) => compatMutation(client, 'edit_file', {
        path: editFile, expectedHash: baseHash, dryRun: false,
        edits: [{ oldText, newText, expectedReplacements: 1 }],
      }, conversationId);
      const sameSession = await Promise.all([
        sibling('LEFT_0', 'LEFT_1', 'edit-lineage-a'),
        sibling('RIGHT_0', 'RIGHT_1', 'edit-lineage-a'),
      ]);
      assert(sameSession.every((result) => result.isError !== true), sameSession.map(textOf).join('\n'));
      assert.equal(await fs.readFile(editFile, 'utf8'), 'LEFT_1\nMIDDLE\nRIGHT_1\n');
      const outcomes = sameSession.map((result) => JSON.parse(textOf(result)));
      assert(outcomes.some((result) => result.rebasedFromHash === baseHash), 'sibling edit did not report hash-lineage rebase');

      const burstFile = path.join(root, 'mcp-edit-lineage-burst.txt');
      const burstTokens = Array.from({ length: 8 }, (_, index) => `TOKEN_${index}_0`);
      const burstBase = `${burstTokens.join('\n')}\n`;
      const burstHash = sha256Text(burstBase);
      await fs.writeFile(burstFile, burstBase, 'utf8');
      const burst = await Promise.all(burstTokens.map((token, index) => compatMutation(client, 'edit_file', {
        path: burstFile, expectedHash: burstHash, dryRun: false,
        edits: [{ oldText: token, newText: `TOKEN_${index}_1`, expectedReplacements: 1 }],
      }, 'edit-lineage-burst')));
      assert(burst.every((result) => result.isError !== true), burst.map(textOf).join('\n'));
      assert.equal(await fs.readFile(burstFile, 'utf8'),
        `${Array.from({ length: 8 }, (_, index) => `TOKEN_${index}_1`).join('\n')}\n`);
      assert(burst.map((result) => JSON.parse(textOf(result))).filter((result) => result.rebasedFromHash === burstHash).length >= 7,
        'burst siblings did not chain through one base revision');

      const isolatedFile = path.join(root, 'mcp-edit-lineage-isolated.txt');
      const isolatedBase = 'A_0\nB_0\n';
      const isolatedHash = sha256Text(isolatedBase);
      await fs.writeFile(isolatedFile, isolatedBase, 'utf8');
      const first = await compatMutation(client, 'edit_file', {
        path: isolatedFile, expectedHash: isolatedHash, dryRun: false,
        edits: [{ oldText: 'A_0', newText: 'A_1', expectedReplacements: 1 }],
      }, 'edit-lineage-owner');
      assert.notEqual(first.isError, true, textOf(first));
      const foreign = await compatMutation(client, 'edit_file', {
        path: isolatedFile, expectedHash: isolatedHash, dryRun: false,
        edits: [{ oldText: 'B_0', newText: 'B_1', expectedReplacements: 1 }],
      }, 'edit-lineage-other');
      assert.equal(foreign.isError, true, `foreign stale hash was rebased: ${textOf(foreign)}`);
      assert.match(textOf(foreign), /SHA-256 fence failed/);
      assert.equal(await fs.readFile(isolatedFile, 'utf8'), 'A_1\nB_0\n');

      const externalFile = path.join(root, 'mcp-edit-lineage-external.txt');
      const externalBase = 'X_0\nY_0\n';
      const externalHash = sha256Text(externalBase);
      await fs.writeFile(externalFile, externalBase, 'utf8');
      const owned = await compatMutation(client, 'edit_file', {
        path: externalFile, expectedHash: externalHash, dryRun: false,
        edits: [{ oldText: 'X_0', newText: 'X_1', expectedReplacements: 1 }],
      }, 'edit-lineage-external');
      assert.notEqual(owned.isError, true, textOf(owned));
      await fs.writeFile(externalFile, 'X_1\nY_EXTERNAL\n', 'utf8');
      const staleAfterExternalWrite = await compatMutation(client, 'edit_file', {
        path: externalFile, expectedHash: externalHash, dryRun: false,
        edits: [{ oldText: 'Y_EXTERNAL', newText: 'Y_1', expectedReplacements: 1 }],
      }, 'edit-lineage-external');
      assert.equal(staleAfterExternalWrite.isError, true,
        `external writer was absorbed into mutation lineage: ${textOf(staleAfterExternalWrite)}`);
      assert.match(textOf(staleAfterExternalWrite), /SHA-256 fence failed/);
      assert.equal(await fs.readFile(externalFile, 'utf8'), 'X_1\nY_EXTERNAL\n');
    });

    await check('mcp apply_patch rebases disjoint sibling patches from one base revision', async () => {
      execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
      const patchFile = path.join(root, 'patch-lineage.txt');
      const base = 'left\nmiddle\nright\n';
      const baseHash = sha256Text(base);
      await fs.writeFile(patchFile, base, 'utf8');
      const leftPatch = [
        'diff --git a/patch-lineage.txt b/patch-lineage.txt',
        '--- a/patch-lineage.txt',
        '+++ b/patch-lineage.txt',
        '@@ -1,2 +1,2 @@',
        '-left',
        '+LEFT',
        ' middle',
        '',
      ].join('\n');
      const rightPatch = [
        'diff --git a/patch-lineage.txt b/patch-lineage.txt',
        '--- a/patch-lineage.txt',
        '+++ b/patch-lineage.txt',
        '@@ -2,2 +2,2 @@',
        ' middle',
        '-right',
        '+RIGHT',
        '',
      ].join('\n');
      const sibling = (patchText) => compatMutation(client, 'apply_patch', {
        root, patch: patchText, expectedFiles: ['patch-lineage.txt'],
        expectedHashes: { 'patch-lineage.txt': baseHash }, dryRun: false,
      }, 'patch-lineage-a');
      const results = await Promise.all([
        sibling(leftPatch),
        sibling(rightPatch),
      ]);
      assert(results.every((result) => result.isError !== true), results.map(textOf).join('\n'));
      assert.equal((await fs.readFile(patchFile, 'utf8')).replace(/\r\n/g, '\n'), 'LEFT\nmiddle\nRIGHT\n');
      const outcomes = results.map((result) => JSON.parse(textOf(result)));
      assert(outcomes.some((result) => result.rebasedExpectedHashes?.['patch-lineage.txt'] === baseHash),
        'sibling patch did not report expected-hash rebase');
    });

    await check('mcp read_ranges decodes UTF-16 without leaking control bytes', async () => {
      const original = 'UTF16_SENTINEL_ALPHA\r\nКОНТРОЛЬ_БЕТА\r\n';
      const fixtures = [
        ['le', utf16Le],
        ['be', utf16Be],
      ];
      const requests = [];
      for (const [label, encode] of fixtures) {
        const file = path.join(root, `accelerator-read-ranges-${label}.txt`);
        await fs.writeFile(file, encode(original));
        requests.push({ path: file, offset: 0, length: 10 });
      }
      const result = await compatRead(client, 'read_ranges', { requests, maxTotalChars: 20_000 });
      assert.notEqual(result.isError, true, textOf(result));
      const payload = JSON.parse(textOf(result));
      assert.equal(payload.results.length, fixtures.length, JSON.stringify(payload));
      for (const entry of payload.results) {
        assert.equal(entry.content, original, `read_ranges decoded UTF-16 incorrectly: ${JSON.stringify(entry.content)}`);
        assert(!/[\u0000\ufffd]/u.test(entry.content), `read_ranges leaked NUL/replacement characters: ${JSON.stringify(entry.content)}`);
      }
    });

    await check('mcp context_pack decodes seeded UTF-16 source as text', async () => {
      const original = 'UTF16_PACK_SENTINEL_ALPHA\r\nКОНТРОЛЬ_БЕТА\r\n';
      const seedFiles = [];
      for (const [label, encode] of [['le', utf16Le], ['be', utf16Be]]) {
        const relative = `accelerator-context-pack-${label}.txt`;
        await fs.writeFile(path.join(root, relative), encode(original));
        seedFiles.push(relative);
      }
      execFileSync('git', ['-C', root, 'add', '--', ...seedFiles], { stdio: 'ignore' });
      execFileSync('git', [
        '-C', root, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid',
        'commit', '-q', '-m', 'seed UTF-16 context fixtures',
      ], { stdio: 'ignore' });
      const result = await compatRead(client, 'context_pack', {
        root, query: 'UTF16_PACK_SENTINEL_ALPHA', seedFiles, maxFiles: 8,
        contextLines: 1, maxLinesPerFile: 20, maxTotalChars: 20_000,
      });
      assert.notEqual(result.isError, true, textOf(result));
      const payload = JSON.parse(textOf(result));
      for (const relative of seedFiles) {
        const entry = payload.files.find((item) => item.path.replace(/\\/g, '/') === relative);
        assert(entry, `context_pack omitted seeded UTF-16 file ${relative}: ${JSON.stringify(payload.files)}`);
        assert(entry.content.includes('UTF16_PACK_SENTINEL_ALPHA'), JSON.stringify(entry));
        assert(entry.content.includes('КОНТРОЛЬ_БЕТА'), JSON.stringify(entry));
        assert(!/[\u0000\ufffd]/u.test(entry.content), `context_pack leaked UTF-16 control/replacement bytes: ${JSON.stringify(entry.content)}`);
      }
    });

    await check('mcp edit_file preserves UTF-16 BOM, byte order, and text', async () => {
      for (const [label, encode] of [['le', utf16Le], ['be', utf16Be]]) {
        const file = path.join(root, `accelerator-edit-${label}.txt`);
        const original = 'ALPHA\r\nБЕТА\r\n';
        await fs.writeFile(file, encode(original));
        const result = await compatMutation(client, 'edit_file', {
          path: file, dryRun: false,
          edits: [{ oldText: 'ALPHA', newText: 'OMEGA', expectedReplacements: 1 }],
        }, `utf16-edit-${label}`);
        assert.notEqual(result.isError, true, `edit_file rejected UTF-16 ${label}: ${textOf(result)}`);
        assert.deepEqual(
          await fs.readFile(file), encode('OMEGA\r\nБЕТА\r\n'),
          `edit_file changed UTF-16 ${label} encoding, BOM, byte order, or inserted control bytes`,
        );
      }
    });

    await check('parallel XLSX range edits survive full MCP round trip', async () => {
      const excelFile = path.join(root, 'parallel.xlsx');
      const initial = [['c1', 'c2', 'c3', 'c4', 'c5', 'c6'], [0, 0, 0, 0, 0, 0]];
      const created = await call(client, 'write_file', {
        path: excelFile, content: JSON.stringify(initial), mode: 'rewrite',
      }, 30_000);
      assert.notEqual(created.isError, true, textOf(created));
      const columns = ['A', 'B', 'C', 'D', 'E', 'F'];
      const edits = await Promise.all(columns.map((column, index) =>
        call(client, 'edit_block', {
          file_path: excelFile, range: `Sheet1!${column}2:${column}2`, content: [[9100 + index]],
        }, 30_000)));
      assert(edits.every((result) => result.isError !== true), edits.map(textOf).join('\n'));
      const read = await call(client, 'read_file', { path: excelFile, offset: 0, length: 10 }, 30_000);
      assert.notEqual(read.isError, true, textOf(read));
      const rendered = textOf(read);
      for (let index = 0; index < columns.length; index++) {
        assert(rendered.includes(String(9100 + index)), `XLSX edit ${index} was lost: ${rendered}`);
      }
      assert.deepEqual((await fs.readdir(root)).filter((name) => name.includes('.atomic.tmp')), []);
    });

    await check('parallel DOCX edits survive full MCP round trip', async () => {
      const docxFile = path.join(root, 'parallel.docx');
      const tokens = Array.from({ length: 4 }, (_, index) => `DOCX_TOKEN_${index}`);
      const created = await call(client, 'write_file', {
        path: docxFile, content: tokens.join('\n'), mode: 'rewrite',
      }, 30_000);
      assert.notEqual(created.isError, true, textOf(created));
      const edits = await Promise.all(tokens.map((token, index) =>
        call(client, 'edit_block', {
          file_path: docxFile, old_string: `<w:t xml:space="preserve">${token}</w:t>`,
          new_string: `<w:t xml:space="preserve">DOCX_DONE_${index}</w:t>`, expected_replacements: 1,
        }, 30_000)));
      assert(edits.every((result) => result.isError !== true), edits.map(textOf).join('\n'));
      const read = await call(client, 'read_file', { path: docxFile }, 30_000);
      assert.notEqual(read.isError, true, textOf(read));
      const rendered = textOf(read);
      for (let index = 0; index < tokens.length; index++) {
        assert(rendered.includes(`DOCX_DONE_${index}`), `DOCX edit ${index} was lost: ${rendered}`);
      }
      assert.deepEqual((await fs.readdir(root)).filter((name) => name.includes('.atomic.tmp')), []);
    });

    await check('existing binary write fails without changing bytes', async () => {
      const binaryFile = path.join(root, 'opaque.bin');
      const original = Buffer.from([0, 255, 1, 2, 0, 3, 4, 5]);
      await fs.writeFile(binaryFile, original);
      const result = await call(client, 'write_file', { path: binaryFile, content: 'text', mode: 'rewrite' });
      assert.equal(result.isError, true, `binary overwrite looked successful: ${textOf(result)}`);
      assert.deepEqual(await fs.readFile(binaryFile), original);
    });

    await check('read_ranges metadata preflight keeps filesystem fan-out bounded', async () => {
      const oldHome = process.env.HOME;
      const oldUserProfile = process.env.USERPROFILE;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      const { callBuiltinAcceleratorTool } = await import('../dist/tools/workspace-accelerators.js');
      const { configManager } = await import('../dist/config-manager.js');
      await configManager.setValue('allowedDirectories', [root]);
      const files = Array.from({ length: 24 }, (_, index) => path.join(root, `fanout-${index}.txt`));
      await Promise.all(files.map((file, index) => fs.writeFile(file, `value-${index}\n`, 'utf8')));
      const originalRealpath = fs.realpath;
      const originalStat = fs.stat;
      const normalizedRoot = path.resolve(root).toLowerCase();
      const isTracked = (target) => {
        const normalized = path.resolve(String(target)).toLowerCase();
        return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${path.sep}`);
      };
      let active = 0;
      let maxActive = 0;
      const wrap = (original) => async (target, ...args) => {
        if (!isTracked(target)) return original(target, ...args);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return await original(target, ...args);
        } finally {
          active -= 1;
        }
      };
      try {
        fs.realpath = wrap(originalRealpath);
        fs.stat = wrap(originalStat);
        const result = await callBuiltinAcceleratorTool('read_ranges', {
          requests: files.map((file) => ({ path: file, offset: 0, length: 2 })),
          maxTotalChars: 20_000,
        }, 5_000);
        assert.equal(result.results.length, files.length);
        assert(maxActive <= 8, `read_ranges launched ${maxActive} concurrent filesystem metadata operations for ${files.length} files`);
      } finally {
        fs.realpath = originalRealpath;
        fs.stat = originalStat;
        if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
        if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
      }
    });

    await check('read_ranges deadline stops launching new path validations', async () => {
      const { callBuiltinAcceleratorTool } = await import('../dist/tools/workspace-accelerators.js');
      const files = Array.from({ length: 24 }, (_, index) => path.join(root, `deadline-fanout-${index}.txt`));
      await Promise.all(files.map((file, index) => fs.writeFile(file, `deadline-${index}\n`, 'utf8')));
      const originalRealpath = fs.realpath;
      const normalizedRoot = path.resolve(root).toLowerCase();
      const requested = new Set(files.map((file) => path.resolve(file).toLowerCase()));
      const startedRequested = new Set();
      let active = 0;
      try {
        fs.realpath = async (target, ...args) => {
          const normalized = path.resolve(String(target)).toLowerCase();
          if (normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${path.sep}`)) {
            active += 1;
            if (requested.has(normalized)) startedRequested.add(normalized);
            try {
              await new Promise((resolve) => setTimeout(resolve, 180));
              return await originalRealpath(target, ...args);
            } finally {
              active -= 1;
            }
          }
          return originalRealpath(target, ...args);
        };
        const startedAt = Date.now();
        await assert.rejects(
          () => callBuiltinAcceleratorTool('read_ranges', {
            requests: files.map((file) => ({ path: file, offset: 0, length: 2 })),
            maxTotalChars: 20_000,
          }, 100),
          (error) => error?.code === 'ETIMEDOUT' || /deadline|timed out|validation failed/i.test(String(error?.message ?? error)),
        );
        const elapsedMs = Date.now() - startedAt;
        assert(elapsedMs < 600, `read_ranges deadline did not release the caller promptly: ${elapsedMs}ms`);
        assert(startedRequested.size <= 8, `read_ranges started ${startedRequested.size} path validations before a 100ms deadline could stop fan-out`);
        assert(active <= 8, `read_ranges left ${active} metadata operations active after timeout`);
      } finally {
        fs.realpath = originalRealpath;
      }
    });

    await check('cpp build changed-file canonicalization keeps filesystem fan-out bounded', async () => {
      const { callCppBuildChangeClassification } = await import('../dist/tools/cpp-build-impact-accelerator.js');
      const relativeFiles = Array.from({ length: 24 }, (_, index) => `cpp-fanout-${index}.cpp`);
      await Promise.all(relativeFiles.map((relative, index) =>
        fs.writeFile(path.join(root, relative), `int value_${index} = ${index};\n`, 'utf8')));
      const requested = new Set(relativeFiles.map((relative) => path.resolve(root, relative).toLowerCase()));
      const originalRealpath = fs.realpath;
      let active = 0;
      let maxActive = 0;
      try {
        fs.realpath = async (target, ...args) => {
          const normalized = path.resolve(String(target)).toLowerCase();
          if (!requested.has(normalized)) return originalRealpath(target, ...args);
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return await originalRealpath(target, ...args);
          } finally {
            active -= 1;
          }
        };
        const result = await callCppBuildChangeClassification({ root, changedFiles: relativeFiles }, 5_000, {
          repositoryRoot: root, buildDir: root, cmake: {}, cmakeCache: { values: {} }, compileDatabase: { entries: [] },
        });
        assert.equal(result.changedFiles.length, relativeFiles.length);
        assert(maxActive <= 8, `cpp build classification launched ${maxActive} concurrent realpath operations`);
      } finally {
        fs.realpath = originalRealpath;
      }
    });

    await check('path authority blocks writes outside configured roots', async () => {
      const outside = path.join(os.tmpdir(), `dc-write-outside-${process.pid}-${Date.now()}.txt`);
      const result = await call(client, 'write_file', { path: outside, content: 'forbidden', mode: 'rewrite' });
      assert.equal(result.isError, true, `outside write looked successful: ${textOf(result)}`);
      await assert.rejects(() => fs.stat(outside), /ENOENT/);
    });
  } finally {
    await client.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
  if (failures > 0) {
    console.error(`write tools e2e: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('write tools e2e: PASS');
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
