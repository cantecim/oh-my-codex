import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_ROOT = join(process.cwd(), '.omx', 'test-locks');
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 100;
const LOCK_STALE_MS = 120_000;

interface LockMetadata {
  pid: number;
  started_at: string;
  scope: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeLockScope(scope: string): string {
  const normalized = scope.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return normalized || 'default';
}

function lockDirForScope(scope: string): string {
  return join(LOCK_ROOT, `packaged-explore-harness-${sanitizeLockScope(scope)}.lock`);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockMetadata(lockDir: string): Promise<LockMetadata | null> {
  const metadataPath = join(lockDir, 'owner.json');
  try {
    const parsed = JSON.parse(await readFile(metadataPath, 'utf-8')) as Partial<LockMetadata>;
    if (!Number.isInteger(parsed.pid) || typeof parsed.started_at !== 'string' || typeof parsed.scope !== 'string') {
      return null;
    }
    return { pid: parsed.pid as number, started_at: parsed.started_at, scope: parsed.scope };
  } catch {
    return null;
  }
}

function isStaleLock(metadata: LockMetadata | null): boolean {
  if (!metadata) return true;
  const startedAtMs = Date.parse(metadata.started_at);
  if (!isPidAlive(metadata.pid)) return true;
  if (!Number.isFinite(startedAtMs)) return true;
  return Date.now() - startedAtMs > LOCK_STALE_MS;
}

export async function withPackagedExploreHarnessLock<T>(scopeOrFn: string | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> {
  const scope = typeof scopeOrFn === 'string' ? scopeOrFn : 'default';
  const fn = (typeof scopeOrFn === 'function' ? scopeOrFn : maybeFn);
  if (!fn) {
    throw new Error('withPackagedExploreHarnessLock requires a callback');
  }

  const startedAt = Date.now();
  const lockDir = lockDirForScope(scope);
  await mkdir(LOCK_ROOT, { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir);
      const metadata: LockMetadata = {
        pid: process.pid,
        started_at: new Date().toISOString(),
        scope: sanitizeLockScope(scope),
      };
      await writeFile(join(lockDir, 'owner.json'), JSON.stringify(metadata, null, 2));
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      const metadata = await readLockMetadata(lockDir);
      if (isStaleLock(metadata)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for packaged explore harness test lock at ${lockDir}`);
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

export async function withPackagedExploreHarnessHidden<T>(scopeOrFn: string | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> {
  const scope = typeof scopeOrFn === 'string' ? scopeOrFn : 'default';
  const fn = (typeof scopeOrFn === 'function' ? scopeOrFn : maybeFn);
  if (!fn) {
    throw new Error('withPackagedExploreHarnessHidden requires a callback');
  }

  return withPackagedExploreHarnessLock(scope, async () => {
    const packageBinDir = join(process.cwd(), 'bin');
    const packagedBinary = join(packageBinDir, process.platform === 'win32' ? 'omx-explore-harness.exe' : 'omx-explore-harness');
    const packagedMeta = join(packageBinDir, 'omx-explore-harness.meta.json');
    const originalBinary = existsSync(packagedBinary) ? await readFile(packagedBinary) : null;
    const originalMeta = existsSync(packagedMeta) ? await readFile(packagedMeta) : null;

    await rm(packagedBinary, { force: true });
    await rm(packagedMeta, { force: true });

    try {
      return await fn();
    } finally {
      if (originalBinary) {
        await writeFile(packagedBinary, originalBinary);
        if (process.platform !== 'win32') {
          await chmod(packagedBinary, 0o755);
        }
      } else {
        await rm(packagedBinary, { force: true });
      }
      if (originalMeta) {
        await writeFile(packagedMeta, originalMeta);
      } else {
        await rm(packagedMeta, { force: true });
      }
    }
  });
}
