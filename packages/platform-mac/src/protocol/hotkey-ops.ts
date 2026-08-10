import { HOTKEY_MODIFIERS } from '@pilot/platform';
import { z } from 'zod';
import { defineHelperOperation } from './operation-kit.js';

/**
 * Global push-to-talk operations (PR-015).
 *
 * Appended to the closed operation set PR-003 established, in a module of its
 * own following PR-011's `permission-ops.ts` / `window-ops.ts` split. Nothing
 * here bumps `HELPER_PROTOCOL_VERSION`: adding operations is backwards
 * compatible in both directions.
 *
 * ## Why this is the one subsystem the helper *pushes*
 *
 * PR-011 chose snapshot-and-diff over helper-side events for windows, and gave
 * the reason: a background thread writing frames concurrently with the request
 * loop is a write lock and a second failure surface, in Swift that cannot be
 * compiled here. That trade was right for windows, where the cost of polling is
 * a second of latency on a lifecycle notice.
 *
 * It is wrong here. Push-to-talk latency is the latency of the product: the key
 * going down is what stops speech (system-design §15, "starting a new utterance
 * stops TTS immediately") against a 300 ms budget (§17), and a poll interval
 * short enough to meet that would be forty round trips a second, forever,
 * whether or not anyone touches the key. So the hotkey — and only the hotkey —
 * travels as an unsolicited event, and the Swift side pays for a serialised
 * frame writer.
 *
 * ## The payload is narrow on purpose
 *
 * A `CGEventTap` on the keyboard sees every keystroke on the machine. The
 * defence against that becoming a keylogger is layered, and this schema is one
 * of the layers: {@link hotkeyKeyEventSchema} is a `strictObject` with no field
 * that could carry a character, a keystroke that is not the configured one, or
 * a modifier-flag dump. A helper that tried to attach one would fail host-side
 * validation and be reported as a protocol error, not logged. The other layers
 * are in `native/Sources/PilotHelperCore/HotkeyTap.swift` (the callback returns
 * before reading anything from a non-matching event) and in
 * `src/hotkey/mac-hotkey-adapter.ts` (which logs phases and counts, never
 * codes it was not configured with).
 */

/** How the native listener is doing. One value per distinguishable cause. */
export const NATIVE_HOTKEY_TAP_STATES = [
  /** The tap exists, is enabled, and its run loop is running. */
  'active',
  /** No tap. Nobody has asked for one, or it was stopped. */
  'stopped',
  /** `AXIsProcessTrusted()` is false: a keyboard tap cannot be created. */
  'accessibility-denied',
  /**
   * `CGEventTapCreate` returned null although Accessibility is granted. On
   * macOS 10.15+ this is most often Input Monitoring, which is a separate TCC
   * service that Pilot does not model — see the README.
   */
  'creation-failed',
  /** The system switched the tap off and the re-enable budget is spent. */
  'disabled',
] as const;

export type NativeHotkeyTapState = (typeof NATIVE_HOTKEY_TAP_STATES)[number];

/** Why the helper emitted a `hotkey.tap` event. */
export const NATIVE_HOTKEY_TAP_CHANGES = [
  'started',
  'stopped',
  /** `kCGEventTapDisabledByTimeout` — the callback took too long. */
  'disabled-by-timeout',
  /** `kCGEventTapDisabledByUserInput` — the system switched user-input taps off. */
  'disabled-by-user-input',
  /** `CGEvent.tapEnable(tap:enable:true)` was called and the tap is listening again. */
  're-enabled',
  /** The tap could not be created or could not be restored. */
  'failed',
] as const;

export type NativeHotkeyTapChange = (typeof NATIVE_HOTKEY_TAP_CHANGES)[number];

export const nativeHotkeyBindingSchema = z.strictObject({
  /** macOS virtual key code (`kVK_*`). */
  keyCode: z.number().int().min(0).max(0xffff),
  label: z.string().min(1).max(64),
  isModifierKey: z.boolean(),
  requiredModifiers: z.array(z.enum(HOTKEY_MODIFIERS)).max(HOTKEY_MODIFIERS.length),
});

