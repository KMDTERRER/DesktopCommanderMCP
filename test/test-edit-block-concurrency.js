import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';

import { handleEditBlock } from '../dist/tools/edit.js';

async function main() {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-dc-edit-block-concurrency-'));
  const file = path.join(root, 'shared.txt');
  try {
    for (let round = 0; round < 5; round += 1) {
      const entries = Array.from({ length: 12 }, (_, index) => `TOKEN_${index}=old`);
      await fs.writeFile(file, entries.join('\n') + '\n', 'utf8');

      const results = await Promise.all(entries.map((entry, index) => handleEditBlock({
        file_path: file,
        old_string: entry,
        new_string: `TOKEN_${index}=new`,
        expected_replacements: 1,
      })));

      for (const result of results) {
        assert.notEqual(result.isError, true, JSON.stringify(result));
      }
      const finalText = await fs.readFile(file, 'utf8');
      for (let index = 0; index < entries.length; index += 1) {
        assert(finalText.includes(`TOKEN_${index}=new`), `round ${round}: update ${index} was lost`);
        assert(!finalText.includes(`TOKEN_${index}=old`), `round ${round}: stale token ${index} survived`);
      }
    }

    console.log('edit_block same-file concurrency: PASS');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
