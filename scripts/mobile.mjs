// Build the Android app (docs/MOBILE.md): the web part (vite) -> Capacitor copies it into mobile/android -> Gradle.
// `npm run mobile:apk` writes out/android/ClaudeSpace-<version>-debug.apk.
// `npm run mobile:core` builds and tests the phone's Kotlin core (mobile/core) on the JVM, without Android.
// Needs JDK 21 and, for the APK, the Android SDK: JAVA_HOME / ANDROID_HOME, or the usual places in the home folder
// (~/.local/opt/jdk-21, ~/.local/opt/android-sdk, ~/Android/Sdk).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const android = join(root, 'mobile', 'android');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function firstDir(candidates, probe) {
  return candidates.find((d) => d && existsSync(join(d, probe)));
}

const task = process.argv[2] ?? 'apk';
const javaHome = firstDir([process.env.JAVA_HOME, join(homedir(), '.local/opt/jdk-21')], 'bin/java');
if (!javaHome) fail('JDK 21 not found: set JAVA_HOME');
const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const daemon = process.env.CI ? ['--no-daemon'] : [];

if (task === 'core') {
  // the core has no wrapper of its own: the Android project's one runs it as a separate build
  const r = spawnSync(gradlew, ['-p', join(root, 'mobile', 'core'), 'test', ...daemon, ...process.argv.slice(3)], {
    cwd: android,
    env: { ...process.env, JAVA_HOME: javaHome },
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}
if (task !== 'apk') fail(`unknown task ${task}: apk or core`);

const sdk = firstDir(
  [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), '.local/opt/android-sdk'),
    join(homedir(), 'Android/Sdk'),
  ],
  'platforms',
);
if (!sdk) fail('Android SDK not found: set ANDROID_HOME');

const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk };
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

run(npx, ['vite', 'build', '--config', 'vite.mobile.config.ts'], root);
run(npx, ['cap', 'sync', 'android'], root);
run(gradlew, ['assembleDebug', ...daemon], android);

const apk = join(android, 'app/build/outputs/apk/debug/app-debug.apk');
const outDir = join(root, 'out', 'android');
const out = join(outDir, `ClaudeSpace-${version}-debug.apk`);
mkdirSync(outDir, { recursive: true });
copyFileSync(apk, out);
console.warn(`APK: ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited with ${r.status ?? r.signal}`);
}

function fail(msg) {
  console.error(`mobile: ${msg}`);
  process.exit(1);
}
