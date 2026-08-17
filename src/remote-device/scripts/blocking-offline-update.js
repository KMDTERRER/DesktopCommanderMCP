#!/usr/bin/env node

/**
 * Blocking script to update device status to offline
 * Runs synchronously during shutdown to ensure DB update completes
 * 
 * Usage: node blocking-offline-update.js <deviceId> <supabaseUrl> <supabaseKey> <accessToken> <refreshToken> <sessionGeneration>
 */

import { createClient } from '@supabase/supabase-js';

// Parse command line arguments
const [deviceId, supabaseUrl, supabaseKey, accessToken, refreshToken, sessionGeneration] = process.argv.slice(2);

if (!deviceId || !supabaseUrl || !supabaseKey || !accessToken || !refreshToken || !sessionGeneration) {
    console.error('❌ Missing required arguments');
    console.error('Usage: node blocking-offline-update.js <deviceId> <supabaseUrl> <supabaseKey> <accessToken> <refreshToken> <sessionGeneration>');
    process.exit(1);
}

// Set timeout for entire operation
const TIMEOUT_MS = 3000;
const timeoutHandle = setTimeout(() => {
    console.error('⏱️ Timeout: Update took too long');
    process.exit(2); // Exit code 2 for timeout
}, TIMEOUT_MS);

try {
    // Create Supabase client
    const client = createClient(supabaseUrl, supabaseKey);

    // Set session using access token and refresh token
    const { error: authError } = await client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
    });

    if (authError) {
        console.error('❌ Auth error:', authError.message);
        clearTimeout(timeoutHandle);
        process.exit(3); // Exit code 3 for auth error
    }

    // Update device status to offline, stamping the exact shutdown moment so
    // "last seen X ago" is precise for clean shutdowns (the periodic
    // bookkeeping write only runs on the slow capable cadence).
    const { data, error } = await client
        .from('mcp_devices')
        .update({ status: 'offline', last_seen: new Date().toISOString() })
        .contains('capabilities', { device_session_v1: { generation: sessionGeneration } })
        .eq('id', deviceId)
        .select('id')
        .maybeSingle();

    clearTimeout(timeoutHandle);

    if (error) {
        console.error('❌ DB update error:', error.message);
        process.exit(4); // Exit code 4 for DB error
    }

    if (!data) {
        console.log('✓ Offline write skipped: device session was superseded');
        process.exit(0);
    }

    console.log('✓ Device marked as offline');
    process.exit(0); // Success

} catch (error) {
    clearTimeout(timeoutHandle);
    console.error('❌ Unexpected error:', error.message);
    process.exit(5); // Exit code 5 for unexpected error
}
