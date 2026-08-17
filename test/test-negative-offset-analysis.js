#!/usr/bin/env node

/**
 * Historical companion for the negative-offset regression.
 *
 * An older read_file implementation computed a negative slice end from the
 * raw offset and could return an empty range. That implementation is no longer
 * current. The executable behavior is covered by test-negative-offset-readfile.js,
 * which verifies tail-style offsets and edge cases against the real handler.
 *
 * Keep this module only as a guard against reintroducing the stale conclusion
 * into suite output; it intentionally does not duplicate the behavioral test.
 */

export default async function runTests() {
  console.log('Negative-offset historical analysis: superseded by behavioral regression');
  return true;
}
