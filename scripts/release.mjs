#!/usr/bin/env node
// Prepare a release: set package.json (+ lock) version, commit "Release vX.Y.Z", tag vX.Y.Z. Does NOT push:
// prints the push command; the tag push starts .github/workflows/release.yml (installer + GitHub Release).
// Usage: npm run release -- 0.2.0   (or: node scripts/release.mjs 0.2.0)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const die = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) die('usage: node scripts/release.mjs <x.y.z>');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const cmp = (a, b) => {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};
if (cmp(version, pkg.version) <= 0) die(`${version} is not newer than the current ${pkg.version}`);
if (git('status', '--porcelain')) die('the working tree is not clean: commit or stash first');
const tag = `v${version}`;
if (git('tag', '--list', tag)) die(`tag ${tag} already exists`);
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');

// npm keeps package.json and package-lock.json in step; no git actions of its own
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['version', version, '--no-git-tag-version'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
git('add', 'package.json', 'package-lock.json');
git('commit', '-m', `Release ${tag}`);
git('tag', '-a', tag, '-m', `Release ${tag}`);

console.log(`\nCommitted and tagged ${tag} on ${branch}. Nothing was pushed. To publish:\n`);
console.log(`  git push origin ${branch} ${tag}\n`);
console.log('GitHub Actions (Release) then builds the installer and publishes it; installed apps update from it.');
