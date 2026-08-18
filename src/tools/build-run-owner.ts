import crypto from 'crypto';

const MAX_ACTIVE_RUNS = 32;
const MAX_RETAINED_RUNS = 128;
const COMPLETED_RETENTION_MS = 30 * 60 * 1000;
const MAX_LABEL_CHARS = 512;

export type BuildRunStatus = 'running' | 'completed' | 'failed';

export type BuildRunHooks = {
  onPid: (pid: number) => void;
};

type BuildRunRecord = {
  buildRunId: string;
  label: string;
  status: BuildRunStatus;
  createdAt: number;
  startedAt: number;
  completedAt?: number;
  pids: Set<number>;
  result?: unknown;
  error?: string;
  completion: Promise<void>;
  resolveCompletion: () => void;
};

export type BuildRunSnapshot = {
  buildRunId: string;
  label: string;
  status: BuildRunStatus;
  createdAt: string;
  startedAt: string;
  completedAt: string | null;
  pids: number[];
  result?: unknown;
  error?: string;
};

function timestamp(value: number | undefined): string | null {
  return value === undefined ? null : new Date(value).toISOString();
}

function snapshot(record: BuildRunRecord): BuildRunSnapshot {
  return {
    buildRunId: record.buildRunId, label: record.label, status: record.status,
    createdAt: new Date(record.createdAt).toISOString(), startedAt: new Date(record.startedAt).toISOString(),
    completedAt: timestamp(record.completedAt), pids: [...record.pids].sort((a, b) => a - b),
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

export class BuildRunOwner {
  private readonly runs = new Map<string, BuildRunRecord>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref?.();
  }

  private cleanup(): void {
    const cutoff = Date.now() - COMPLETED_RETENTION_MS;
    for (const [id, run] of this.runs) {
      if (run.completedAt !== undefined && run.completedAt < cutoff) this.runs.delete(id);
    }
    if (this.runs.size <= MAX_RETAINED_RUNS) return;
    const completed = [...this.runs.values()]
      .filter((run) => run.completedAt !== undefined)
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
    while (this.runs.size > MAX_RETAINED_RUNS && completed.length > 0) {
      this.runs.delete(completed.shift()!.buildRunId);
    }
  }

  start(
    labelValue: string, operation: (hooks: BuildRunHooks) => Promise<unknown>,
  ): BuildRunSnapshot {
    const label = labelValue.trim();
    if (!label || label.length > MAX_LABEL_CHARS || /[\0\r\n]/.test(label)) throw new Error('Build run label is invalid.');
    const active = [...this.runs.values()].filter((run) => run.status === 'running').length;
    if (active >= MAX_ACTIVE_RUNS) throw new Error(`Build run owner is limited to ${MAX_ACTIVE_RUNS} active runs.`);
    this.cleanup();

    const buildRunId = `br_${crypto.randomUUID().replace(/-/g, '')}`;
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const now = Date.now();
    const record: BuildRunRecord = {
      buildRunId, label, status: 'running', createdAt: now, startedAt: now,
      pids: new Set(), completion, resolveCompletion,
    };
    this.runs.set(buildRunId, record);

    const hooks: BuildRunHooks = {
      onPid: (pid) => {
        if (Number.isInteger(pid) && pid > 0 && record.status === 'running') record.pids.add(pid);
      },
    };
    void Promise.resolve().then(() => operation(hooks)).then(
      (result) => {
        record.result = result; record.status = 'completed'; record.completedAt = Date.now(); record.resolveCompletion();
      },
      (error) => {
        record.error = error instanceof Error ? error.message : String(error);
        record.status = 'failed'; record.completedAt = Date.now(); record.resolveCompletion();
      },
    );
    return snapshot(record);
  }

  get(buildRunId: string): BuildRunSnapshot {
    const run = this.runs.get(buildRunId);
    if (!run) throw new Error(`Unknown buildRunId: ${buildRunId}`);
    return snapshot(run);
  }

  async wait(buildRunId: string, waitMs = 0): Promise<BuildRunSnapshot> {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
      throw new Error('Build run waitMs must be an integer from 0 to 30000.');
    }
    const run = this.runs.get(buildRunId);
    if (!run) throw new Error(`Unknown buildRunId: ${buildRunId}`);
    if (run.status !== 'running' || waitMs === 0) return snapshot(run);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        run.completion,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return snapshot(run);
  }
}

export const buildRunOwner = new BuildRunOwner();
