import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BmadFixtureStory {
  path: string;
  content?: string;
}

export interface CreateBmadProjectOptions {
  outputRoot?: string;
  stories?: BmadFixtureStory[];
  includePrd?: boolean;
  includeArchitecture?: boolean;
  sprintStatus?: string;
  projectContextContents?: string;
  epicPath?: string;
  epicContents?: string;
}

export function buildBmadFixtureRefs(outputRoot = '_bmad-output'): {
  outputRoot: string;
  projectContextPath: string;
  prdPath: string;
  architecturePath: string;
  epicPath: string;
  storyPath: string;
  sprintStatusPath: string;
  implementationArtifactsRoot: string;
} {
  return {
    outputRoot,
    projectContextPath: `${outputRoot}/project-context.md`,
    prdPath: `${outputRoot}/planning-artifacts/PRD.md`,
    architecturePath: `${outputRoot}/planning-artifacts/architecture.md`,
    epicPath: `${outputRoot}/planning-artifacts/epics/epic-auth.md`,
    storyPath: `${outputRoot}/planning-artifacts/epics/story-login.md`,
    sprintStatusPath: `${outputRoot}/implementation-artifacts/sprint-status.yaml`,
    implementationArtifactsRoot: `${outputRoot}/implementation-artifacts`,
  };
}

export async function createBmadProject(root: string, options: CreateBmadProjectOptions = {}): Promise<void> {
  const refs = buildBmadFixtureRefs(options.outputRoot);
  const stories = options.stories ?? [{ path: refs.storyPath }];
  const epicPath = options.epicPath ?? refs.epicPath;

  await mkdir(join(root, '_bmad', 'core'), { recursive: true });
  await writeFile(join(root, '_bmad', 'core', 'config.yaml'), `output_folder: ${JSON.stringify(refs.outputRoot)}\n`);
  await mkdir(join(root, refs.outputRoot, 'planning-artifacts', 'epics'), { recursive: true });
  await mkdir(join(root, refs.outputRoot, 'implementation-artifacts'), { recursive: true });
  await writeFile(join(root, refs.projectContextPath), options.projectContextContents ?? '# Context\n');
  await writeFile(join(root, epicPath), options.epicContents ?? '# Epic\n');
  if (options.includePrd !== false) {
    await writeFile(join(root, refs.prdPath), '# PRD\n');
  }
  if (options.includeArchitecture !== false) {
    await writeFile(join(root, refs.architecturePath), '# Architecture\n');
  }
  for (const story of stories) {
    await writeFile(join(root, story.path), story.content ?? '# Story\n');
  }
  await writeFile(join(root, refs.sprintStatusPath), options.sprintStatus ?? 'stories:\n');
}
