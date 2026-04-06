import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const autopilotSkill = readFileSync(
  join(__dirname, '../../../skills/autopilot/SKILL.md'),
  'utf-8',
);

describe('pre-context gate BMAD skill contract', () => {
  it('autopilot documents BMAD routing before the standard non-BMAD phase stack', () => {
    const routingIndex = autopilotSkill.indexOf('BMAD routing gate');
    const expansionIndex = autopilotSkill.indexOf('Phase 0 - Expansion (non-BMAD path)');
    assert.notEqual(routingIndex, -1);
    assert.notEqual(expansionIndex, -1);
    assert.ok(routingIndex < expansionIndex);
  });
});
