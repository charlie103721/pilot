import { describe, expect, it } from 'vitest';
import { PERMISSION_FIXTURES } from '../../src/ipc/schemas.js';
import { runPermissionDemo } from '../../src/permissions/demo.js';

/**
 * The demo command is a deliverable, so it is tested like one. A demo that
 * silently stopped covering a state would be worse than no demo: the reviewer
 * would believe they had walked all four.
 */

describe('permission demo', () => {
  it('walks every fixture the app can be switched into', async () => {
    const result = await runPermissionDemo('linux');
    const text = result.lines.join('\n');

    expect(result.fixtures).toEqual([...PERMISSION_FIXTURES]);
    for (const fixture of PERMISSION_FIXTURES) {
      expect(text).toContain(`── fixture: ${fixture}`);
    }
  });

  it('shows all four contract states and both §16 failure modes', async () => {
    const text = (await runPermissionDemo('linux')).lines.join('\n');

    for (const label of ['Not asked for yet', 'Allowed', 'Refused', 'Not available on this Mac']) {
      expect(text).toContain(label);
    }
    expect(text).toContain('readiness : blocked');
    expect(text).toContain('readiness : degraded');
    expect(text).toContain('readiness : ready');
  });

  it('shows the recovery from denied to granted with nothing restarted', async () => {
    const text = (await runPermissionDemo('linux')).lines.join('\n');

    const before = text.indexOf('  before:');
    const after = text.indexOf('  after the user allows them in System Settings:');
    expect(before).toBeGreaterThan(-1);
    expect(after).toBeGreaterThan(before);
    expect(text.slice(before, after)).toContain('readiness : blocked');
    expect(text.slice(after)).toContain('readiness : ready');
  });

  it('reports the System Settings shortcut honestly for each platform', async () => {
    const text = (await runPermissionDemo('linux')).lines.join('\n');

    expect(text).toContain('darwin     available=true');
    expect(text).toContain('linux      available=false');
    expect(text).toContain('(unavailable here)');
  });
});
