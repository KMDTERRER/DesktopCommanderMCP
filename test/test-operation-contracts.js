import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { OperationScope, remainingOperationMs } from '../dist/utils/operation-scope.js';
import { KeyedSerializedOperationOwners, SerializedOperationOwner } from '../dist/utils/serialized-operation-owner.js';

const operationScopeUrl = new URL('../dist/utils/operation-scope.js', import.meta.url).href;
const retryPolicyUrl = new URL('../dist/utils/retry-policy.js', import.meta.url).href;

function runIsolated(source, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`operation-contract child timed out; stdout=${stdout}; stderr=${stderr}`));
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
const timeoutChild = await runIsolated(`
  const { waitForOperationUntil } = await import(${JSON.stringify(operationScopeUrl)});
  try {
    await waitForOperationUntil(new Promise(() => {}), Date.now() + 80, 'foreground deadline');
    process.exit(2);
  } catch (error) {
    if (error?.code !== 'ETIMEDOUT') throw error;
    console.log('foreground-timeout-fired');
  }
`);
assert.equal(timeoutChild.code, 0, `foreground timeout child failed: ${timeoutChild.stderr}`);
assert.match(timeoutChild.stdout, /foreground-timeout-fired/);

const retryChild = await runIsolated(`
  const { OperationScope } = await import(${JSON.stringify(operationScopeUrl)});
  const { retryWithPolicy } = await import(${JSON.stringify(retryPolicyUrl)});
  const scope = new OperationScope({ label: 'foreground retry', timeoutMs: 1000 });
  try {
    let attempts = 0;
    const result = await retryWithPolicy(scope, {
      safety: 'read_only', maxAttempts: 2, baseDelayMs: 40, maxDelayMs: 40, jitter: 'none',
      isRetryable: () => true,
    }, async () => { attempts += 1; if (attempts === 1) throw new Error('retry'); return 'ok'; });
    if (result !== 'ok' || attempts !== 2) process.exit(3);
    console.log('foreground-retry-complete');
  } finally { scope.dispose(); }
`);
assert.equal(retryChild.code, 0, `foreground retry child failed: ${retryChild.stderr}`);
assert.match(retryChild.stdout, /foreground-retry-complete/);
assert.throws(
  () => remainingOperationMs(Date.now() - 1, 'expired operation'),
  (error) => error?.code === 'ETIMEDOUT',
);

const owner = new SerializedOperationOwner();
const firstScope = new OperationScope({ label: 'first owner turn', timeoutMs: 1000 });
let releaseFirst;
let markFirstStarted;
const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
const first = owner.runExclusive(firstScope, async () => {
  markFirstStarted();
  await holdFirst;
  return 'first';
});
await firstStarted;

const queuedScope = new OperationScope({ label: 'queued owner turn', timeoutMs: 50 });
await assert.rejects(
  () => owner.runExclusive(queuedScope, async () => 'should-not-run'),
  (error) => error?.code === 'ETIMEDOUT',
);
queuedScope.dispose();
releaseFirst();
assert.equal(await first, 'first');
firstScope.dispose();
const thirdScope = new OperationScope({ label: 'third owner turn', timeoutMs: 500 });
assert.equal(await owner.runExclusive(thirdScope, async () => 'third'), 'third');
thirdScope.dispose();

const keyedOwners = new KeyedSerializedOperationOwners();
const sameOwnerScope = new OperationScope({ label: 'same keyed resource holder', timeoutMs: 500 });
const releaseSameOwner = await keyedOwners.acquire('same', sameOwnerScope);
const sameWaiterScope = new OperationScope({ label: 'same keyed resource waiter', timeoutMs: 40 });
await assert.rejects(
  () => keyedOwners.acquire('same', sameWaiterScope),
  (error) => error?.code === 'ETIMEDOUT',
);
sameWaiterScope.dispose();
releaseSameOwner();
sameOwnerScope.dispose();
const sameThirdScope = new OperationScope({ label: 'same keyed resource after release', timeoutMs: 500 });
const releaseSameThird = await keyedOwners.acquire('same', sameThirdScope);
releaseSameThird();
sameThirdScope.dispose();

const leftScope = new OperationScope({ label: 'left keyed resource', timeoutMs: 500 });
const rightScope = new OperationScope({ label: 'right keyed resource', timeoutMs: 500 });
const [releaseLeft, releaseRight] = await Promise.all([
  keyedOwners.acquire('left', leftScope),
  keyedOwners.acquire('right', rightScope),
]);
releaseLeft();
releaseRight();
leftScope.dispose();
rightScope.dispose();

console.log('operation contracts: PASS');
