import { describe, expect, it } from 'vitest';
import { enforceSingleInstance } from '../../src/main/single-instance.js';
import { FakeSingleInstanceHost } from './support.js';

describe('enforceSingleInstance', () => {
  it('becomes the primary instance when the lock is granted', () => {
    const host = new FakeSingleInstanceHost(true);

    const result = enforceSingleInstance({ host, onSecondInstance: () => undefined });

    expect(result.isPrimary).toBe(true);
    expect(host.quitCount).toBe(0);
    expect(host.hasSecondInstanceListener).toBe(true);
  });

  it('quits and reports non-primary when another instance holds the lock', () => {
    const host = new FakeSingleInstanceHost(false);

    const result = enforceSingleInstance({ host, onSecondInstance: () => undefined });

    expect(result.isPrimary).toBe(false);
    expect(host.quitCount).toBe(1);
    // A losing instance must not register anything: no tray, no listener.
    expect(host.hasSecondInstanceListener).toBe(false);
  });

  it('reveals the existing instance when a second launch is attempted', () => {
    const host = new FakeSingleInstanceHost(true);
    const reveals: (readonly string[])[] = [];

    enforceSingleInstance({ host, onSecondInstance: (argv) => reveals.push(argv) });
    host.launchSecondInstance(['pilot', '--from-dock']);

    expect(reveals).toEqual([['pilot', '--from-dock']]);
  });
});
