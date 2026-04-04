import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getBaseStateDir,
  getStateDir,
  getStatePath,
  getIntegrationStateDir,
  getBmadStatePath,
  getBmadArtifactIndexPath,
  getBmadReconcileLogPath,
  getBmadDriftLogPath,
} from '../state-paths.js';

describe.skip('state paths BMAD contract', () => {
  it('builds integration and BMAD state paths', () => {
    const base = getBaseStateDir('/repo');
    assert.equal(base, '/repo/.omx/state');
    assert.equal(getStateDir('/repo'), '/repo/.omx/state');
    assert.equal(getStatePath('team', '/repo'), '/repo/.omx/state/team-state.json');
    assert.equal(getIntegrationStateDir('/repo'), '/repo/.omx/state/integrations');
    assert.equal(getBmadStatePath('/repo'), '/repo/.omx/state/integrations/bmad.json');
    assert.equal(getBmadArtifactIndexPath('/repo'), '/repo/.omx/state/integrations/bmad-artifact-index.json');
    assert.equal(getBmadReconcileLogPath('/repo'), '/repo/.omx/state/integrations/bmad-reconcile-log.json');
    assert.equal(getBmadDriftLogPath('/repo'), '/repo/.omx/state/integrations/bmad-drift-log.json');
  });
});
