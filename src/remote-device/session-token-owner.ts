export interface AuthSession {
    access_token: string;
    refresh_token: string | null;
    device_id?: string;
}

export interface SessionTokenSnapshot extends AuthSession {
    generation: number;
}

type SessionTokenListener = (session: SessionTokenSnapshot | null) => void;

/**
 * Process-local source of truth for the current remote credential snapshot.
 * Reads are synchronous: outbound result delivery must never trigger storage
 * access or token refresh merely to obtain an Authorization header.
 */
export class SessionTokenOwner {
    private current: SessionTokenSnapshot | null = null;
    private generation = 0;
    private readonly listeners = new Set<SessionTokenListener>();

    snapshot(): SessionTokenSnapshot | null {
        return this.current ? { ...this.current } : null;
    }

    accessToken = async (): Promise<string | null> => this.current?.access_token ?? null;

    replace(session: AuthSession): SessionTokenSnapshot {
        const next: SessionTokenSnapshot = {
            access_token: session.access_token,
            refresh_token: session.refresh_token ?? null,
            ...(session.device_id ? { device_id: session.device_id } : {}),
            generation: ++this.generation,
        };
        this.current = next;
        this.emit(next);
        return { ...next };
    }

    clear(): void {
        if (!this.current) return;
        this.current = null;
        this.generation += 1;
        this.emit(null);
    }

    subscribe(listener: SessionTokenListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(session: SessionTokenSnapshot | null): void {
        for (const listener of this.listeners) {
            try { listener(session ? { ...session } : null); } catch { /* observers never own auth */ }
        }
    }
}
