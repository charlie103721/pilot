import type { PermissionKind } from '@pilot/shared';
import type { Subscribe } from './common.js';

/**
 * Global push-to-talk hotkey (PR-015).
 *
 * A **new file rather than an addition to `adapters.ts`**, deliberately: three
 * sibling PRs are editing that file's neighbourhood at the same time, and a new
 * module is the one shape of contract change that cannot produce a semantic
 * merge conflict. `PlatformAdapter` is *not* extended for the same reason —
 * every implementer of the composite would have to grow a member, which is not
 * an additive change. PR-032 injects a `HotkeyAdapter` alongside the platform
 * adapter instead.
 *
 * ## What this contract is for
 *
 * `docs/product-spec.md` FR-11 and `docs/mvp-01-point-ask-hear.md` §"Push-to-
 * talk shortcut works while Pilot is not focused" ask for one thing that an
 * in-window key handler cannot give: the key must be heard while some *other*
 * application has focus. On macOS that means a `CGEventTap`, which needs a
 * permission, can be switched off by the system, and — if written carelessly —
 * sees every keystroke on the machine. All three facts are visible in this
 * contract rather than buried in the implementation:
 *
 * - **Permission**: `HotkeyAvailability` names the permission that is missing,
 *   so the shell can route the user to the right System Settings pane
 *   (system-design §16) instead of showing a dead shortcut.
 * - **Revocable at run time**: availability is an *event*, not just a
 *   constructor result. A tap that the system disables mid-session moves the
 *   adapter out of `active` and says so.
 * - **Narrowness**: the event union carries a phase, a timestamp and the
 *   configured binding. There is no field in which another keystroke could
 *   travel, by construction.
 *
 * ## The one invariant a consumer may rely on
 *
 * **Every `hotkey-down` is followed by exactly one `hotkey-up`.** If the key is
 * physically held when the tap dies, the permission is revoked, the helper
 * crashes or the adapter is disposed, the implementation synthesises the
 * release and marks it `synthetic: true`. Without that guarantee the
 * interaction machine would sit in `listening` forever with the microphone
 * open, which is the worst failure this feature has.
 */

export const HOTKEY_MODIFIERS = ['command', 'option', 'control', 'shift', 'fn'] as const;

export type HotkeyModifier = (typeof HOTKEY_MODIFIERS)[number];

/**
 * One configured shortcut.
 *
 * `keyCode` is a **platform-defined virtual key code** — `kVK_*` on macOS, a
 * `VK_*` value on Windows. It is deliberately opaque here: the mapping from
 * code to physical key belongs to the platform package, and no cross-platform
 * abstraction of it would survive contact with either keyboard layout system.
 * `label` is what the user is shown, so a platform that knows a nicer name for
 * the key supplies it.
 */
export interface HotkeyBinding {
  readonly keyCode: number;
  /** Human-readable name of the key, e.g. `"Right Option"`. */
  readonly label: string;
  /**
   * True when `keyCode` names a modifier key (Option, Control, …). Modifier
   * keys do not auto-repeat and are reported through a different event type by
   * most platforms, so the distinction has to be carried, not guessed.
   */
  readonly isModifierKey: boolean;
  /**
   * Modifiers that must additionally be held for the shortcut to fire. Empty
   * for the default binding: push-to-talk is held down for the length of a
   * sentence, and a two-handed chord is a poor shape for that.
   */
  readonly requiredModifiers: readonly HotkeyModifier[];
}

/**
 * Right Option, held.
 *
 * `docs/implementation.md` PR-015 fixes the default. It is a good one: it is a
 * modifier, so it never auto-repeats and never inserts a character; it is
 * unused by nearly every application (unlike Left Option, which types accented
 * characters on US layouts and is a live dead-key modifier on many others);
 * and it is reachable with the hand that is not holding the pointer.
 */
export const DEFAULT_PUSH_TO_TALK_BINDING: HotkeyBinding = {
  // kVK_RightOption
  keyCode: 61,
  label: 'Right Option',
  isModifierKey: true,
  requiredModifiers: [],
};

/**
 * Why the shortcut is not listening.
 *
 * Each of these needs different words in the UI, so none of them collapses
 * into a generic "unavailable" — the same rule the four permission states
 * follow in `@pilot/shared`.
 */
export const HOTKEY_UNAVAILABLE_REASONS = [
  /** The permission a global key listener needs has not been granted. */
  'permission-missing',
  /** The permission is present but the platform refused to create the listener. */
  'listener-rejected',
  /** The system switched a working listener off and it could not be restored. */
  'listener-disabled',
  /** The native helper process is not reachable. */
  'helper-unavailable',
  /** This platform has no global hotkey mechanism at all. */
  'unsupported',
] as const;

export type HotkeyUnavailableReason = (typeof HOTKEY_UNAVAILABLE_REASONS)[number];

export type HotkeyAvailability =
  /** Listening. Key events will arrive whatever application has focus. */
  | { readonly status: 'active' }
  /** Not listening because nobody asked it to. Not a failure. */
  | { readonly status: 'stopped' }
  | {
      readonly status: 'unavailable';
      readonly reason: HotkeyUnavailableReason;
      /** The permission to request, when `reason` is `permission-missing`. */
      readonly permission?: PermissionKind;
      /** Stable diagnostic text. Never key data; safe to log. */
      readonly detail: string;
    };

