import { describeEndpoint, scrubUrlCredentials, type ModelProfile } from '@pilot/shared';
import type { ModelProfileKind, ModelStatusView } from '../ipc/schemas.js';

/**
 * Which model Pilot is talking to, in words, for the panel (runbook follow-ups
 * 46 and 33; system-design §14).
 *
 * ## The defect this file exists for
 *
 * Nothing on screen said which model was in force. The panel's only provider
 * surface was `CodexStatus`, which returns `null` unless the Codex profile is
 * selected, so an API-key build, a local build and — the case that matters —
 * the **development stand-in** all rendered no Model section at all. PR-042
 * measured that against the real packaged bundle with `env -i`: a `launchd` or
 * Finder launch supplies none of the three provider selectors, the `??` chain
 * in `main/index.ts` falls all the way through, and the app answers questions
 * with Pi's faux provider — **which is not a language model**. The only
 * statement to the contrary was a stderr line a Finder launch discards.
 *
 * So this module produces one provider-neutral row that is *always* rendered,
 * and it is loud about exactly one thing: {@link ModelStatusView.realModel}
 * being false.
 *
 * ## Renderer-safe, deliberately
 *
 * Bundled into Chromium (`src/conversation/view-model.ts` reads the result and
 * `ConversationPanel.tsx` renders it), so it imports `@pilot/shared` and
 * nothing else — the same rule `src/observation/failure-view.ts` and
 * `src/lifecycle/guidance.ts` state for themselves. **No Pi type reaches
 * Chromium** (`docs/handoff.md` §4), which is why the locality half comes from
 * `describeEndpoint` in `@pilot/shared` rather than from `@pilot/agent`'s
 * `describeModelDataDisclosure`. PR-038's disclosure banner is untouched and
 * still rendered beside this; this is the row that exists even when there is no
 * disclosure to show.
 *
 * ## Why no field here can hold a credential
 *
 * Every string is built from a provider id, a model id, a host name, a
 * `PilotError.userMessage` and a fixed vocabulary — the same argument
 * `CredentialStatus` (PR-020) and `ModelDataDisclosure` (PR-038) rest on. Two
 * belts on top of it, because `@pilot/shared`'s redactor matches on **key
 * name** and has already eaten four real fields (runbook hazard 25) while being
 * unable to see a secret in a *value* (follow-up 42):
 *
 *  1. no key here matches any redactor pattern — there is no `key`, `token`,
 *     `secret`, `credential`, `auth…header`, `image`, `frame` or `answer` in
 *     the shape, so the whole object survives a `logger.info` intact and a test
 *     asserts `redactedPaths` is empty;
 *  2. **every string is passed through `scrubUrlCredentials`** on the way out.
 *     A base URL of the form `https://user:token@host/v1` is a credential
 *     wearing an address's clothes (PR-041), and it reaches this file through
 *     `ModelProfile.baseUrl` and through `blockedReason`, which is a
 *     `userMessage` that may quote the address back. Node's own `fetch` does
 *     exactly that.
 */

/** Fixed vocabulary. Every string below is one of these or is derived from a host/model id. */
const PROFILE_LABELS: Readonly<Record<ModelProfileKind, string>> = {
  codex: 'ChatGPT subscription',
  'api-key': 'Your own API key',
  local: 'Your own local endpoint',
  development: 'Development stand-in',
};

/**
 * The headline for the case this PR exists for.
 *
 * Written in the shape of a warning rather than a badge: a user who does not
 * read the small print of an answer must still be unable to miss it.
 */
export const FAUX_MODEL_HEADLINE = 'NOT A REAL MODEL — answers are placeholder text';

export const FAUX_MODEL_DETAIL =
  'No model provider is configured, so Pilot is answering with a built-in stand-in. ' +
  'It is not a language model, it never sees your screen, and nothing it says about ' +
  'your screen is true.';

/** What the stand-in's locality row says. It is not "local" — it is *nowhere*. */
export const FAUX_MODEL_LOCALITY = 'Nothing is sent anywhere: there is no model to send it to.';

/** {@link ModelStatusView.destination} for the stand-in. */
export const FAUX_MODEL_DESTINATION = 'nowhere';

export interface DescribeModelStatusInput {
  /** Which term of `main/index.ts`'s `??` chain won. */
  readonly kind: ModelProfileKind;
  /** The chosen `ModelSource.profile`. Carries no credential by construction. */
  readonly profile: ModelProfile;
  /**
   * Why Pilot cannot answer with this profile right now, as a
   * `PilotError.userMessage` — a Codex profile with no sign-in, a local
   * endpoint that failed its probe, a key that stopped working mid-conversation.
   * `null` when Pilot will attempt an answer.
   */
  readonly blockedReason?: string | null;
  /**
   * Absolute path of the launch environment file (`main/launch-env.ts`), which
   * is the only terminal-free way to point a double-clicked Pilot at a real
   * model. Named in the remedy so the two halves of the fix agree.
   */
  readonly launchFile: string;
}

