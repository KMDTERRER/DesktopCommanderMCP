import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SearchManager } from '../dist/search-manager.js';
import { runInToolCallContext } from '../dist/utils/client-context.js';

const remoteCall = (conversationId, operation) => runInToolCallContext({
  isRemote: true,
  remoteClient: { name: 'search-binding-test', version: '1' },
  requestMetadata: conversationId ? { conversation_id: conversationId } : {},
}, operation);

const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-dc-search-binding-'));
const manager = new SearchManager();
let ownedId;
let unscopedId;
try {
  await fs.writeFile(path.join(root, 'needle.txt'), 'SEARCH_BINDING_NEEDLE\n', 'utf8');

  const owned = await remoteCall('conversation-a', () => manager.startSearch({
    rootPath: root, pattern: 'SEARCH_BINDING_NEEDLE', searchType: 'content', timeout: 3000,
  }));
  ownedId = owned.sessionId;
  assert.match(ownedId, /^search_[0-9a-f-]{36}$/i, 'search id is not an opaque UUID');

  assert.throws(
    () => remoteCall('conversation-b', () => manager.readSearchResults(ownedId, 0, 10)),
    /not available to this remote conversation/,
    'a different conversation read an owned search session',
  );
  assert.throws(
    () => remoteCall('conversation-b', () => manager.terminateSearch(ownedId)),
    /not available to this remote conversation/,
    'a different conversation terminated an owned search session',
  );
  assert(
    remoteCall('conversation-a', () => manager.listSearchSessions()).some((session) => session.id === ownedId),
    'owner cannot list its search session',
  );
  assert(
    !remoteCall('conversation-b', () => manager.listSearchSessions()).some((session) => session.id === ownedId),
    'foreign search session leaked through list_searches',
  );

  const unscoped = await remoteCall(undefined, () => manager.startSearch({
    rootPath: root, pattern: 'needle.txt', searchType: 'files', timeout: 3000,
  }));
  unscopedId = unscoped.sessionId;
  assert.equal(
    remoteCall(undefined, () => manager.listSearchSessions()).length,
    0,
    'unscoped remote caller received bearer search ids from list_searches',
  );
  assert.doesNotThrow(
    () => remoteCall(undefined, () => manager.readSearchResults(unscopedId, 0, 10)),
    'the exact opaque id did not authorize an unscoped remote search follow-up',
  );

  console.log('search session binding: PASS');
} finally {
  if (ownedId) manager.terminateSearch(ownedId);
  if (unscopedId) manager.terminateSearch(unscopedId);
  await fs.rm(root, { recursive: true, force: true });
}
