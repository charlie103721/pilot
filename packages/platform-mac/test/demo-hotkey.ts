/**
 * PR-015 demo: the global push-to-talk hotkey.
 *
 * ```sh
 * pnpm build                                              # runs against dist/
 * pnpm --filter @pilot/platform-mac demo:hotkey           # Node stub (Linux and macOS)
 * PILOT_HELPER_BINARY=… pnpm --filter @pilot/platform-mac demo:hotkey   # Swift helper (macOS)
 * ```
 *
 * **What implementation.md asks for, and what this is.** The stated demo is
 * "observe reliable press/release events while Pilot is not focused". That
 * needs macOS, a compiled Swift helper, an Accessibility grant and a keyboard,
 * and none of the four exists on the development machine (runbook amendment 8).
 * **It has not been run.**
 *
 * What runs here instead is the entire host half against a Node stub that
 * speaks the same framed protocol and plays a scripted tap — including the
 * misbehaviours a real one produces. Every section below is a failure mode the
 * feature has to survive, and the stub deliberately does *not* coalesce, so
 * what you are watching is Pilot's own rules rather than a well-behaved helper.
 *
 * On a Mac with the helper built, the same command drives the real
 * `CGEventTap`, and section 1 becomes the demo implementation.md describes.
 * Like the PR-003 and PR-011 demos, the first line says which of the two ran.
 */

import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PUSH_TO_TALK_BINDING,
  hotkeyBlockingPermission,
  hotkeyUnavailableMessage,
  isHotkeyUsable,
  type HotkeyEvent,
} from '@pilot/platform';
import { isTextFallbackAvailable } from '@pilot/interaction';
import {
  MacHotkeyAdapter,
  NativeHelperTransport,
  helperBinaryCandidates,
  resolveHelperBinary,
  type HelperTransportOptions,
} from '@pilot/platform-mac';

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const STUB_PATH = fileURLToPath(new URL('./support/helper-stub.ts', import.meta.url));

interface Target {
  readonly label: string;
  readonly usingStub: boolean;
  readonly options: HelperTransportOptions;
}

function chooseTarget(stub: Record<string, unknown>): Target {
  try {
    const binary = resolveHelperBinary();
    return {
      label: `Swift helper (${binary.source}: ${binary.path}) — a real CGEventTap`,
      usingStub: false,
      options: { command: binary.path },
    };
  } catch {
    return {
      label: 'Node stub (no Swift helper built; see the README for the Mac steps)',
      usingStub: true,
      options: {
        command: process.execPath,
        args: [STUB_PATH],
        env: { ...process.env, PILOT_HELPER_STUB: JSON.stringify(stub) },
      },
    };
  }
}

function describe(event: HotkeyEvent): string {
  switch (event.type) {
    case 'hotkey-down':
      return `hotkey-down    #${String(event.sequence)}  ${event.binding.label}`;
    case 'hotkey-up':
      return (
        `hotkey-up      #${String(event.sequence)}  held ${String(event.heldMs)}ms` +
        (event.synthetic ? `  SYNTHETIC (${String(event.reason)})` : '')
      );
    case 'hotkey-availability-changed': {
      const availability = event.availability;
      const suffix =
        availability.status === 'unavailable'
          ? `${availability.reason} — ${availability.detail}`
          : '';
      return `availability   ${availability.status}${suffix === '' ? '' : `  ${suffix}`}`;
    }
  }
}

/** Runs one scripted scenario end to end and prints everything it emitted. */
async function scenario(
  title: string,
  stub: Record<string, unknown>,
  run: (adapter: MacHotkeyAdapter) => Promise<void>,
): Promise<void> {
  say(`\n${title}`);
  const target = chooseTarget(stub);
  const transport = new NativeHelperTransport({ ...target.options, restart: { enabled: false } });
  await transport.start();
  let clock = 0;
  const adapter = new MacHotkeyAdapter({
    transport,
    clock: () => clock,
    holdWatchdogIntervalMs: 600_000,
  });
  const events: HotkeyEvent[] = [];
  adapter.subscribe((event) => {
    events.push(event);
    say(`   ${describe(event)}`);
  });
  // A deterministic clock that advances a little on every emitted event, so the
  // printed hold times are stable across runs and machines.
  adapter.subscribe(() => {
    clock += 120;
  });

  try {
    await run(adapter);
  } finally {
    adapter.dispose();
    await transport.stop();
  }

  const presses = events.filter((event) => event.type === 'hotkey-down').length;
  const releases = events.filter((event) => event.type === 'hotkey-up').length;
  say(`   → ${String(presses)} press(es), ${String(releases)} release(s)`);
}