/**
 * What the remedy may tell the user to put in the launch file.
 *
 * Deliberately does **not** offer `PILOT_API_KEY`: `LAUNCH_ENV_ALLOWED` refuses
 * it, because a credential in a plaintext file would undo PR-038's sealing. The
 * sentence says so rather than leaving the user to discover the refusal.
 */
function launchRemedy(launchFile: string): string {
  return (
    `To use a real model, put PILOT_MODEL_PROFILE=codex (a ChatGPT subscription) or ` +
    `PILOT_LOCAL_BASE_URL=http://localhost:11434/v1 (your own model server) in ${launchFile} ` +
    `and restart Pilot. An API key cannot go in that file: start Pilot once from a terminal ` +
    `with PILOT_API_KEY set and Pilot seals it in the keychain.`
  );
}

/** Screen-data destination sentence, per profile. Locality itself comes from `describeEndpoint`. */
const ROUTING: Readonly<Record<Exclude<ModelProfileKind, 'development'>, string>> = {
  codex: 'using your ChatGPT sign-in',
  'api-key': 'using the API key you configured',
  local: 'on the endpoint you configured',
};

const HEADLINES: Readonly<Record<Exclude<ModelProfileKind, 'development'>, string>> = {
  codex: 'Answering with your ChatGPT subscription',
  'api-key': 'Answering with your own API key',
  local: 'Answering with your own local model',
};

/**
 * Describes the model profile in force.
 *
 * Total over the four profiles `main/index.ts` can choose, because a fifth one
 * added to the `??` chain without a row here would be a compile error rather
 * than a blank panel — which is the failure this whole file is about.
 */
export function describeModelStatus(input: DescribeModelStatusInput): ModelStatusView {
  const { kind, profile } = input;
  const blockedReason = input.blockedReason ?? null;
  const endpoint = describeEndpoint(profile);
  const modelLabel = `${profile.provider}/${profile.model}`;
  const realModel = kind !== 'development';

  // The stand-in's own base URL is `http://localhost:0`, so `describeEndpoint`
  // would truthfully report "Local model on this Mac (localhost)" — truthful
  // about the address and misleading about everything else, because there is no
  // model at that address and no request is ever made. The locality answer for
  // this profile is "nowhere", and only this profile overrides it.
  const localityLabel = realModel ? endpoint.label : FAUX_MODEL_LOCALITY;
  const destination = realModel ? (endpoint.host ?? profile.provider) : FAUX_MODEL_DESTINATION;
  const sendsScreenOffDevice = realModel && endpoint.isRemote;

  const answering =
    kind === 'development'
      ? FAUX_MODEL_DETAIL
      : `Questions and screen images go to ${modelLabel} ${ROUTING[kind]}. ${endpoint.detail}`;

  const headline =
    kind === 'development'
      ? FAUX_MODEL_HEADLINE
      : blockedReason === null
        ? HEADLINES[kind]
        : `${PROFILE_LABELS[kind]} — Pilot cannot answer questions yet`;

  const detail = blockedReason === null ? answering : `${blockedReason} ${answering}`;

  const severity: ModelStatusView['severity'] = !realModel
    ? 'critical'
    : blockedReason !== null || sendsScreenOffDevice
      ? 'attention'
      : 'normal';

  // Belt two (see the file comment). Applied to every string that leaves here,
  // including the ones assembled from fixed vocabulary, so a future edit that
  // interpolates an address into one of them cannot reintroduce follow-up 42.
  const scrub = (text: string): string => scrubUrlCredentials(text);

  return {
    profile: kind,
    profileLabel: PROFILE_LABELS[kind],
    modelLabel: scrub(modelLabel),
    realModel,
    sendsScreenOffDevice,
    destination: scrub(destination),
    localityLabel: scrub(localityLabel),
    headline: scrub(headline),
    detail: scrub(detail),
    severity,
    blockedReason: blockedReason === null ? null : scrub(blockedReason),
    remedy: realModel ? null : launchRemedy(scrub(input.launchFile)),
  };
}

/** One line for a startup log, a smoke check or a demo header. Carries no secret. */
export function describeModelStatusLine(status: ModelStatusView): string {
  return (
    `${status.realModel ? 'real' : 'NOT A REAL MODEL'} · ${status.profile} · ` +
    `${status.modelLabel} · ${status.sendsScreenOffDevice ? 'REMOTE' : 'on this Mac'}`
  );
}
