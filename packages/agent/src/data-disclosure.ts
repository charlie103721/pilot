import { describeEndpoint, type ModelProfile } from '@pilot/shared';
import type { CredentialStatus } from './auth-facade.js';

/**
 * Remote-data labelling (PR-038; system-design §14, §12).
 *
 * > "Show whether the configured provider is local or remote **before
 * > observation begins**." — system-design §14
 *
 * `describeEndpoint` in `@pilot/shared` already answers the locality question
 * from the base URL, and it fails closed. What it cannot answer is the other
 * half of the sentence a user of an API-key profile needs: *whose* key is being
 * used, whether Pilot has actually verified that the model works, and where the
 * key itself lives. An unverified profile that renders identically to a verified
 * one is the "configured but not working looks like working" failure this PR is
 * explicitly told not to ship.
 *
 * ## Why this file is provider-neutral
 *
 * PR-039's local profile is the contrast case and needs the same banner with
 * the opposite verdict; PR-037's subscription profile needs it with a different
 * credential line. Nothing below knows what `anthropic`, `openai-codex` or
 * `local` mean — it reads `ModelProfile` and a {@link CredentialStatus}, both of
 * which already exist and neither of which can hold a secret. It lives in its
 * own file so all three lanes can adopt it without a three-way merge on one.
 *
 * ## Why no field here can leak
 *
 * Same argument as `CredentialStatus` (PR-020): there is no field that can hold
 * a token. Every string is built from a host name, a provider id, a model id and
 * a fixed vocabulary. {@link ModelDataDisclosure} is safe to send to the
 * renderer, safe to log and safe to put in a screenshot.
 */

/** How firmly Pilot knows this profile can do the job. */
export type ProfileVerification =
  /** A capability probe succeeded against this exact model. */
  | 'verified'
  /** Settings exist, but nothing has confirmed the model answers. */
  | 'unverified'
  /** A probe ran and refused. */
  | 'rejected';

export interface ModelDataDisclosure {
  /** The one bit a user has to act on. Fails closed via `describeEndpoint`. */
  readonly sendsScreenOffDevice: boolean;
  /** Host name, or the provider id when there is no base URL. */
  readonly destination: string;
  readonly authMode: ModelProfile['authMode'];
  readonly verification: ProfileVerification;
  /** One short line for a banner. */
  readonly headline: string;
  /** Two or three sentences for the privacy surface. */
  readonly detail: string;
  /** Where the credential lives, in words. `null` when there is no credential. */
  readonly credentialSummary: string | null;
  /**
   * True when the banner should be visually loud: screen data leaves the
   * machine, or the profile is not actually usable yet.
   */
  readonly needsAttention: boolean;
}

const AUTH_WORDS: Readonly<Record<ModelProfile['authMode'], string>> = {
  'api-key': 'your API key',
  subscription: 'your provider subscription',
  local: 'a local endpoint',
};

export interface DescribeModelDataDisclosureInput {
  readonly profile: ModelProfile;
  /** PR-020's renderer-safe credential state, or `null` when there is none. */
  readonly credential?: CredentialStatus | null;
  /**
   * Human-readable name of the secure store holding the credential, e.g.
   * `"macOS Keychain (Electron safeStorage)"`. Never a value.
   */
  readonly storageName?: string | null;
  /** Defaults to `'unverified'` — the truthful answer when nobody says. */
  readonly verification?: ProfileVerification;
}

function credentialSummaryFor(input: DescribeModelDataDisclosureInput): string | null {
  const credential = input.credential ?? null;
  if (credential === null || !credential.configured) {
    return null;
  }
  const kind = credential.kind === 'oauth' ? 'sign-in token' : 'API key';
  const where =
    input.storageName === undefined || input.storageName === null
      ? credential.source === null
        ? 'held for this session only'
        : `resolved from ${credential.source}`
      : `stored in ${input.storageName}`;
  return `Your ${kind} is ${where}. It never reaches this window, the logs, or the conversation.`;
}

export function describeModelDataDisclosure(
  input: DescribeModelDataDisclosureInput,
): ModelDataDisclosure {
  const { profile } = input;
  const endpoint = describeEndpoint(profile);
  const verification = input.verification ?? 'unverified';
  const destination = endpoint.host ?? profile.provider;
  const credentialSummary = credentialSummaryFor(input);
  const using = AUTH_WORDS[profile.authMode];

  const headline = endpoint.isRemote
    ? `Screen images are sent to ${destination}`
    : `Screen images stay on this Mac (${destination})`;

  const verificationSentence =
    verification === 'verified'
      ? `Pilot has confirmed ${profile.model} accepts images and can call the screen tool.`
      : verification === 'rejected'
        ? `Pilot checked ${profile.model} and it cannot be used for screen questions; nothing has been sent.`
        : `Pilot has not yet confirmed ${profile.model} can answer screen questions.`;

  const detail = endpoint.isRemote
    ? `${endpoint.detail} The request is made with ${using}. ${verificationSentence}`
    : `${endpoint.detail} ${verificationSentence}`;

  return {
    sendsScreenOffDevice: endpoint.isRemote,
    destination,
    authMode: profile.authMode,
    verification,
    headline,
    detail,
    credentialSummary,
    needsAttention: endpoint.isRemote || verification !== 'verified',
  };
}

/** One line for a startup log or a demo header. Contains no secret and no screen text. */
export function describeDisclosureLine(disclosure: ModelDataDisclosure): string {
  return (
    `${disclosure.sendsScreenOffDevice ? 'REMOTE' : 'local'} · ${disclosure.destination} · ` +
    `${disclosure.authMode} · ${disclosure.verification}`
  );
}
