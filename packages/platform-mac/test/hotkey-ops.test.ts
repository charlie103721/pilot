import { describe, expect, it } from 'vitest';
import { HOTKEY_MODIFIERS } from '@pilot/platform';
import {
  HELPER_OPERATIONS,
  HELPER_OPERATION_NAMES,
  HELPER_PROTOCOL_VERSION,
  HOTKEY_EVENT_NAMES,
  HOTKEY_KEY_EVENT,
  HOTKEY_TAP_EVENT,
  hotkeyKeyEventSchema,
  hotkeyStartOperation,
  hotkeyStatusOperation,
  hotkeyStopOperation,
  hotkeyTapEventSchema,
  nativeHotkeyStatusSchema,
} from '@pilot/platform-mac';

/**
 * The PR-015 wire shapes.
 *
 * The schema tests are not ceremony: `strictObject` is one of the layers that
 * keeps a keyboard tap from becoming a keylogger. A helper that attached a
 * character, a second key code or a modifier-flag dump to a hotkey event would
 * fail validation on the host and be reported as a protocol error, rather than
 * being read, logged or forwarded. These tests pin that.
 */

const validStatus = {
  binding: { keyCode: 61, label: 'Right Option', isModifierKey: true, requiredModifiers: [] },
  tap: 'active',
  accessibilityTrusted: true,
  held: false,
  detail: '',
  counters: {
    emitted: 2,
    suppressed: 9,
    disabledByTimeout: 0,
    disabledByUserInput: 0,
    reEnabled: 0,
  },
};

const validKeyEvent = {
  phase: 'down',
  keyCode: 61,
  at: 1_760_000_000_000,
  sequence: 7,
  autorepeat: false,
};

describe('hotkey operations', () => {
  it('appends to the operation set without bumping the protocol version', () => {
    // Appending operations is backwards compatible in both directions: an
    // unknown operation is already a typed `invalid-request` on each side.
    expect(HELPER_PROTOCOL_VERSION).toBe(1);
    expect(HELPER_OPERATION_NAMES).toEqual(
      expect.arrayContaining(['hotkey.start', 'hotkey.stop', 'hotkey.status']),
    );
    expect(HELPER_OPERATIONS.hotkeyStart).toBe(hotkeyStartOperation);
    expect(HELPER_OPERATIONS.hotkeyStop).toBe(hotkeyStopOperation);
    expect(HELPER_OPERATIONS.hotkeyStatus).toBe(hotkeyStatusOperation);
  });

  it('carries no binary payload in either direction', () => {
    for (const operation of [hotkeyStartOperation, hotkeyStopOperation, hotkeyStatusOperation]) {
      expect(operation.requestBinary, operation.name).toBe(false);
      expect(operation.responseBinary, operation.name).toBe(false);
    }
  });

  it('names its two events', () => {
    expect(HOTKEY_EVENT_NAMES).toEqual([HOTKEY_KEY_EVENT, HOTKEY_TAP_EVENT]);
    expect(HOTKEY_KEY_EVENT).toBe('hotkey.key');
    expect(HOTKEY_TAP_EVENT).toBe('hotkey.tap');
  });

  it('requires a well-formed binding to start', () => {
    expect(hotkeyStartOperation.request.safeParse({ binding: validStatus.binding }).success).toBe(
      true,
    );
    expect(hotkeyStartOperation.request.safeParse({}).success).toBe(false);
    expect(
      hotkeyStartOperation.request.safeParse({ binding: { keyCode: 61, label: 'Right Option' } })
        .success,
    ).toBe(false);
    expect(
      hotkeyStartOperation.request.safeParse({
        binding: { ...validStatus.binding, requiredModifiers: ['hyper'] },
      }).success,
    ).toBe(false);
    expect(
      hotkeyStartOperation.request.safeParse({
        binding: { ...validStatus.binding, requiredModifiers: [...HOTKEY_MODIFIERS] },
      }).success,
    ).toBe(true);
  });
});

describe('the hotkey key event schema', () => {
  it('accepts exactly the five permitted fields', () => {
    const parsed = hotkeyKeyEventSchema.safeParse(validKeyEvent);
    expect(parsed.success).toBe(true);
  });

  it('rejects a payload carrying anything the tap was never allowed to send', () => {
    for (const extra of [
      { characters: 'p' },
      { unicode: 112 },
      { otherKeyCode: 8 },
      { flags: 0x0008_0000 },
      { modifiers: ['command'] },
      { window: 'Bank of Somewhere — Sign in' },
    ]) {
      const parsed = hotkeyKeyEventSchema.safeParse({ ...validKeyEvent, ...extra });
      expect(parsed.success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('rejects a phase it does not know', () => {
    expect(hotkeyKeyEventSchema.safeParse({ ...validKeyEvent, phase: 'repeat' }).success).toBe(
      false,
    );
  });

  it('requires the repeat flag rather than defaulting it', () => {
    const { autorepeat: _autorepeat, ...withoutFlag } = validKeyEvent;
    expect(hotkeyKeyEventSchema.safeParse(withoutFlag).success).toBe(false);
  });
});

describe('the hotkey status schema', () => {
  it('accepts every tap state the helper can report', () => {
    for (const tap of [
      'active',
      'stopped',
      'accessibility-denied',
      'creation-failed',
      'disabled',
    ]) {
      expect(nativeHotkeyStatusSchema.safeParse({ ...validStatus, tap }).success, tap).toBe(true);
    }
    expect(nativeHotkeyStatusSchema.safeParse({ ...validStatus, tap: 'weird' }).success).toBe(
      false,
    );
  });

  it('bounds the diagnostic detail so it cannot become a channel', () => {
    expect(
      nativeHotkeyStatusSchema.safeParse({ ...validStatus, detail: 'x'.repeat(200) }).success,
    ).toBe(true);
    expect(
      nativeHotkeyStatusSchema.safeParse({ ...validStatus, detail: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  it('validates the tap event envelope', () => {
    expect(
      hotkeyTapEventSchema.safeParse({ change: 'disabled-by-timeout', status: validStatus })
        .success,
    ).toBe(true);
    expect(
      hotkeyTapEventSchema.safeParse({ change: 'gremlins', status: validStatus }).success,
    ).toBe(false);
    expect(hotkeyTapEventSchema.safeParse({ change: 'started' }).success).toBe(false);
  });
});