/** Counts only. No key data is ever counted per-key except the bound one. */
export interface HotkeyCounters {
  readonly downs: number;
  readonly ups: number;
  /** Repeats and duplicate presses that were folded into one press. */
  readonly suppressed: number;
  /** Releases Pilot generated because the real one could not arrive. */
  readonly synthetic: number;
  /** Times the system switched the listener off. */
  readonly listenerDisabled: number;
  /** Times Pilot switched it back on. */
  readonly listenerRestored: number;
}

export interface HotkeyStatus {
  readonly binding: HotkeyBinding;
  readonly availability: HotkeyAvailability;
  /** Whether the machine should currently consider the key held. */
  readonly held: boolean;
  readonly counters: HotkeyCounters;
}

/** Why Pilot generated a release the user did not perform. */
export const HOTKEY_SYNTHETIC_RELEASE_REASONS = [
  /** The listener was switched off or destroyed while the key was down. */
  'listener-lost',
  /** The helper process went away while the key was down. */
  'helper-lost',
  /** The listener was stopped, or the adapter disposed, while the key was down. */
  'stopped',
  /**
   * No release arrived within the maximum hold. macOS can genuinely lose a
   * modifier key-up across a Space switch or a Mission Control activation.
   */
  'held-too-long',
] as const;

export type HotkeySyntheticReleaseReason = (typeof HOTKEY_SYNTHETIC_RELEASE_REASONS)[number];

export type HotkeyEvent =
  | {
      readonly type: 'hotkey-down';
      readonly binding: HotkeyBinding;
      readonly at: number;
      /** Monotonic press counter. Pairs a down with its up. */
      readonly sequence: number;
    }
  | {
      readonly type: 'hotkey-up';
      readonly binding: HotkeyBinding;
      readonly at: number;
      readonly sequence: number;
      readonly heldMs: number;
      /** True when Pilot generated this release rather than the user. */
      readonly synthetic: boolean;
      /** Present only when `synthetic` is true. */
      readonly reason?: HotkeySyntheticReleaseReason;
    }
  | {
      readonly type: 'hotkey-availability-changed';
      readonly availability: HotkeyAvailability;
      readonly binding: HotkeyBinding;
      readonly at: number;
    };

export interface HotkeyAdapter {
  /** Current binding, availability, held state and counters. */
  status(): Promise<HotkeyStatus>;
  /**
   * Begins listening, optionally rebinding first.
   *
   * **Does not throw when the permission is missing.** An unavailable hotkey is
   * a state the product has to render, not an exception — system-design §16
   * requires that the user always keeps a way to ask a question, so this
   * resolves with a `HotkeyStatus` whose availability explains the problem and
   * the shell keeps its typed fallback. It throws only when the request could
   * not be made at all (the helper is unreachable).
   */
  start(binding?: HotkeyBinding): Promise<HotkeyStatus>;
  /** Stops listening. Releases a held key first. */
  stop(): Promise<HotkeyStatus>;
  subscribe: Subscribe<HotkeyEvent>;
}

export function isHotkeyUsable(availability: HotkeyAvailability): boolean {
  return availability.status === 'active';
}

/**
 * The permission the user must grant to make this availability usable, or
 * `null` when granting a permission would not help.
 */
export function hotkeyBlockingPermission(availability: HotkeyAvailability): PermissionKind | null {
  if (availability.status !== 'unavailable') {
    return null;
  }
  return availability.permission ?? null;
}

/**
 * One sentence for the user.
 *
 * Kept beside the type so every shell says the same thing, and so the wording
 * cannot drift away from the reason codes it describes. Each line states what
 * is wrong *and* that typing still works — `docs/system-design.md` §16 never
 * permits a state in which the user has no way to ask.
 */
export function hotkeyUnavailableMessage(availability: HotkeyAvailability): string | null {
  if (availability.status === 'active') {
    return null;
  }
  if (availability.status === 'stopped') {
    return 'The push-to-talk shortcut is switched off. You can still type your question.';
  }
  switch (availability.reason) {
    case 'permission-missing':
      return (
        'Pilot needs Accessibility permission to hear the push-to-talk shortcut while ' +
        'another app is in front. Until then, type your question instead.'
      );
    case 'listener-rejected':
      return (
        'macOS refused to let Pilot listen for the push-to-talk shortcut. ' +
        'Type your question instead, and check Privacy & Security settings.'
      );
    case 'listener-disabled':
      return (
        'macOS switched off Pilot’s push-to-talk shortcut and it could not be restarted. ' +
        'Type your question, or quit and reopen Pilot.'
      );
    case 'helper-unavailable':
      return (
        'Pilot cannot reach its macOS helper, so the push-to-talk shortcut is not active. ' +
        'You can still type your question.'
      );
    case 'unsupported':
      return 'This system has no global shortcut support. Type your question instead.';
  }
}
