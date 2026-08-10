import { PERMISSION_KINDS, type PermissionKind } from '@pilot/shared';

/**
 * What each permission is *for*, in product terms.
 *
 * Everything user-visible about a permission lives here, in one table, so the
 * renderer contains no prose and a reviewer can read the whole onboarding story
 * without opening a component. Two rules govern the copy:
 *
 *  1. No API names. The user is told what Pilot can and cannot do for them, not
 *     which framework returned which status. "Pilot cannot see anything" — not
 *     "ScreenCaptureKit is unavailable".
 *  2. The consequence of *not* granting is stated, per permission, and the
 *     consequences are not the same (system-design §16). Screen Recording
 *     denied is a hard stop; Accessibility denied is a working but less
 *     accurate Pilot; microphone and speech recognition denied close the voice
 *     path only. Collapsing those into one "permissions missing" screen is the
 *     specific failure this table exists to prevent.
 */

/**
 * How much of Pilot survives when a permission is missing.
 *
 *  - `blocks`   — the core capability is gone. Pilot cannot do its job at all.
 *  - `degrades` — Pilot still answers, but with weaker grounding, and it must
 *                 say so (system-design §16: "disclose reduced grounding").
 *  - `limits`   — one way of using Pilot is unavailable; everything Pilot does
 *                 say is exactly as trustworthy as before.
 */
export const PERMISSION_CONSEQUENCES = ['blocks', 'degrades', 'limits'] as const;

export type PermissionConsequence = (typeof PERMISSION_CONSEQUENCES)[number];

export interface PermissionCopy {
  readonly kind: PermissionKind;
  /** Name as macOS shows it, so the System Settings row is findable. */
  readonly title: string;
  /** Why Pilot needs it, in terms of what the user gets. */
  readonly why: string;
  /** The privacy bound Pilot holds itself to for this permission. */
  readonly bound: string;
  readonly consequence: PermissionConsequence;
  /** What is true *right now* while this permission is missing. */
  readonly whenMissing: string;
  /** Where the user grants it by hand. Shown even where Pilot cannot open it. */
  readonly settingsPane: string;
}

const COPY: Readonly<Record<PermissionKind, PermissionCopy>> = {
  'screen-recording': {
    kind: 'screen-recording',
    title: 'Screen Recording',
    why: 'Lets Pilot look at the one window you choose, so you can point at something on it and ask what it does.',
    bound:
      'Pilot captures only the window you select. It never widens to the whole screen, and it stops capturing the moment you pause it or that window closes.',
    consequence: 'blocks',
    whenMissing:
      'Pilot cannot see anything. Choosing a window and asking about what is on it are unavailable until you allow this.',
    settingsPane: 'System Settings › Privacy & Security › Screen Recording',
  },
  accessibility: {
    kind: 'accessibility',
    title: 'Accessibility',
    why: 'Lets Pilot read the name and value of the control your pointer is over, so "what does this do?" resolves to the actual button rather than to a guess about pixels.',
    bound:
      'Pilot reads the element under your pointer inside the selected window. It never types, clicks or controls anything on your behalf.',
    consequence: 'degrades',
    whenMissing:
      'Pilot keeps working, using the pointer position on the captured image alone. Answers about the exact control under your pointer will be less reliable, and Pilot says so when it answers.',
    settingsPane: 'System Settings › Privacy & Security › Accessibility',
  },
  microphone: {
    kind: 'microphone',
    title: 'Microphone',
    why: 'Lets you hold the push-to-talk key and ask out loud instead of stopping to type.',
    bound:
      'Pilot listens only while you hold the key, and the audio is discarded as soon as your question has been transcribed.',
    consequence: 'limits',
    whenMissing:
      'Spoken questions are unavailable. You can still type questions to Pilot and get the same answers.',
    settingsPane: 'System Settings › Privacy & Security › Microphone',
  },
  'speech-recognition': {
    kind: 'speech-recognition',
    title: 'Speech Recognition',
    why: 'Turns what you said into text on this Mac, so a spoken question never has to leave the machine to be understood.',
    bound:
      'Pilot asks for on-device recognition. If this Mac can only recognise speech by sending audio away, Pilot refuses and asks you to type instead.',
    consequence: 'limits',
    whenMissing:
      'Pilot can hear you but cannot turn speech into words, so spoken questions are unavailable. Typed questions still work.',
    settingsPane: 'System Settings › Privacy & Security › Speech Recognition',
  },
};

/**
 * Display order: the hard stop first, then grounding quality, then the voice
 * pair. A user who fixes them top to bottom gets a working Pilot soonest.
 */
export const PERMISSION_ORDER: readonly PermissionKind[] = [
  'screen-recording',
  'accessibility',
  'microphone',
  'speech-recognition',
];

export const PERMISSION_COPY: Readonly<Record<PermissionKind, PermissionCopy>> = COPY;

export function permissionCopy(kind: PermissionKind): PermissionCopy {
  return COPY[kind];
}

/** Guards the two tables above against a new kind arriving in the contract. */
export function assertCatalogueIsComplete(): void {
  for (const kind of PERMISSION_KINDS) {
    if (COPY[kind] === undefined || !PERMISSION_ORDER.includes(kind)) {
      throw new Error(`permission catalogue is missing "${kind}"`);
    }
  }
}
