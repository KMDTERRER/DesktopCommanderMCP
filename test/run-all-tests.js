/**
 * Main test runner script
 * Runs all test modules and provides comprehensive summary
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { fileURLToPath } from 'url';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const positiveIntEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
const TEST_CONCURRENCY = Math.min(
  positiveIntEnv('DC_TEST_CONCURRENCY', 6),
  os.availableParallelism(),
);
const TEST_TIMEOUT_MS = positiveIntEnv('DC_TEST_TIMEOUT_MS', 90_000);
const BUILD_TIMEOUT_MS = positiveIntEnv('DC_BUILD_TIMEOUT_MS', 120_000);
const TEST_OUTPUT_LIMIT_BYTES = positiveIntEnv('DC_TEST_OUTPUT_LIMIT_BYTES', 2_000_000);
const TEST_VERBOSE = process.env.DC_TEST_VERBOSE === '1';

function processHasExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null;
}

async function terminateProcessTree(proc) {
  if (!proc.pid || processHasExited(proc)) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
      const timer = setTimeout(() => { killer.kill('SIGKILL'); resolve(); }, 3000);
      timer.unref?.();
      killer.once('error', () => { clearTimeout(timer); resolve(); });
      killer.once('close', () => { clearTimeout(timer); resolve(); });
    });
  } else {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
  }
  if (!processHasExited(proc)) proc.kill('SIGKILL');
}

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  bold: '\x1b[1m'
};

/**
 * Run a command and return its output
 */
function runCommand(command, args, cwd = __dirname, timeoutMs = BUILD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    console.log(`${colors.blue}Running command: ${command} ${args.join(' ')}${colors.reset}`);
    
    const windowsNpm = process.platform === 'win32' && command === 'npm';
    const executable = windowsNpm ? (process.env.ComSpec || 'cmd.exe') : command;
    const commandArgs = windowsNpm ? ['/d', '/s', '/c', [command, ...args].join(' ')] : args;
    const proc = spawn(executable, commandArgs, {
      cwd,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(proc);
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (!timedOut && code === 0) resolve();
      else reject(new Error(timedOut ? `Command timed out after ${timeoutMs}ms` : `Command failed with exit code ${code}`));
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Run a single Node.js test file as a subprocess
 */
async function runTestFile(testFile) {
  const testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-test-'));
  await fs.mkdir(path.join(testHome, 'Documents'), { recursive: true });

  return new Promise((resolve) => {
    console.log(`${colors.cyan}→ ${testFile}${colors.reset}`);
    const startTime = Date.now();
    let output = '';
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    const proc = spawn(process.execPath, [testFile], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
      },
    });

    const capture = (chunk, stream) => {
      if (TEST_VERBOSE) { stream.write(chunk); return; }
      if (outputBytes >= TEST_OUTPUT_LIMIT_BYTES) { outputTruncated = true; return; }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = TEST_OUTPUT_LIMIT_BYTES - outputBytes;
      const retained = bytes.subarray(0, remaining);
      output += retained.toString();
      outputBytes += retained.length;
      if (retained.length < bytes.length) outputTruncated = true;
    };
    proc.stdout.on('data', (chunk) => capture(chunk, process.stdout));
    proc.stderr.on('data', (chunk) => capture(chunk, process.stderr));

    const timeout = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(proc);
    }, TEST_TIMEOUT_MS);

    const finish = async ({ code = null, signal = null, error } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      await fs.rm(testHome, { recursive: true, force: true }).catch(() => {});
      const success = !timedOut && !error && code === 0;
      if (success) {
        console.log(`${colors.green}✓ ${testFile} (${duration}ms)${colors.reset}`);
      } else {
        const reason = timedOut ? `timeout ${TEST_TIMEOUT_MS}ms` : error?.message ?? `exit ${code}${signal ? `, ${signal}` : ''}`;
        console.error(`${colors.red}✗ ${testFile} (${duration}ms) - ${reason}${colors.reset}`);
        if (!TEST_VERBOSE && output) console.error(output.trimEnd());
        if (outputTruncated) console.error(`[test output truncated at ${TEST_OUTPUT_LIMIT_BYTES} bytes]`);
      }
      resolve({ success, file: testFile, duration, exitCode: code, signal, timedOut, error: error?.message });
    };

    proc.on('close', (code, signal) => { void finish({ code, signal }); });
    proc.on('error', (error) => { void finish({ error }); });
  });
}

/**
 * Build the project
 */
async function buildProject() {
  console.log(`\n${colors.cyan}===== Building project =====${colors.reset}\n`);
  await runCommand('npm', ['run', 'build']);
}

/**
 * Discover and run all test modules
 */