export type NativeHotkeyBinding = z.infer<typeof nativeHotkeyBindingSchema>;

export const nativeHotkeyCountersSchema = z.strictObject({
  /** Matching transitions the tap forwarded. */
  emitted: z.number().int().nonnegative(),
  /** Auto-repeat and duplicate-phase events the tap dropped before sending. */
  suppressed: z.number().int().nonnegative(),
  disabledByTimeout: z.number().int().nonnegative(),
  disabledByUserInput: z.number().int().nonnegative(),
  reEnabled: z.number().int().nonnegative(),
});

export type NativeHotkeyCounters = z.infer<typeof nativeHotkeyCountersSchema>;

export const nativeHotkeyStatusSchema = z.strictObject({
  binding: nativeHotkeyBindingSchema,
  tap: z.enum(NATIVE_HOTKEY_TAP_STATES),
  /** `AXIsProcessTrusted()` at the moment the status was taken. */
  accessibilityTrusted: z.boolean(),
  /** Whether the tap believes the key is currently down. */
  held: z.boolean(),
  /** Stable diagnostic text. Never key data. */
  detail: z.string().max(200),
  counters: nativeHotkeyCountersSchema,
});

export type NativeHotkeyStatus = z.infer<typeof nativeHotkeyStatusSchema>;

/**
 * Installs (or replaces) the event tap for one binding.
 *
 * **Never fails because a permission is missing.** A missing Accessibility
 * grant comes back as `tap: 'accessibility-denied'` in the status, so the host
 * can render system-design §16's fallback rather than treating a routine,
 * user-fixable condition as an exception.
 */
export const hotkeyStartOperation = defineHelperOperation({
  name: 'hotkey.start',
  request: z.strictObject({ binding: nativeHotkeyBindingSchema }),
  response: z.strictObject({ status: nativeHotkeyStatusSchema }),
  requestBinary: false,
  responseBinary: false,
});

/** Removes the tap and stops its run loop. Idempotent. */
export const hotkeyStopOperation = defineHelperOperation({
  name: 'hotkey.stop',
  request: z.strictObject({}),
  response: z.strictObject({ status: nativeHotkeyStatusSchema }),
  requestBinary: false,
  responseBinary: false,
});

/** Reads the tap state without changing it. Also re-probes Accessibility. */
export const hotkeyStatusOperation = defineHelperOperation({
  name: 'hotkey.status',
  request: z.strictObject({}),
  response: z.strictObject({ status: nativeHotkeyStatusSchema }),
  requestBinary: false,
  responseBinary: false,
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Emitted for a transition of the configured key, and for nothing else. */
export const HOTKEY_KEY_EVENT = 'hotkey.key';

export const hotkeyKeyEventSchema = z.strictObject({
  phase: z.enum(['down', 'up']),
  /**
   * Echo of the configured `keyCode`. Present so a stale event from a previous
   * binding can be recognised and dropped — never so that an arbitrary key can
   * be reported. The adapter discards any value it did not configure.
   */
  keyCode: z.number().int().min(0).max(0xffff),
  /** Helper clock reading, ms since epoch. Diagnostics only. */
  at: z.number().int().nonnegative(),
  /** Helper-side counter, so a dropped event is visible as a gap. */
  sequence: z.number().int().nonnegative(),
  /**
   * True when the platform marked this a key repeat. The helper already drops
   * these; the flag exists so the host can count what a misbehaving helper
   * would have sent, and so the host coalescer is provably independent of it.
   */
  autorepeat: z.boolean(),
});

export type HotkeyKeyEvent = z.infer<typeof hotkeyKeyEventSchema>;

/** Emitted whenever the tap's own state changes, including its recoveries. */
export const HOTKEY_TAP_EVENT = 'hotkey.tap';

export const hotkeyTapEventSchema = z.strictObject({
  change: z.enum(NATIVE_HOTKEY_TAP_CHANGES),
  status: nativeHotkeyStatusSchema,
});

export type HotkeyTapEvent = z.infer<typeof hotkeyTapEventSchema>;

export const HOTKEY_EVENT_NAMES: readonly string[] = [HOTKEY_KEY_EVENT, HOTKEY_TAP_EVENT];
