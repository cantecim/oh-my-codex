import { resolve } from 'node:path';
import {
  appendDebugJsonl,
  buildTraceId,
  collectDebugEnvSubset,
  ensureDebugArtifactDir,
  isTestDebugEnabled,
  previewText,
  resolveCommandPath,
  resolveDebugArtifactDir,
  resolveDebugArtifactsRoot,
  resolveDebugTestId,
  writeDebugJson,
} from './debug-artifacts.js';

export {
  appendDebugJsonl,
  buildTraceId,
  collectDebugEnvSubset,
  ensureDebugArtifactDir,
  isTestDebugEnabled,
  previewText,
  resolveCommandPath,
  resolveDebugArtifactDir,
  resolveDebugArtifactsRoot,
  resolveDebugTestId,
  writeDebugJson,
};

export async function writeDebugFixtureManifest(
  cwd: string,
  {
    type,
    prefix,
    createdAt,
  }: {
    type: string;
    prefix: string;
    createdAt?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const debugArtifactDir = await ensureDebugArtifactDir(cwd, env);
  if (!debugArtifactDir) return;
  await writeDebugJson(cwd, 'manifest.json', {
    type,
    prefix,
    cwd: resolve(cwd),
    debug_artifact_dir: debugArtifactDir,
    test_id: resolveDebugTestId(cwd, env),
    created_at: createdAt || new Date().toISOString(),
  }, env);
  await writeDebugJson(cwd, 'env.json', collectDebugEnvSubset(env), env);
  await writeDebugJson(cwd, 'paths.json', {
    cwd: resolve(cwd),
    debug_artifact_dir: debugArtifactDir,
  }, env);
}
