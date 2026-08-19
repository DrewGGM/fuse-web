/**
 * Fails the build if the vendored core has drifted.
 *
 * Thin wrapper so `npm run core:check` reads as what it is, and so CI has a
 * step whose name explains the failure without anyone opening the test file.
 */
import { execSync } from 'node:child_process';

try {
  execSync('npx vitest run test/core-parity.test.ts --reporter=basic', { stdio: 'inherit' });
  console.log('\nVendored core matches the Android build.');
} catch {
  console.error('\nThe shared simulation has drifted between the two repositories.');
  console.error('Both builds submit to the same leaderboard, so this must be resolved');
  console.error('before deploying: run `npm run core:sync`, or reconcile deliberately.');
  process.exit(1);
}
