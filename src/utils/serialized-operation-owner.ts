import type { OperationScope } from './operation-scope.js';

/**
 * Process-local serialization for one explicit state owner.
 * Instances are intentionally independent: callers choose the resource owner,
 * so unrelated resources never share a global queue.
 */
export class SerializedOperationOwner {
  private tail: Promise<void> = Promise.resolve();

  async acquire(
    scope: OperationScope,
    waitLabel = 'Wait for serialized operation owner',
  ): Promise<() => void> {
    const previous = this.tail.catch(() => undefined);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const turn = previous.then(() => gate);
    this.tail = turn;
    const cleanup = () => {
      void turn.finally(() => { if (this.tail === turn) this.tail = Promise.resolve(); });
    };

    try {
      await scope.run(() => previous, waitLabel);
      scope.throwIfAborted(waitLabel);
    } catch (error) {
      // The failed waiter still owns a queued turn. Resolve it now; the turn is
      // reached only after the previous owner releases, so mutual exclusion holds.
      releaseGate();
      cleanup();
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      cleanup();
    };
  }

  async runExclusive<T>(
    scope: OperationScope,
    operation: () => Promise<T> | T,
    waitLabel = 'Wait for serialized operation owner',
  ): Promise<T> {
    const release = await this.acquire(scope, waitLabel);
    try {
      // Once acquired, the owner-specific operation controls its own cancellation.
      // Never release the resource early merely because the acquisition scope expires.
      return await operation();
    } finally {
      release();
    }
  }
}

export class KeyedSerializedOperationOwners<Key> {
  private readonly entries = new Map<Key, { owner: SerializedOperationOwner; users: number }>();

  async acquire(
    key: Key, scope: OperationScope, waitLabel = 'Wait for keyed serialized operation owner',
  ): Promise<() => void> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { owner: new SerializedOperationOwner(), users: 0 };
      this.entries.set(key, entry);
    }
    entry.users += 1;
    const releaseUser = () => {
      entry!.users -= 1;
      if (entry!.users === 0 && this.entries.get(key) === entry) this.entries.delete(key);
    };
    try {
      const releaseOwner = await entry.owner.acquire(scope, waitLabel);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseOwner();
        releaseUser();
      };
    } catch (error) {
      releaseUser();
      throw error;
    }
  }
}