async function runTestModules() {
  console.log(`\n${colors.cyan}===== Running tests =====${colors.reset}\n`);
  
  // Discover all test files
  let testFiles = [];
  try {
    const files = await fs.readdir(__dirname);
    
    // Get all test files, starting with 'test' and ending with '.js'
    const discoveredTests = files
      .filter(file => file.startsWith('test') && file.endsWith('.js') && file !== 'run-all-tests.js')
      .sort(); // Sort for consistent order
    
    // Start the measured slow tests in the first worker batch so their latency
    // overlaps the rest of the suite instead of becoming a serial tail.
    for (const file of ['test-pdf-creation.js', 'test-onboarding-injection-flag.js', 'test.js']) {
      const index = discoveredTests.indexOf(file);
      if (index >= 0) {
        testFiles.push(`./${file}`);
        discoveredTests.splice(index, 1);
      }
    }

    testFiles.push(...discoveredTests.map(file => `./${file}`));
    
  } catch (error) {
    console.error(`${colors.red}Error: Could not scan test directory: ${error.message}${colors.reset}`);
    process.exit(1);
  }
  
  if (testFiles.length === 0) {
    console.warn(`${colors.yellow}Warning: No test files found${colors.reset}`);
    return { success: true, results: [] };
  }
  
  console.log(`${colors.blue}Found ${testFiles.length} test files:${colors.reset}`);
  testFiles.forEach(file => console.log(`  - ${file}`));
  console.log('');
  
  const workerCount = Math.min(TEST_CONCURRENCY, testFiles.length);
  console.log(`${colors.blue}Concurrency: ${workerCount} (available: ${os.availableParallelism()})${colors.reset}\n`);
  const results = new Array(testFiles.length);
  let nextIndex = 0;
  const testWallStart = Date.now();

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= testFiles.length) return;
      results[index] = await runTestFile(testFiles[index]);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  const wallDuration = Date.now() - testWallStart;
  const totalDuration = results.reduce((sum, result) => sum + (result.duration || 0), 0);
  
  // Calculate summary statistics
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const failedTests = results.filter(r => !r.success);
  
  // Print detailed summary
  console.log(`\n${colors.bold}${colors.cyan}===== TEST SUMMARY =====${colors.reset}\n`);
  
  // Overall stats
  console.log(`${colors.bold}Overall Results:${colors.reset}`);
  console.log(`  Total tests:     ${passed + failed}`);
  console.log(`  ${colors.green}✓ Passed:        ${passed}${colors.reset}`);
  console.log(`  ${failed > 0 ? colors.red : colors.green}✗ Failed:        ${failed}${colors.reset}`);
  console.log(`  Wall time:       ${wallDuration}ms (${(wallDuration / 1000).toFixed(1)}s)`);
  console.log(`  Cumulative time: ${totalDuration}ms (${(totalDuration / 1000).toFixed(1)}s)`);
  
  // Failed tests details
  if (failed > 0) {
    console.log(`\n${colors.red}${colors.bold}Failed Tests:${colors.reset}`);
    failedTests.forEach(test => {
      console.log(`  ${colors.red}✗ ${test.file}${colors.reset}`);
      if (test.exitCode !== undefined) {
        console.log(`    Exit code: ${test.exitCode}`);
      }
      if (test.error) {
        console.log(`    Error: ${test.error}`);
      }
    });
  }
  
  // Test performance summary
  if (results.length > 0) {
    console.log(`\n${colors.bold}Performance Summary:${colors.reset}`);
    const avgDuration = totalDuration / results.length;
    const slowestTest = results.reduce((prev, current) => 
      (current.duration || 0) > (prev.duration || 0) ? current : prev
    );
    const fastestTest = results.reduce((prev, current) => 
      (current.duration || 0) < (prev.duration || 0) ? current : prev
    );
    
    console.log(`  Average test duration: ${avgDuration.toFixed(0)}ms`);
    console.log(`  Fastest test: ${fastestTest.file} (${fastestTest.duration || 0}ms)`);
    console.log(`  Slowest test: ${slowestTest.file} (${slowestTest.duration || 0}ms)`);
  }
  
  // Final status
  if (failed === 0) {
    console.log(`\n${colors.green}${colors.bold}🎉 ALL TESTS PASSED! 🎉${colors.reset}`);
    console.log(`${colors.green}All ${passed} tests completed successfully.${colors.reset}`);
  } else {
    console.log(`\n${colors.red}${colors.bold}❌ TESTS FAILED ❌${colors.reset}`);
    console.log(`${colors.red}${failed} out of ${passed + failed} tests failed.${colors.reset}`);
  }
  
  console.log(`\n${colors.cyan}===== Test run completed =====${colors.reset}\n`);
  
  return {
    success: failed === 0,
    results,
    summary: {
      total: passed + failed,
      passed,
      failed,
      duration: totalDuration,
      wallDuration
    }
  };
}

/**
 * Main function
 */
async function main() {
  const overallStartTime = Date.now();
  
  try {
    console.log(`${colors.bold}${colors.cyan}===== DESKTOP COMMANDER TEST RUNNER =====${colors.reset}`);
    console.log(`${colors.blue}Starting test execution at ${new Date().toISOString()}${colors.reset}\n`);
    
    // Build the project first
    await buildProject();
    
    // Run all test modules
    const testResult = await runTestModules();
    
    // Final timing
    const overallDuration = Date.now() - overallStartTime;
    console.log(`${colors.blue}Total execution time: ${overallDuration}ms (${(overallDuration / 1000).toFixed(1)}s)${colors.reset}`);
    
    // Exit with appropriate code
    process.exit(testResult.success ? 0 : 1);
    
  } catch (error) {
    console.error(`\n${colors.red}${colors.bold}FATAL ERROR:${colors.reset}`);
    console.error(`${colors.red}${error.message}${colors.reset}`);
    if (error.stack) {
      console.error(`${colors.red}${error.stack}${colors.reset}`);
    }
    process.exit(1);
  }
}

// Handle uncaught errors gracefully
process.on('uncaughtException', (error) => {
  console.error(`\n${colors.red}${colors.bold}UNCAUGHT EXCEPTION:${colors.reset}`);
  console.error(`${colors.red}${error.message}${colors.reset}`);
  if (error.stack) {
    console.error(`${colors.red}${error.stack}${colors.reset}`);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`\n${colors.red}${colors.bold}UNHANDLED REJECTION:${colors.reset}`);
  console.error(`${colors.red}${reason}${colors.reset}`);
  process.exit(1);
});

// Run the main function
main().catch(error => {
  console.error(`\n${colors.red}${colors.bold}MAIN FUNCTION ERROR:${colors.reset}`);
  console.error(`${colors.red}${error.message}${colors.reset}`);
  if (error.stack) {
    console.error(`${colors.red}${error.stack}${colors.reset}`);
  }
  process.exit(1);
});
