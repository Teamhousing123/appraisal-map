// Build the production bundle with harness env and stamp it so runs can detect
// env drift.
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { BUILD_ENV } from './env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = process.env.PERF_REPO
  ? resolve(process.env.PERF_REPO)
  : resolve(here, '..', '..');
const STAMP = join(REPO_ROOT, 'build', '.harness-env');

// The stamp must reflect both the harness env AND the source state, or an
// older build/ directory gets served as if it were current code.
function sourceStamp() {
  try {
    const head = execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();
    // Hash the uncommitted content, not just the list of dirty files, so a
    // second edit to an already-modified file still triggers a rebuild.
    const dirty = execSync('git diff HEAD -- src public package.json package-lock.json', { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
    const untracked = execSync('git ls-files --others --exclude-standard -- src public', { cwd: REPO_ROOT }).toString();
    return createHash('sha1').update(head + dirty + untracked).digest('hex').slice(0, 12);
  } catch {
    // Not a git repo — fall back to the src/ mtime.
    return String(statSync(join(REPO_ROOT, 'src')).mtimeMs);
  }
}

export function envStamp() {
  return createHash('sha1')
    .update(JSON.stringify(BUILD_ENV))
    .update(sourceStamp())
    .digest('hex').slice(0, 12);
}

export function ensureBuild() {
  const stamp = envStamp();
  if (existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === stamp) return false;
  console.log('[harness] building production bundle with harness env…');
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...BUILD_ENV, CI: 'true' },
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) throw new Error('npm run build failed');
  writeFileSync(STAMP, stamp);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureBuild();
}
