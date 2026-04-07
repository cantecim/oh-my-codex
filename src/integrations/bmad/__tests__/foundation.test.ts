import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBmadArtifactIndex, detectBmadProject } from '../discovery.js';
import { classifyBmadDrift, deriveBmadProjection } from '../projection.js';
import { reconcileBmadIntegrationState } from '../reconcile.js';
import {
  getBmadArtifactIndexPath,
  getBmadDriftLogPath,
  getBmadReconcileLogPath,
  getBmadStatePath,
} from '../../../state/paths.js';

async function makeTempProject(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeProjectFile(root: string, relativePath: string, contents = ''): Promise<void> {
  const fullPath = join(root, relativePath);
  const lastSlash = fullPath.lastIndexOf('/');
  if (lastSlash >= 0) {
    await mkdir(fullPath.slice(0, lastSlash), { recursive: true });
  }
  await writeFile(fullPath, contents);
}

describe('BMAD detection', () => {
  it('detects _bmad as a strong signal', async () => {
    const root = await makeTempProject('omx-bmad-detect-');
    try {
      await mkdir(join(root, '_bmad'), { recursive: true });
      const detected = detectBmadProject(root);
      assert.equal(detected.detected, true);
      assert.deepEqual(detected.detectionSignals, ['_bmad']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects _bmad-output as a strong signal', async () => {
    const root = await makeTempProject('omx-bmad-detect-');
    try {
      await mkdir(join(root, '_bmad-output'), { recursive: true });
      const detected = detectBmadProject(root);
      assert.equal(detected.detected, true);
      assert.deepEqual(detected.detectionSignals, ['_bmad-output']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const outputRoot of ['_bmad-output', 'docs']) {
    it(`detects configured output_folder from core config (${outputRoot})`, async () => {
      const root = await makeTempProject('omx-bmad-detect-');
      try {
        await writeProjectFile(root, '_bmad/core/config.yaml', `output_folder: "${outputRoot}"\n`);
        await mkdir(join(root, outputRoot), { recursive: true });
        const detected = detectBmadProject(root);
        assert.equal(detected.detected, true);
        assert.ok(detected.detectionSignals.includes('_bmad/core/config.yaml'));
        assert.ok(detected.detectionSignals.includes(outputRoot));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it('detects placeholder-based output_folder values after project-root normalization', async () => {
    const root = await makeTempProject('omx-bmad-detect-');
    try {
      await writeProjectFile(root, '_bmad/core/config.yaml', 'output_folder: "{project-root}/docs"\n');
      await mkdir(join(root, 'docs'), { recursive: true });
      const detected = detectBmadProject(root);
      assert.equal(detected.detected, true);
      assert.ok(detected.detectionSignals.includes('_bmad/core/config.yaml'));
      assert.ok(detected.detectionSignals.includes('docs'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns no detection for non-BMAD repositories', async () => {
    const root = await makeTempProject('omx-bmad-detect-');
    try {
      await writeProjectFile(root, 'README.md', '# hello');
      const detected = detectBmadProject(root);
      assert.equal(detected.detected, false);
      assert.deepEqual(detected.detectionSignals, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('BMAD artifact indexing and projection', () => {
  it('indexes planning and implementation artifacts', async () => {
    const root = await makeTempProject('omx-bmad-index-');
    try {
      await writeProjectFile(root, '_bmad-output/project-context.md', '# context');
      await writeProjectFile(root, '_bmad-output/planning-artifacts/PRD.md', '# prd');
      await writeProjectFile(root, '_bmad-output/planning-artifacts/architecture.md', '# arch');
      await writeProjectFile(root, '_bmad-output/planning-artifacts/epics/epic-1.md', '# epic');
      await writeProjectFile(root, '_bmad-output/planning-artifacts/epics/story-login.md', '# story');
      await writeProjectFile(root, '_bmad-output/implementation-artifacts/sprint-status.yaml', 'status: active');

      const index = await buildBmadArtifactIndex(root);
      assert.equal(index.outputRoot, '_bmad-output');
      assert.equal(index.projectContextPath, '_bmad-output/project-context.md');
      assert.deepEqual(index.prdPaths, ['_bmad-output/planning-artifacts/PRD.md']);
      assert.deepEqual(index.architecturePaths, ['_bmad-output/planning-artifacts/architecture.md']);
      assert.ok(index.epicPaths.includes('_bmad-output/planning-artifacts/epics/epic-1.md'));
      assert.ok(index.storyPaths.includes('_bmad-output/planning-artifacts/epics/story-login.md'));
      assert.deepEqual(index.sprintStatusPaths, ['_bmad-output/implementation-artifacts/sprint-status.yaml']);
      assert.ok(index.implementationArtifactPaths.includes('_bmad-output/implementation-artifacts/sprint-status.yaml'));
      assert.ok(index.pathMetadata['_bmad-output/project-context.md']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const outputRoot of ['_bmad-output', 'docs']) {
    it(`indexes artifacts from configured output_folder (${outputRoot})`, async () => {
      const root = await makeTempProject('omx-bmad-index-');
      try {
        await writeProjectFile(root, '_bmad/core/config.yaml', `output_folder: ${outputRoot}\n`);
        await writeProjectFile(root, `${outputRoot}/project-context.md`, '# context');
        await writeProjectFile(root, `${outputRoot}/planning-artifacts/PRD.md`, '# prd');
        await writeProjectFile(root, `${outputRoot}/planning-artifacts/architecture.md`, '# arch');
        await writeProjectFile(root, `${outputRoot}/planning-artifacts/epics/story-login.md`, '# story');
        await writeProjectFile(root, `${outputRoot}/implementation-artifacts/sprint-status.yaml`, 'status: active');

        const index = await buildBmadArtifactIndex(root);
        assert.equal(index.outputRoot, outputRoot);
        assert.equal(index.projectContextPath, `${outputRoot}/project-context.md`);
        assert.deepEqual(index.storyPaths, [`${outputRoot}/planning-artifacts/epics/story-login.md`]);
        assert.deepEqual(index.sprintStatusPaths, [`${outputRoot}/implementation-artifacts/sprint-status.yaml`]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it(`indexes numeric BMAD story filenames under epics directories for configured output roots (${outputRoot})`, async () => {
      const root = await makeTempProject('omx-bmad-index-');
      try {
        await writeProjectFile(root, '_bmad/core/config.yaml', `output_folder: ${outputRoot}\n`);
        await writeProjectFile(root, `${outputRoot}/planning-artifacts/epics/epic-growth.md`, '# epic');
        await writeProjectFile(root, `${outputRoot}/planning-artifacts/epics/3-5-instrument-wizard-progression-and-abandonment-events.md`, '# story');

        const index = await buildBmadArtifactIndex(root);
        assert.ok(index.epicPaths.includes(`${outputRoot}/planning-artifacts/epics/epic-growth.md`));
        assert.ok(index.storyPaths.includes(`${outputRoot}/planning-artifacts/epics/3-5-instrument-wizard-progression-and-abandonment-events.md`));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it('indexes artifacts from placeholder-based output_folder values', async () => {
    const root = await makeTempProject('omx-bmad-index-');
    try {
      await writeProjectFile(root, '_bmad/core/config.yaml', 'output_folder: "{project-root}/docs"\n');
      await writeProjectFile(root, 'docs/project-context.md', '# context');
      await writeProjectFile(root, 'docs/planning-artifacts/PRD.md', '# prd');
      await writeProjectFile(root, 'docs/planning-artifacts/architecture.md', '# arch');
      await writeProjectFile(root, 'docs/planning-artifacts/epics/3-5-instrument-wizard-progression-and-abandonment-events.md', '# story');
      await writeProjectFile(root, 'docs/implementation-artifacts/sprint-status.yaml', 'status: active');

      const index = await buildBmadArtifactIndex(root);
      assert.equal(index.outputRoot, 'docs');
      assert.equal(index.projectContextPath, 'docs/project-context.md');
      assert.ok(index.storyPaths.includes('docs/planning-artifacts/epics/3-5-instrument-wizard-progression-and-abandonment-events.md'));
      assert.deepEqual(index.sprintStatusPaths, ['docs/implementation-artifacts/sprint-status.yaml']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('infers planning for PRD-only projects', async () => {
    const root = await makeTempProject('omx-bmad-phase-');
    try {
      await writeProjectFile(root, '_bmad-output/planning-artifacts/PRD.md', '# prd');
      const projection = deriveBmadProjection(await buildBmadArtifactIndex(root));
      assert.equal(projection.phase, 'planning');
      assert.equal(projection.planningReadiness, true);
      assert.equal(projection.implementationReadiness, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('infers mixed for PRD plus architecture without implementation units because implementation artifacts exist', async () => {
    const root = await makeTempProject('omx-bmad-phase-');
    try {
      await writeProjectFile(root, '_bmad-output/planning-artifacts/PRD.md', '# prd');
      await writeProjectFile(root, '_bmad-output/planning-artifacts/architecture.md', '# arch');
      await writeProjectFile(root, '_bmad-output/implementation-artifacts/notes.md', 'todo');
      const projection = deriveBmadProjection(await buildBmadArtifactIndex(root));
      assert.equal(projection.phase, 'mixed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('infers solutioning for architecture without implementation artifacts', async () => {
    const root = await makeTempProject('omx-bmad-phase-');
    try {
      await writeProjectFile(root, '_bmad-output/planning-artifacts/architecture.md', '# arch');
      const projection = deriveBmadProjection(await buildBmadArtifactIndex(root));
      assert.equal(projection.phase, 'solutioning');
      assert.equal(projection.implementationReadiness, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('infers implementation when stories exist', async () => {
    const root = await makeTempProject('omx-bmad-phase-');
    try {
      await writeProjectFile(root, '_bmad-output/planning-artifacts/architecture.md', '# arch');
      await writeProjectFile(root, '_bmad-output/planning-artifacts/epics/story-api.md', '# story');
      const projection = deriveBmadProjection(await buildBmadArtifactIndex(root));
      assert.equal(projection.phase, 'implementation');
      assert.equal(projection.implementationReadiness, true);
      assert.equal(projection.activeStoryRef, '_bmad-output/planning-artifacts/epics/story-api.md');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('infers implementation when sprint-status is present', async () => {
    const root = await makeTempProject('omx-bmad-phase-');
    try {
      await writeProjectFile(root, '_bmad-output/planning-artifacts/architecture.md', '# arch');
      await writeProjectFile(root, '_bmad-output/implementation-artifacts/sprint-status.yaml', 'status: active');
      const projection = deriveBmadProjection(await buildBmadArtifactIndex(root));
      assert.equal(projection.phase, 'implementation');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('BMAD drift classification', () => {
  it('reports none when the artifact index version is unchanged', async () => {
    const root = await makeTempProject('omx-bmad-drift-');
    try {
      await writeProjectFile(root, '_bmad-output/planning-artifacts/PRD.md', '# prd');
      const index = await buildBmadArtifactIndex(root);
      const drift = classifyBmadDrift(index, {
        detected: true,
        artifactIndexVersion: index.artifactIndexVersion,
      });
      assert.equal(drift, 'none');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports soft when non-primary index metadata changes', async () => {
    const root = await makeTempProject('omx-bmad-drift-');
    try {
      await writeProjectFile(root, '_bmad-output/planning-artifacts/PRD.md', '# prd');
      const firstIndex = await buildBmadArtifactIndex(root);
      await writeProjectFile(root, '_bmad-output/implementation-artifacts/notes.md', 'one');
      const secondIndex = await buildBmadArtifactIndex(root);
      const drift = classifyBmadDrift(secondIndex, {
        detected: true,
        artifactIndexVersion: firstIndex.artifactIndexVersion,
      }, firstIndex);
      assert.equal(drift, 'soft');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports medium when a primary artifact disappears or moves', async () => {
    const root = await makeTempProject('omx-bmad-drift-');
    try {
      await writeProjectFile(root, '_bmad-output/planning-artifacts/PRD.md', '# prd');
      const firstIndex = await buildBmadArtifactIndex(root);
      await rm(join(root, '_bmad-output/planning-artifacts/PRD.md'), { force: true });
      await writeProjectFile(root, '_bmad-output/planning-artifacts/product-prd.md', '# moved');
      const secondIndex = await buildBmadArtifactIndex(root);
      const drift = classifyBmadDrift(secondIndex, {
        detected: true,
        artifactIndexVersion: firstIndex.artifactIndexVersion,
      }, firstIndex);
      assert.equal(drift, 'medium');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports hard when BMAD roots disappear after prior detection', async () => {
    const root = await makeTempProject('omx-bmad-drift-');
    try {
      await writeProjectFile(root, '_bmad-output/planning-artifacts/PRD.md', '# prd');
      const firstIndex = await buildBmadArtifactIndex(root);
      await rm(join(root, '_bmad-output'), { recursive: true, force: true });
      const secondIndex = await buildBmadArtifactIndex(root);
      const drift = classifyBmadDrift(secondIndex, {
        detected: true,
        artifactIndexVersion: firstIndex.artifactIndexVersion,
      }, firstIndex);
      assert.equal(drift, 'hard');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('BMAD reconcile persistence', () => {
  it('persists integration state and artifact index under .omx/state/integrations', async () => {
    const root = await makeTempProject('omx-bmad-reconcile-');
    try {
      await writeProjectFile(root, '_bmad-output/planning-artifacts/PRD.md', '# prd');
      const result = await reconcileBmadIntegrationState(root);

      assert.equal(result.state.detected, true);
      assert.equal(existsSync(getBmadStatePath(root)), true);
      assert.equal(existsSync(getBmadArtifactIndexPath(root)), true);
      assert.equal(existsSync(getBmadReconcileLogPath(root)), true);

      const persistedState = JSON.parse(await readFile(getBmadStatePath(root), 'utf-8')) as { phase: string };
      assert.equal(persistedState.phase, 'planning');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds the reconcile log to the latest 50 entries and writes drift logs only when drift occurs', async () => {
    const root = await makeTempProject('omx-bmad-reconcile-');
    try {
      await writeProjectFile(root, '_bmad-output/planning-artifacts/PRD.md', '# prd');
      await reconcileBmadIntegrationState(root);

      for (let i = 0; i < 55; i++) {
        const filePath = join(root, '_bmad-output', 'implementation-artifacts', `notes-${i}.md`);
        await writeProjectFile(root, `_bmad-output/implementation-artifacts/notes-${i}.md`, `${i}`);
        const now = new Date(Date.now() + i + 1);
        await utimes(filePath, now, now);
        await reconcileBmadIntegrationState(root);
      }

      const reconcileLog = JSON.parse(
        await readFile(getBmadReconcileLogPath(root), 'utf-8'),
      ) as Array<{ artifactIndexVersion: string }>;
      assert.equal(reconcileLog.length, 50);

      assert.equal(existsSync(getBmadDriftLogPath(root)), true);
      const driftLog = JSON.parse(
        await readFile(getBmadDriftLogPath(root), 'utf-8'),
      ) as Array<{ driftStatus: string }>;
      assert.ok(driftLog.length > 0);
      assert.ok(driftLog.every((entry) => entry.driftStatus !== 'none'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