/** Waits for the collected event log to satisfy a predicate. */
function settle(ms = 120): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const probe = chooseTarget({});
  say(`helper target: ${probe.label}`);
  if (probe.usingStub) {
    say(
      `searched: ${helperBinaryCandidates()
        .map((candidate) => candidate.path)
        .join(', ')}`,
    );
    say('NOTE: nothing under native/ has ever been compiled, and no key has ever been pressed.');
    say('      This is the host half against a scripted tap.');
  }

  say(
    `\ndefault binding: ${DEFAULT_PUSH_TO_TALK_BINDING.label} ` +
      `(keyCode ${String(DEFAULT_PUSH_TO_TALK_BINDING.keyCode)}, modifier key, no chord)`,
  );

  await scenario(
    '1. a normal press: hold, speak, release',
    { hotkeyScript: [{ key: 'down' }, { key: 'up' }] },
    async (adapter) => {
      await adapter.start();
      await settle();
    },
  );

  await scenario(
    '2. key repeat — 24 auto-repeats inside one press',
    {
      hotkeyScript: [
        { key: 'down' },
        ...Array.from({ length: 24 }, () => ({ key: 'down', autorepeat: true })),
        { key: 'up' },
      ],
    },
    async (adapter) => {
      await adapter.start();
      await settle();
      const status = await adapter.status();
      say(
        `   coalesced: ${String(status.counters.suppressed)} transitions folded away ` +
          `(the state machine would have refused each one as illegal-transition)`,
      );
    },
  );

  await scenario(
    '3. macOS disables the tap, then Pilot re-enables it',
    {
      hotkeyScript: [
        { tap: 'disabled-by-timeout' },
        { tap: 're-enabled' },
        { key: 'down' },
        { key: 'up' },
      ],
    },
    async (adapter) => {
      await adapter.start();
      await settle();
      const status = await adapter.status();
      say(
        `   disabled ${String(status.counters.listenerDisabled)}×, ` +
          `restored ${String(status.counters.listenerRestored)}×, now ${status.availability.status}`,
      );
    },
  );

  await scenario(
    '4. the key is held when the tap dies — the release Pilot has to invent',
    { hotkeyScript: [{ key: 'down' }, { tap: 'disabled-by-user-input' }] },
    async (adapter) => {
      await adapter.start();
      await settle();
      say('   without this the machine sits in `listening` with the microphone open');
    },
  );

  await scenario(
    '5. the tap cannot be restored — a typed, loud failure',
    { hotkeyScript: [{ tap: 'disabled-by-timeout' }, { tap: 'failed' }] },
    async (adapter) => {
      await adapter.start();
      await settle();
      const status = await adapter.status();
      say(`   user sees: ${String(hotkeyUnavailableMessage(status.availability))}`);
    },
  );

  await scenario(
    '6. Accessibility is not granted (system-design §16)',
    { hotkeyAccessibility: false },
    async (adapter) => {
      const status = await adapter.start();
      say(
        `   start() resolved — it did not throw. usable=${String(isHotkeyUsable(status.availability))}`,
      );
      say(`   permission to request: ${String(hotkeyBlockingPermission(status.availability))}`);
      say(`   user sees: ${String(hotkeyUnavailableMessage(status.availability))}`);
      say('   and the in-panel typed fallback stays reachable (PR-025):');
      for (const state of ['idle', 'observing', 'error'] as const) {
        say(
          `      isTextFallbackAvailable("${state}") = ${String(isTextFallbackAvailable(state))}`,
        );
      }
    },
  );

  await scenario(
    '7. Accessibility granted and macOS still refuses the tap',
    { hotkeyTapFails: true },
    async (adapter) => {
      const status = await adapter.start();
      say(`   reason: ${JSON.stringify(status.availability)}`);
      say('   reported apart from a permission problem, because granting one would not help');
    },
  );

  await scenario(
    '8. a rebound hotkey — F13 with Control, and the old key ignored',
    {
      hotkeyScripts: [[], [{ key: 'down', keyCode: 61 }, { key: 'down' }, { key: 'up' }]],
    },
    async (adapter) => {
      await adapter.start();
      const status = await adapter.start({
        keyCode: 105,
        label: 'F13',
        isModifierKey: false,
        requiredModifiers: ['control'],
      });
      say(`   bound to ${status.binding.label} + ${status.binding.requiredModifiers.join('+')}`);
      await settle();
      say(
        `   reports about the old key discarded: ${String(adapter.discardedForeignKeyEvents)} ` +
          `(nothing about a key Pilot did not bind is read, logged or forwarded)`,
      );
    },
  );

  say('\n9. the stuck-key watchdog (macOS can lose a modifier key-up across a Space switch)');
  {
    const target = chooseTarget({ hotkeyScript: [{ key: 'down' }] });
    const transport = new NativeHelperTransport({ ...target.options, restart: { enabled: false } });
    await transport.start();
    let clock = 0;
    const adapter = new MacHotkeyAdapter({
      transport,
      clock: () => clock,
      maxHoldMs: 30_000,
      holdWatchdogIntervalMs: 600_000,
    });
    adapter.subscribe((event) => {
      say(`   ${describe(event)}`);
    });
    await adapter.start();
    await settle();
    clock = 29_999;
    adapter.sweep();
    say('   at 29 999 ms: still held, nothing emitted');
    clock = 30_000;
    adapter.sweep();
    adapter.dispose();
    await transport.stop();
  }

  say('\nNot demonstrated here — none of it can be (runbook amendment 8):');
  say('  · nothing under native/ has ever been compiled;');
  say('  · no CGEventTap has ever been created, enabled, disabled or re-enabled;');
  say('  · no key has ever been pressed, and no key event has ever been observed;');
  say('  · whether the shortcut fires while Pilot is not focused is UNVERIFIED;');
  say('  · whether Accessibility alone is enough, or macOS also demands Input Monitoring.');
  say('The Mac steps are in docs/handoff.md §1 and packages/platform-mac/README.md.');
}

main().catch((error: unknown) => {
  process.stderr.write(`demo failed: ${String(error)}\n`);
  process.exitCode = 1;
});
