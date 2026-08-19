export const MINIMAL_LIVE_TEST_OPT_IN_ENV = 'DC_ALLOW_MINIMAL_LIVE_TEST';

/**
 * Benchmark transport is never a production default. Enabling it requires
 * both an explicit request and a separate opt-in environment variable so an
 * accidental launcher flag cannot silently replace the production transport.
 */
export function resolveMinimalLiveTestMode(
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
): boolean {
    const requested = argv.includes('--minimal-live-test')
        || env.DC_REMOTE_MINIMAL_LIVE_TEST === 'true';
    if (!requested) return false;
    if (env[MINIMAL_LIVE_TEST_OPT_IN_ENV] !== 'true') {
        throw new Error(
            `Minimal live transport is test-only; set ${MINIMAL_LIVE_TEST_OPT_IN_ENV}=true explicitly to enable it.`,
        );
    }
    return true;
}
