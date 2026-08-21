import type { SerenaPrivateClient } from './serena-client.js';
import type { ServerResult } from '../types.js';

export type SerenaReadCacheEntry = {
  result: ServerResult;
  clientGeneration: number;
  workspaceGeneration: number;
  relativePath: string;
  contentHash: string;
};

export type SerenaSessionBinding = {
  token: string;
  ownerIdentityHash?: string;
  root: string;
  createdAt: number;
  lastUsedAt: number;
  workspaceGeneration: number;
  profileFingerprint?: string;
  templateServer?: string;
  client?: SerenaPrivateClient;
  idleTimer?: NodeJS.Timeout;
  warmup?: Promise<void>;
  transportReady: boolean;
  transportReadyAt?: number;
  semanticReady: boolean;
  lastError?: string;
  pendingReads: Map<string, Promise<ServerResult>>;
  completedReads: Map<string, SerenaReadCacheEntry>;
};

export class SerenaSessionRegistry {
  private readonly bindings = new Map<string, SerenaSessionBinding>();
  private readonly implicitSessions = new Map<string, string>();

  get size(): number { return this.bindings.size; }

  get(token: string): SerenaSessionBinding | undefined { return this.bindings.get(token); }

  tokenForOwner(ownerIdentityHash: string): string | undefined {
    return this.implicitSessions.get(ownerIdentityHash);
  }

  bind(binding: SerenaSessionBinding): void {
    this.bindings.set(binding.token, binding);
    if (binding.ownerIdentityHash) this.implicitSessions.set(binding.ownerIdentityHash, binding.token);
  }

  delete(binding: SerenaSessionBinding): void {
    if (this.bindings.get(binding.token) === binding) this.bindings.delete(binding.token);
    if (binding.ownerIdentityHash && this.implicitSessions.get(binding.ownerIdentityHash) === binding.token) {
      this.implicitSessions.delete(binding.ownerIdentityHash);
    }
  }

  values(): SerenaSessionBinding[] { return [...this.bindings.values()]; }
}
