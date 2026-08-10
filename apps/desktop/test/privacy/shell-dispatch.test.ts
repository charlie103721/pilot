import { describe, expect, it } from 'vitest';
import {
  asRequestId,
  createCounterIdSource,
  createIdFactory,
  IPC_PROTOCOL_VERSION,
  type RequestEnvelope,
} from '@pilot/shared';
import type { InteractionCommand } from '@pilot/platform';
import { FakeInteractionController } from '@pilot/platform/fakes';
import { interactionDispatchChannel } from '../../src/ipc/channels.js';
import { DesktopShell } from '../../src/main/shell.js';
import { retentionEventForCommand } from '../../src/main/observation-runtime.js';
import {
  conversationHarness,
  FakePanelHost,
  FakeTrayHost,
  permissionHarness,
  scriptedWindowHarness,
} from '../main/support.js';

/**
 * The composition root has exactly one command route (PR-041).
 *
 * `main/index.ts` calls its `dispatchCommand` "the one way a command reaches the
 * machine, whatever dispatched it", and until this PR it was not: the menu bar
 * item's Pause and the renderer's `pilot:interaction/dispatch` channel both went
 * through `DesktopShell.dispatch`, straight to the controller. That cost nothing
 * until PR-040 made the system-design §13 retention occasion an *armed* fact, at
 * which point a pause from the menu bar cleared its buffers under whichever
 * occasion happened to be armed last — `observation-disabled` at best, and
 * `screen-lock` or `permission-loss` after one of those.
 *
 * The audit (`pnpm demo:privacy`, claim R1) proves the occasion is named on the
 * route the app now uses. This is the other half: that both surfaces reach that
 * route, so a second entry point cannot reappear without a red test.
 */

function harness(): {
  readonly shell: DesktopShell;
  readonly trayHost: FakeTrayHost;
  readonly seen: InteractionCommand[];
  readonly controller: FakeInteractionController;
} {
  const trayHost = new FakeTrayHost();
  const controller = new FakeInteractionController();
  const permissions = permissionHarness({ now: () => 1_700_000_000_000 });
  const windows = scriptedWindowHarness({
    permissions: permissions.gate,
    controller,
    now: () => 1_700_000_000_000,
  });
  const conversation = conversationHarness({ controller });
  const seen: InteractionCommand[] = [];
  const shell = new DesktopShell({
    panelHost: new FakePanelHost(),
    trayHost,
    controller,
    permissions: permissions.gate,
    windows: windows.gate,
    conversation: conversation.gate,
    // Exactly what `main/index.ts` passes: its own `dispatchCommand`.
    dispatch: (command) => {
      seen.push(command);
      conversation.gate.noteCommand(command);
      controller.dispatch(command);
    },
    appInfo: { version: '9.9.9', platform: 'linux' },
    quit: () => undefined,
    ids: createIdFactory(createCounterIdSource()),
    now: () => 1_700_000_000_000,
  });
  return { shell, trayHost, seen, controller };
}

let sequence = 0;
function request(channel: string, payload: unknown): RequestEnvelope {
  sequence += 1;
  return {
    kind: 'request',
    protocolVersion: IPC_PROTOCOL_VERSION,
    id: asRequestId(`req-${String(sequence).padStart(6, '0')}`),
    channel,
    issuedAt: 1,
    payload,
  };
}

describe('every command surface reaches the composition root’s one route', () => {
  it('routes the menu bar item’s Pause through it', async () => {
    const { shell, trayHost, seen } = harness();
    await shell.start();
    expect(
      trayHost.latest?.item('pause-resume'),
      'the menu bar item has no pause entry',
    ).toBeDefined();
    shell.tray.select('pause-resume');
    expect(seen.map((command) => command.type)).toContain('pause');
    shell.dispose();
  });

  it('routes the renderer’s `pilot:interaction/dispatch` channel through it', async () => {
    const { shell, seen } = harness();
    await shell.router.handle(request(interactionDispatchChannel.name, { type: 'pause' }), {
      senderId: 1,
    });
    expect(seen.map((command) => command.type)).toEqual(['pause']);
    shell.dispose();
  });

  it('still works for a shell built without one, which is what every other test does', () => {
    // The option is additive (runbook cross-lane issue 8): a shell with no
    // `dispatch` keeps PR-010's behaviour, so no existing caller changed.
    const trayHost = new FakeTrayHost();
    const controller = new FakeInteractionController();
    const permissions = permissionHarness({ now: () => 1_700_000_000_000 });
    const windows = scriptedWindowHarness({
      permissions: permissions.gate,
      controller,
      now: () => 1_700_000_000_000,
    });
    const conversation = conversationHarness({ controller });
    const shell = new DesktopShell({
      panelHost: new FakePanelHost(),
      trayHost,
      controller,
      permissions: permissions.gate,
      windows: windows.gate,
      conversation: conversation.gate,
      appInfo: { version: '9.9.9', platform: 'linux' },
      quit: () => undefined,
      ids: createIdFactory(createCounterIdSource()),
      now: () => 1_700_000_000_000,
    });
    shell.dispatch({ type: 'pause' });
    expect(controller.snapshot().state).toBe('paused');
    shell.dispose();
  });

  it('names an occasion for exactly the three commands that cause a clear', () => {
    // The mapping the route applies. `resume`, `submit-text` and the
    // push-to-talk pair reach the same function and must not arm anything: an
    // occasion armed by a command that does not clear would be read by the next
    // clear, which is the defect in the other direction.
    expect(retentionEventForCommand({ type: 'pause' })).toBe('pause');
    expect(retentionEventForCommand({ type: 'select-window', windowId: 'w-1' })).toBe(
      'window-change',
    );
    expect(retentionEventForCommand({ type: 'set-observation-enabled', enabled: false })).toBe(
      'observation-disabled',
    );
    expect(retentionEventForCommand({ type: 'set-observation-enabled', enabled: true })).toBeNull();
    expect(retentionEventForCommand({ type: 'resume' })).toBeNull();
    expect(retentionEventForCommand({ type: 'submit-text', text: 'hello' })).toBeNull();
  });
});
