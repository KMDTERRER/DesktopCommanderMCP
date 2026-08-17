#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-tool-history-'));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    const historyDir = path.join(root, '.claude-server-commander');
    await fs.mkdir(historyDir, { recursive: true });
    const legacy = {
      timestamp: new Date().toISOString(), toolName: 'write_file',
      arguments: { path: 'secret.txt', content: 'LEGACY_SOURCE_CODE', apiKey: 'LEGACY_API_KEY' },
      output: { content: [{ type: 'text', text: 'LEGACY_RAW_OUTPUT' }] },
    };
    await fs.writeFile(path.join(historyDir, 'tool-history.jsonl'), JSON.stringify(legacy) + '\n', 'utf8');

    const { toolHistory } = await import('../dist/utils/toolHistory.js');
    await toolHistory.cleanup(); // freeze the queue so the cap can be tested deterministically
    const loaded = toolHistory.getRecentCalls({ maxResults: 1 })[0];
    const loadedText = JSON.stringify(loaded);
    assert(!loadedText.includes('LEGACY_SOURCE_CODE'));
    assert(!loadedText.includes('LEGACY_API_KEY'));
    assert(!loadedText.includes('LEGACY_RAW_OUTPUT'));
    toolHistory.addCall('write_file', {
      path: 'example.txt', content: 'CURRENT_SOURCE_CODE', access_token: 'CURRENT_TOKEN',
      command: 'curl -H "Authorization: Bearer ABC123" https://example.invalid',
    }, { content: [{ type: 'text', text: 'CURRENT_RAW_OUTPUT' }] });
    const current = toolHistory.getRecentCalls({ maxResults: 1 })[0];
    const currentText = JSON.stringify(current);
    assert(!currentText.includes('CURRENT_SOURCE_CODE'));
    assert(!currentText.includes('CURRENT_TOKEN'));
    assert(!currentText.includes('ABC123'));
    assert(!currentText.includes('CURRENT_RAW_OUTPUT'));
    assert(Buffer.byteLength(JSON.stringify(current.arguments), 'utf8') <= 8 * 1024);

    for (let index = 0; index < 1100; index += 1) {
      toolHistory.addCall('probe', { index }, { content: [{ type: 'text', text: 'ok' }] });
    }
    assert.equal(toolHistory.getStats().queuedWrites, 1000,
      'persistent history write queue must stay bounded during disk backpressure');
    await toolHistory.cleanup();
    console.log('tool history safety: PASS');
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
