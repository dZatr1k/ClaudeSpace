// Build the agent bundle once before all test files. Building it per file raced when files ran in parallel
// forks (both rewrote resources/agent at the same time) and made ssh/local integration tests flaky.
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export default function setup(): void {
  const root = resolve(__dirname, '..');
  execFileSync('python3', [join(root, 'agent', 'build_manifest.py')], { stdio: 'ignore' });
}
