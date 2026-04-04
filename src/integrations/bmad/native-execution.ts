import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BmadNativeExecutionRequest,
  BmadNativeExecutionResult,
} from './contracts.js';
import { renderBmadWorkflowHandoff } from './handoff.js';

export interface BmadNativeExecutionAdapter {
  (request: BmadNativeExecutionRequest): Promise<BmadNativeExecutionResult>;
}

export async function prepareBmadNativeExecutionArtifacts(
  request: BmadNativeExecutionRequest,
): Promise<{ handoffPath: string | null; artifactPaths: string[] }> {
  const root = request.handoff.implementationArtifactsRoot;
  if (!root || !request.handoff.storyPath) {
    return { handoffPath: null, artifactPaths: [] };
  }
  const slug = request.handoff.storyPath
    .split('/')
    .pop()
    ?.replace(/\.[^.]+$/u, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'story';
  const relativePath = join(root, `omx-native-exec-handoff-${slug}.md`).replace(/\\/g, '/');
  const fullPath = join(request.cwd, relativePath);
  await mkdir(join(request.cwd, root), { recursive: true });
  await writeFile(
    fullPath,
    `${renderBmadWorkflowHandoff(request.handoff)}- Task: ${request.task}\n- Iteration: ${request.iteration}\n- Backend family: bmad-native\n`,
    'utf-8',
  );
  return { handoffPath: relativePath, artifactPaths: [relativePath] };
}

export async function runBmadNativeExecution(
  request: BmadNativeExecutionRequest,
  adapter?: BmadNativeExecutionAdapter,
): Promise<BmadNativeExecutionResult> {
  const prepared = await prepareBmadNativeExecutionArtifacts(request);
  if (!adapter) {
    return {
      status: 'unsupported',
      backend: 'bmad-native',
      handoffPath: prepared.handoffPath ?? undefined,
      artifactPaths: prepared.artifactPaths,
      error: 'bmad_native_executor_not_configured',
    };
  }
  const result = await adapter(request);
  return {
    ...result,
    backend: 'bmad-native',
    handoffPath: result.handoffPath ?? prepared.handoffPath ?? undefined,
    artifactPaths: [...prepared.artifactPaths, ...(result.artifactPaths ?? [])],
  };
}
