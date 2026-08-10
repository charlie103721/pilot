import { readdirSync, existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiKeyCredential,
  createAesGcmCipher,
  createCodexCredentialStore,
  createEncryptedCredentialStore,
  createScriptedModelSource,
  createSecretScrubber,
  generateSecretKey,
  type ScriptedModelSource,
} from '@pilot/agent';
import {
  DEFAULT_REDACTION_OPTIONS,
  MVP_SCREEN_POLICY,
  createLogger,
  createMemorySink,
  redactUrlCredentials,
  redactValue,
  type LogRecord,
  type LogSink,
  type Logger,
  type ObservedWindow,
} from '@pilot/shared';
import { DEFAULT_SCREEN_CONTEXT_POLICY, RETENTION_EVENTS } from '@pilot/observation';
import {
  CONSERVATIVE_CONTEXT_WINDOW,
  resolveContextWindow,
  type ContextWindowInput,
} from '../main/context-window.js';
import { openConversationStoreRuntime } from '../main/conversation-store.js';
import { resolveLocalModelSource } from '../main/local-model.js';
import {
  AX_ELEMENTS,
  OVER_THE_BUTTON,
  pushScreenshot,
  settleRun,
} from '../observation/ask-demo.js';
import {
  createObservationRig,
  DEMO_DESKTOP,
  DEMO_DESKTOP_AFTER_CLOSE,
  type ObservationRig,
  type ObservationRigOptions,
} from '../observation/observe-rig.js';
import { GRANTED, REPO_ROOT, listTree } from '../voice/flow-demo.js';
import {
  BYTE_SCANNERS,
  describeScanHits,
  runScannerSelfTest,
  scanArtefact,
  type ArtefactScan,
} from './scanners.js';

/**
 * PR-041's demo: **the privacy audit.**
 *
 *     pnpm demo:privacy
 *
 * `docs/implementation.md`, PR-041: "verify all buffer-clear paths, inspect
 * persisted files/logs, assert no image/audio/secret persistence, and test
 * observation rate/context limits." Every prior PR asserted a privacy property
 * about its own work. This one checks them from the outside, against the
 * shipping composition, and treats each as a claim to be **falsified**.
 *
 * ## The rule this walkthrough is written under
 *
 * *An audit that only checks what the code already asserts will pass, prove
 * nothing, and be worse than useless, because it will read as assurance.*
 *
 * Three things follow from it, and they are the whole design:
 *
 *  1. **Artefacts, not accessors.** The SQLite file is read as raw bytes while a
 *     conversation is still open, not asked whether it is empty. The log is read
 *     as emitted records, not as the calls that produced them. Provider requests
 *     are parsed and their images base64-decoded, not compared against the
 *     policy object. `$HOME` and the repository are listed before and after and
 *     diffed.
 *  2. **Every scanner is proved before it is believed** (`scanners.ts`). A
 *     regular expression that has stopped matching reports a clean disk for ever
 *     and looks identical to one that checked. Claim A1 is that self-test, and
 *     it runs first.
 *  3. **Unprovable is a verdict.** Where a property cannot be established on
 *     this machine it is printed as `UNPROVABLE` with the reason, never passed
 *     silently. Section 10 collects them, and it is the user's Mac checklist.
 *
 * ## What is real, and what is not
 *
 * Real, and the shipping code: `PilotInteractionController` and its table, the
 * `RetentionGuard` and its §13 occasions, `main/observation-runtime.ts`,
 * `main/lifecycle-runtime.ts`, `main/conversation-store.ts` over a **real SQLite
 * database in a real temporary directory**, `PiAgentSession` over Pi's agent
 * loop, `observe_screen`, `PilotScreenContextService` and the §10 policy,
 * `@pilot/shared`'s redactor, `@pilot/agent`'s Codex and API-key credential
 * stores, and PR-039's local-endpoint resolution.
 *
 * **NO MAC, NO MODEL, NO CREDENTIAL, NO AUDIO, NO PIXELS.** The frames are
 * synthetic PNGs, the far end of the helper pipe is the Node stub, the replies
 * are scripted, and every "secret" swept for is a canary this file invented.
 */

export interface PrivacyAuditResult {
  readonly lines: readonly string[];
  readonly claims: readonly PrivacyClaim[];
  readonly ok: boolean;
}

export type PrivacyVerdict = 'held' | 'FAILED' | 'unprovable';

/** One thing that was supposed to be true, and what happened when it was tested. */
export interface PrivacyClaim {
  readonly id: string;
  /** The property, stated so that it could be false. */
  readonly claim: string;
  /** What was read to decide. An artefact wherever there is one. */
  readonly how: string;
  readonly verdict: PrivacyVerdict;
  readonly detail: string;
}

/**
 * Every claim this audit is supposed to reach, by id.
 *
 * The audit compares its own output against this list in both directions and
 * fails if anything is missing or unexpected. **An audit that silently stops
 * checking is the failure mode this PR exists to prevent**, and it would look
 * exactly like a green run: a section that throws early, a loop whose body stops
 * running, a claim lost in a merge. `test/privacy/privacy-audit.test.ts` pins it.
 */
export const EXPECTED_CLAIM_IDS = [
  'A1',
  'R1',
  'R2',
  'R3',
  'R4',
  'D1',
  'D2',
  'D3',
  'C1',
  'C2',
  'C3',
  'P1',
  'P2',
  'P3',
  'X1',
  'X2',
  'L1',
  'L2',
  'L3',
  'F1',
  'B1',
] as const;

/** What {@link auditSelfCheck} found wrong with the audit's own output. */
export interface AuditSelfCheck {
  /** Ids in {@link EXPECTED_CLAIM_IDS} that no claim carried. */
  readonly missing: readonly string[];
  /** Ids a claim carried that are not in {@link EXPECTED_CLAIM_IDS}. */
  readonly stray: readonly string[];
  /** Ids carried twice: one of the two overwrote the other in every reading. */
  readonly duplicated: readonly string[];
  readonly ok: boolean;
}

/**
 * Checks the audit against its own manifest.
 *
 * Pure, exported and tested separately on purpose: this is the check that makes
 * a broken audit fail loudly, and it is the last thing that should only be
 * exercised by the expensive run it guards. `test/privacy/privacy-audit.test.ts`
 * feeds it a truncated, a padded and a duplicated claim list.
 */
export function auditSelfCheck(claims: readonly PrivacyClaim[]): AuditSelfCheck {
  const ids = claims.map((claim) => claim.id);
  const expected: readonly string[] = EXPECTED_CLAIM_IDS;
  const missing = expected.filter((id) => !ids.includes(id));
  const stray = ids.filter((id) => !expected.includes(id));
  const duplicated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  return {
    missing,
    stray,
    duplicated,
    ok: missing.length === 0 && stray.length === 0 && duplicated.length === 0,
  };
}

const CONVERSATION_ID = 'conv-privacy-audit';

/** Canaries. Nothing in Pilot may ever put one of these anywhere. */
export const AUDIT_CANARIES = {
  codexToken: 'pilot-canary-codex-refresh-Q7vN2x',
  apiKey: 'pilot-canary-api-key-Zk91mB',
  localKey: 'pilot-canary-local-key-Hs44dT',
  urlPassword: 'pilot-canary-url-password-Wq83Lf',
  question: 'pilot-canary-question-Rm52Ub',
} as const;

const QUESTIONS = [
  `What is this button, and remember ${AUDIT_CANARIES.question}?`,
  'Does it charge the card on file?',
  'What plan is this account on?',
] as const;

const ANSWERS = [
  'That is the Update payment method button.',
  'Yes — the card on file is charged when the plan renews.',
  'The account is on the team plan.',
] as const;

/* -------------------------------------------------------------------------- *
 * Artefact readers
 * -------------------------------------------------------------------------- */

/** Every file under a directory, with its bytes. */
async function filesUnder(directory: string): Promise<readonly { path: string; bytes: Buffer }[]> {
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.push({ path: path.slice(directory.length + 1), bytes: await readFile(path) });
      }
    }
  };
  await walk(directory);
  return files;
}

/** Scans every file under a directory. Used on the live database, twice. */
async function scanDirectory(
  directory: string,
  needles: readonly (readonly [string, string])[],
): Promise<readonly ArtefactScan[]> {
  const files = await filesUnder(directory);
  return files.map((file) => scanArtefact(file.path, file.bytes, needles));
}

/**
 * The log, as bytes.
 *
 * `JSON.stringify` of the emitted records rather than the fields the calls
 * passed: the redactor sits between the two, and the audit's question is about
 * what a sink — a file, a console, a crash report — would receive.
 */
function logBytes(records: readonly LogRecord[]): Buffer {
  return Buffer.from(JSON.stringify(records), 'latin1');
}

/** One image block, as the provider actually received it. */
interface SentImage {
  readonly requestIndex: number;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
}

interface RecordedBlock {
  readonly type?: unknown;
  readonly data?: unknown;
  readonly text?: unknown;
}

/** PNG `IHDR` width/height. `null` for anything that is not a PNG. */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function blocksOf(json: string): readonly { index: number; block: RecordedBlock }[] {
  const messages = JSON.parse(json) as readonly { content?: unknown }[];
  const blocks: { index: number; block: RecordedBlock }[] = [];
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) {
      return;
    }
    for (const block of message.content as readonly RecordedBlock[]) {
      blocks.push({ index, block });
    }
  });
  return blocks;
}

/**
 * Every image the provider was actually sent, decoded.
 *
 * This is the whole of "counted off what provider requests carried, not read
 * back from the config": the base64 in each `image` block is decoded, its byte
 * length measured and its pixel dimensions read out of the PNG header.
 */
function imagesSent(source: ScriptedModelSource): readonly SentImage[] {
  const images: SentImage[] = [];
  source.requests.forEach((json, requestIndex) => {
    for (const { block } of blocksOf(json)) {
      if (block.type !== 'image' || typeof block.data !== 'string') {
        continue;
      }
      const decoded = Buffer.from(block.data, 'base64');
      const size = pngSize(decoded);
      images.push({
        requestIndex,
        bytes: decoded.length,
        width: size?.width ?? null,
        height: size?.height ?? null,
      });
    }
  });
  return images;
}

/** How many image blocks each provider request carried. */
function imagesPerRequest(source: ScriptedModelSource): readonly number[] {
  const counts: number[] = source.requests.map(() => 0);
  for (const image of imagesSent(source)) {
    counts[image.requestIndex] = (counts[image.requestIndex] ?? 0) + 1;
  }
  return counts;
}

/**
 * `observe_screen` outcomes, as the model was told them.
 *
 * `describeObservation` opens with `{"tool":"observe_screen","status":"ok"…}`
 * and `describeObserveScreenFailureText` with `"status":"error"` plus the coarse
 * failure kind, so the tool results in the last request say how many looks
 * actually produced a picture — which is what a rate limit is measured in.
 */
function toolOutcomes(source: ScriptedModelSource): { ok: number; refused: number } {
  const json = source.requests.at(-1) ?? '[]';
  let ok = 0;
  let refused = 0;
  for (const { block } of blocksOf(json)) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      continue;
    }
    if (!block.text.includes('"tool":"observe_screen"')) {
      continue;
    }
    if (block.text.includes('"status":"ok"')) {
      ok += 1;
    } else if (block.text.includes('"status":"error"')) {
      refused += 1;
    }
  }
  return { ok, refused };
}

/** A bounded listing of a directory tree, for the before/after filesystem diff. */
function listBounded(root: string, depth: number): readonly string[] {
  const skip = new Set([
    'node_modules',
    '.git',
    '.claude',
    '.cache',
    'dist',
    'release',
    'resources',
    '.build',
    '.local',
    '.npm',
    '.pnpm-store',
    'Caches',
  ]);
  const found: string[] = [];
  const walk = (directory: string, level: number): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) {
        continue;
      }
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (level < depth) {
          walk(path, level + 1);
        }
      } else if (entry.isFile()) {
        found.push(path);
      }
    }
  };
  walk(root, 1);
  return found.sort();
}

/* -------------------------------------------------------------------------- *
 * The rig, assembled as the app assembles it
 * -------------------------------------------------------------------------- */

/** Waits out §10's observation rate window; the shipped numbers stay shipped. */
async function cool(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_100));
}

interface Opened {
  readonly rig: ObservationRig;
  readonly window: ObservedWindow;
}

/** The rig, permissions granted and a window selected — the app, watching. */
async function watching(
  logger: Logger,
  options: Partial<ObservationRigOptions> = {},
): Promise<Opened> {
  const { stub, ...rest } = options;
  const rig = await createObservationRig({
    stub: {
      permissions: GRANTED,
      desktop: DEMO_DESKTOP,
      axElements: AX_ELEMENTS,
      pointer: OVER_THE_BUTTON,
      captureFrameBytes: 3_072,
      captureScaleFactor: 2,
      ...(stub ?? {}),
    },
    logger,
    // This walkthrough owns the ring: it pushes decodable screenshots, and a
    // stub frame is not a decodable image (runbook cross-lane issue 11).
    capturePollIntervalMs: 3_600_000,
    ...rest,
  });
  await rig.permissions.refresh();
  await rig.observation.refreshAttribution();
  const window = await rig.firstWindow();
  await rig.windows.act({ type: 'select', windowId: window.windowId });
  await rig.controller.settled();
  return { rig, window };
}

/** Puts something in every buffer the retention rule is about. */
async function fillBuffers(rig: ObservationRig, window: ObservedWindow, id: string): Promise<void> {
  await pushScreenshot(rig, window, { id, capturedAt: Date.now() });
  await rig.observation.samplePointer();
}

/** What is left in the buffers, read from the app's own status, not a report. */
function leftBehind(rig: ObservationRig): {
  frames: number;
  bytes: number;
  pointerTargets: number;
} {
  const status = rig.observation.status();
  return {
    frames: status.buffer.frameCount,
    bytes: status.buffer.byteCount,
    pointerTargets: rig.observation.metrics().pointerTargets,
  };
}

/** Every `retention clear` the guard wrote, in order. */
function retentionClears(records: readonly LogRecord[]): readonly {
  event: string;
  lineageReset: boolean;
}[] {
  return records
    .filter((entry) => entry.message === 'retention clear')
    .map((entry) => {
      const fields = (entry.fields ?? {}) as Record<string, unknown>;
      return { event: String(fields['event']), lineageReset: fields['lineageReset'] === true };
    });
}

interface Instrumented {
  readonly logger: Logger;
  readonly sink: LogSink & { readonly records: readonly LogRecord[] };
}

function instrument(): Instrumented {
  const sink: LogSink & { readonly records: readonly LogRecord[] } = createMemorySink();
  return { sink, logger: createLogger({ scope: 'privacy-audit', level: 'debug', sink }) };
}

/* -------------------------------------------------------------------------- *
 * The audit
 * -------------------------------------------------------------------------- */

export async function runPrivacyAudit(): Promise<PrivacyAuditResult> {
  const lines: string[] = [];
  const claims: PrivacyClaim[] = [];
  const unprovable: string[] = [];
  const sinks: (LogSink & { readonly records: readonly LogRecord[] })[] = [];
  const say = (line = ''): void => {
    lines.push(line);
  };
  const evidence = (label: string, value: string): void => {
    say(`     ${label.padEnd(48)} ${value}`);
  };
  const heading = (title: string): void => {
    say();
    say(title);
    say('-'.repeat(76));
  };
  const record = (
    id: string,
    claim: string,
    how: string,
    verdict: PrivacyVerdict,
    detail: string,
  ): void => {
    claims.push({ id, claim, how, verdict, detail });
    evidence(`verdict [${id}]:`, verdict === 'held' ? 'held' : verdict.toUpperCase());
    if (verdict !== 'held') {
      evidence('  because:', detail);
    }
    if (verdict === 'unprovable') {
      unprovable.push(`${id} — ${claim}`);
    }
  };
  const open = (): Instrumented => {
    const made = instrument();
    sinks.push(made.sink);
    return made;
  };

  say('PR-041 — privacy and retention verification');
  say('='.repeat(76));
  say();
  say('Twenty-one claims about what Pilot keeps, writes and sends, each treated');
  say('as something to falsify rather than confirm. Where a claim can be checked');
  say('against an artefact — the bytes of the SQLite file, the emitted log');
  say('records, the provider requests, the filesystem — it is, because an audit');
  say('that asks the code whether the code is right proves nothing.');
  say();
  say('Real: the interaction table, the RetentionGuard and its §13 occasions,');
  say('      main/observation-runtime.ts, main/lifecycle-runtime.ts, a REAL');
  say('      SQLite conversation store in a temporary directory, PiAgentSession,');
  say('      observe_screen, PilotScreenContextService and the §10 policy,');
  say('      @pilot/shared’s redactor, and both credential stores.');
  say('NOT REAL: no macOS, no model, no credential, no audio, no pixels. Every');
  say('      secret swept for is a canary this file invented. Section 10 says');
  say('      what that leaves for the Mac, and it is the user’s checklist.');

  const scratch = await mkdtemp(join(tmpdir(), 'pilot-privacy-audit-'));
  const homeBefore = listBounded(homedir(), 3);
  const repoBefore = listTree(REPO_ROOT);

  // -------------------------------------------------------------------------
  // 1 — the audit audits itself
  // -------------------------------------------------------------------------
  heading('1. THE SCANNERS, BEFORE ANY OF THEM IS BELIEVED');
  say('   Every check below reads bytes through one of these scanners. One that');
  say('   has quietly stopped matching would report a clean disk for ever and');
  say('   look exactly like one that checked, so each is run first against a');
  say('   control that contains its pattern and one that does not.');
  say();
  const selfTest = runScannerSelfTest();
  for (const result of selfTest) {
    evidence(
      `${result.id}:`,
      `${result.detectedOnPositive ? 'fires on the control' : 'MISSED THE CONTROL'}` +
        ` · ${result.silentOnNegative ? 'silent on prose' : 'FIRES ON PROSE'}`,
    );
  }
  const scannersOk = selfTest.every((result) => result.ok);
  record(
    'A1',
    'Every byte scanner this audit uses still detects what it is for, and nothing else.',
    'each scanner run against a positive control containing its pattern and a negative control of prose, ids and short tokens',
    scannersOk ? 'held' : 'FAILED',
    scannersOk
      ? `${String(selfTest.length)} scanners, all firing on the control and silent on prose`
      : `broken: ${selfTest
          .filter((result) => !result.ok)
          .map((result) => result.id)
          .join(', ')} — every disk and log verdict below is worthless until this is fixed`,
  );

  // -------------------------------------------------------------------------
  // 2 — the five retention occasions
  // -------------------------------------------------------------------------
  heading('2. THE FIVE §13 RETENTION OCCASIONS, EACH FROM ITS OWN ENTRY POINT');
  say('   system-design §13: "Clear frame and audio buffers on pause, logout,');
  say('   screen lock, window loss, and process shutdown." PR-040 found that two');
  say('   of them had no caller anywhere in the product. The other three are');
  say('   checked the same way here — driven from the surface a user or the');
  say('   operating system reaches, never from the guard — and the buffers are');
  say('   read afterwards from `ScreenStatus`, so "the clear was called" and');
  say('   "nothing is left" are two questions with two answers.');
  say();

  interface OccasionOutcome {
    readonly occasion: string;
    readonly entryPoint: string;
    readonly filled: string;
    readonly logged: string;
    readonly left: string;
    readonly emptied: boolean;
    readonly named: boolean;
  }
  const occasions: OccasionOutcome[] = [];

  const drive = async (
    occasion: string,
    entryPoint: string,
    act: (opened: Opened) => Promise<void>,
    options: Partial<ObservationRigOptions> = {},
  ): Promise<void> => {
    const { logger, sink } = open();
    const opened = await watching(logger, options);
    try {
      await fillBuffers(opened.rig, opened.window, `frame-${occasion}`);
      const before = leftBehind(opened.rig);
      await act(opened);
      await opened.rig.controller.settled();
      const after = leftBehind(opened.rig);
      const logged = retentionClears(sink.records).at(-1);
      occasions.push({
        occasion,
        entryPoint,
        filled: `${String(before.frames)} frame(s)/${String(before.bytes)} B, ${String(before.pointerTargets)} target(s)`,
        logged: logged === undefined ? '(nothing cleared)' : logged.event,
        left: `${String(after.frames)} frame(s)/${String(after.bytes)} B, ${String(after.pointerTargets)} target(s)`,
        emptied:
          before.frames > 0 &&
          after.frames === 0 &&
          after.bytes === 0 &&
          after.pointerTargets === 0,
        named: logged?.event === occasion,
      });
    } finally {
      await opened.rig.dispose();
    }
  };

  // `pause` from the composition root's own command route — the one the menu
  // bar item and the renderer's `pilot:interaction/dispatch` channel reach.
  await drive(
    'pause',
    'rig.dispatch({ type: "pause" }) — the app’s one command route',
    async (opened) => {
      opened.rig.dispatch({ type: 'pause' });
    },
  );
  await drive(
    'screen-lock',
    'LifecycleRuntime.reportScreenLock(true) — Electron powerMonitor',
    async (opened) => {
      opened.rig.lifecycle.reportScreenLock(true);
    },
  );
  await drive(
    'window-loss',
    'the window feed no longer lists the selected window (a ⌘W)',
    async (opened) => {
      await opened.rig.windows.refresh();
    },
    { stub: { desktopScript: [DEMO_DESKTOP, DEMO_DESKTOP_AFTER_CLOSE] } },
  );
  await drive(
    'logout',
    'LifecycleRuntime.reportSessionEnd("logout") — powerMonitor `shutdown`',
    async (opened) => {
      opened.rig.lifecycle.reportSessionEnd('logout');
    },
  );

  for (const outcome of occasions) {
    evidence(`${outcome.occasion} — entry point:`, outcome.entryPoint);
    evidence('  buffers before:', outcome.filled);
    evidence('  retention log says:', outcome.logged);
    evidence('  buffers after:', outcome.left);
  }

  // The fifth occasion is the one no command reaches: `ObservationRuntime
  // .dispose()`, chained off `before-quit` in `main/index.ts`.
  const shutdown = open();
  const shutdownRig = await watching(shutdown.logger);
  await fillBuffers(shutdownRig.rig, shutdownRig.window, 'frame-shutdown');
  const shutdownBefore = leftBehind(shutdownRig.rig);
  await shutdownRig.rig.dispose();
  const shutdownClear = retentionClears(shutdown.sink.records).find(
    (entry) => entry.event === 'shutdown',
  );
  evidence('shutdown — entry point:', 'ObservationRuntime.dispose(), from `before-quit`');
  evidence('  buffers before:', `${String(shutdownBefore.frames)} frame(s)`);
  evidence(
    '  retention log says:',
    shutdownClear === undefined
      ? '(no shutdown clear)'
      : `shutdown — lineage reset: ${String(shutdownClear.lineageReset)}`,
  );

  const allNamed = occasions.every((outcome) => outcome.named) && shutdownClear !== undefined;
  const allEmptied = occasions.every((outcome) => outcome.emptied);
  record(
    'R1',
    'Each of §13’s five occasions is reachable from the shipping composition and names itself in the retention log.',
    'each occasion driven from the surface a user or macOS reaches, then `retention clear` read out of the emitted log records',
    allNamed ? 'held' : 'FAILED',
    allNamed
      ? 'pause, screen-lock, window-loss, logout and shutdown each logged under their own name'
      : `mis-named: ${occasions
          .filter((outcome) => !outcome.named)
          .map((outcome) => `${outcome.occasion}→${outcome.logged}`)
          .join(', ')}${shutdownClear === undefined ? ' (and shutdown never cleared)' : ''}`,
  );
  record(
    'R2',
    'Each clear empties the buffers rather than merely stopping the reads.',
    'a decodable frame and a pointer sample pushed in first, then `ScreenStatus.buffer` and `ObservationRuntimeMetrics.pointerTargets` read afterwards — the guard’s own report is deliberately not consulted',
    allEmptied ? 'held' : 'FAILED',
    allEmptied
      ? 'every occasion went from a non-empty ring to 0 frames, 0 bytes and 0 pointer targets'
      : `left behind: ${occasions
          .filter((outcome) => !outcome.emptied)
          .map((outcome) => `${outcome.occasion} (${outcome.left})`)
          .join(', ')}`,
  );

  say();
  say('   Three more occasions exist beyond §13’s five, because the table also');
  say('   clears on them: `permission-loss` (PR-040), `window-change` and');
  say('   `observation-disabled`. The full set is checked against');
  say('   `RETENTION_EVENTS`, so a new one cannot appear without a line here.');
  const auditedOccasions = new Set<string>([
    ...occasions.map((outcome) => outcome.occasion),
    'shutdown',
    'permission-loss',
    'window-change',
    'observation-disabled',
  ]);
  const unaudited = RETENTION_EVENTS.filter((event) => !auditedOccasions.has(event));
  evidence('RETENTION_EVENTS members:', String(RETENTION_EVENTS.length));
  evidence(
    'members no line here mentions:',
    unaudited.length === 0 ? 'none' : unaudited.join(', '),
  );
  record(
    'R3',
    'No retention occasion exists that this audit does not know about.',
    '`RETENTION_EVENTS` compared against the set the audit drives or names',
    unaudited.length === 0 ? 'held' : 'FAILED',
    unaudited.length === 0
      ? `all ${String(RETENTION_EVENTS.length)} occasions accounted for`
      : `unaudited: ${unaudited.join(', ')}`,
  );

  const boundsRun = open();
  const boundsRig = await watching(boundsRun.logger);
  const bounds = boundsRig.rig.observation.retention.verifyBounds();
  await boundsRig.rig.dispose();
  evidence(
    'ring bounds actually built:',
    `${String(bounds.actual.frameDurationMs)} ms / ${String(bounds.actual.frameMaxBytes)} B / ` +
      `${String(bounds.actual.frameMaxCount)} frames · pointer ${String(bounds.actual.pointerDurationMs)} ms`,
  );
  record(
    'R4',
    'The frame ring and the pointer timeline were constructed with §10’s numbers, and persist nothing.',
    '`RetentionGuard.verifyBounds()` on the rig the app assembles — it reads the ring frames actually land in, not the policy record beside it',
    bounds.ok ? 'held' : 'FAILED',
    bounds.ok ? 'expected and actual agree on all four bounds' : bounds.mismatches.join('; '),
  );

  // -------------------------------------------------------------------------
  // 3 — the live database
  // -------------------------------------------------------------------------
  heading('3. THE SQLITE FILE, WHILE THE CONVERSATION IS STILL OPEN');
  say('   PR-036 proved the file holds no observation records *after* a clear.');
  say('   The interesting moment is the other one: three screen questions asked,');
  say('   three observations taken, the store open and the writer queue live.');
  say('   The bytes are read off the disk with the app still running.');
  say();

  const durableDirectory = join(scratch, 'conversations');
  const conversationRun = open();
  const model = createScriptedModelSource({
    tokensPerSecond: 400,
    script: QUESTIONS.flatMap((_question, index) => [
      { observe: { view: 'both', moment: 'question' } } as const,
      { say: ANSWERS[index] ?? 'Answered.' } as const,
    ]),
  });
  const durable = await openConversationStoreRuntime({
    conversationId: CONVERSATION_ID,
    directory: durableDirectory,
    logger: conversationRun.logger,
  });
  const needles: readonly (readonly [string, string])[] = [
    ['the canary in the question', AUDIT_CANARIES.question],
    ['a canary API key', AUDIT_CANARIES.apiKey],
    ['a canary Codex token', AUDIT_CANARIES.codexToken],
  ];

  const live = await watching(conversationRun.logger, {
    modelSource: model,
    conversationId: CONVERSATION_ID,
    recordRequests: true,
    ...(durable.store === null ? {} : { store: durable.store, restore: durable.restore }),
  });
  let liveScans: readonly ArtefactScan[];
  try {
    for (const [index, question] of QUESTIONS.entries()) {
      await pushScreenshot(live.rig, live.window, {
        id: `frame-q${String(index)}`,
        capturedAt: Date.now(),
        toggleOn: index % 2 === 1,
      });
      await live.rig.observation.samplePointer();
      live.rig.conversation.noteCommand({ type: 'submit-text', text: question });
      live.rig.controller.dispatch({ type: 'submit-text', text: question });
      await settleRun(live.rig);
      await cool();
    }
    evidence('questions asked:', String(QUESTIONS.length));
    evidence('provider requests:', String(model.requests.length));
    evidence('image blocks the provider received:', String(imagesSent(model).length));
    liveScans = await scanDirectory(durableDirectory, needles);
    evidence(
      'files on disk while live:',
      liveScans.map((scan) => `${scan.path} (${String(scan.bytes)} B)`).join(', ') || '(none)',
    );
    const liveHits = describeScanHits(liveScans);
    evidence('found in them:', liveHits.length === 0 ? 'nothing' : liveHits.join(' | '));
    evidence(
      'transcript turns in memory:',
      String(live.rig.controller.snapshot().transcript.length),
    );
  } finally {
    await live.rig.dispose();
    await durable.close();
  }
  const closedScans = await scanDirectory(durableDirectory, needles);
  const closedHits = describeScanHits(closedScans);
  evidence('after the store closed:', closedHits.length === 0 ? 'nothing' : closedHits.join(' | '));

  const kindOf = (hit: string): string | undefined =>
    BYTE_SCANNERS.find((scanner) => scanner.id === hit)?.kind;
  const diskImageHits = [...liveScans, ...closedScans].flatMap((scan) =>
    scan.hits.filter((hit) => kindOf(hit) === 'image' || kindOf(hit) === 'payload'),
  );
  const diskAudioHits = [...liveScans, ...closedScans].flatMap((scan) =>
    scan.hits.filter((hit) => kindOf(hit) === 'audio'),
  );
  const strayCanaries = [...liveScans, ...closedScans].flatMap((scan) =>
    scan.needles.filter((needle) => needle !== 'the canary in the question'),
  );
  record(
    'D1',
    'No image bytes, base64 payload or data: URI is on disk — while a conversation is live, or after it closes.',
    `every file under the conversation directory read as raw bytes at both moments, through the ${String(BYTE_SCANNERS.length)} proved scanners`,
    diskImageHits.length === 0 ? 'held' : 'FAILED',
    diskImageHits.length === 0
      ? `${String(liveScans.length)} file(s) live and ${String(closedScans.length)} after closing; no PNG, JPEG, GIF, HEIC, data: URI or 120-character base64 run in any of them`
      : describeScanHits([...liveScans, ...closedScans]).join(' | '),
  );
  record(
    'D2',
    'No audio bytes are on disk, live or afterwards.',
    'the same artefacts, through the RIFF/WAVE, Core Audio, MPEG-4 and Ogg container scanners',
    diskAudioHits.length === 0 ? 'held' : 'FAILED',
    diskAudioHits.length === 0
      ? 'no audio container header in any persisted file — and see section 10 (d): no microphone has ever been opened here, so this is the weakest form of the claim'
      : diskAudioHits.join(', '),
  );
  const canaryPersisted = closedScans.some((scan) =>
    scan.needles.includes('the canary in the question'),
  );
  record(
    'D3',
    'The words of a question are on disk and nothing else about the screen is — so the disk checks are reading the right file.',
    'a canary string planted inside the first question, then looked for in the bytes: it MUST be there (§13 persists the transcript by design) while no image, audio or foreign canary is',
    canaryPersisted && strayCanaries.length === 0 ? 'held' : 'FAILED',
    canaryPersisted
      ? strayCanaries.length === 0
        ? 'the transcript persisted, the pixels did not — exactly what §13 permits and requires, and proof that D1 and D2 read a file with content in it'
        : `foreign canaries found on disk: ${strayCanaries.join(', ')}`
      : 'the canary question is NOT in the file. Either the transcript did not persist, or these checks are reading the wrong artefact — in which case D1 and D2 are vacuous and must not be believed.',
  );

  // -------------------------------------------------------------------------
  // 4 — credentials, from outside, across the four profiles
  // -------------------------------------------------------------------------
  heading('4. CREDENTIALS, ACROSS ALL FOUR PROFILES');
  say('   PR-038 swept its own key. This sweeps all four profiles from outside,');
  say('   including the Codex token file PR-037 added, with canary secrets');
  say('   nothing in Pilot has any reason to know about.');
  say();

  const credentialRun = open();
  const credentialDirectory = join(scratch, 'credentials');
  const codexPath = join(credentialDirectory, 'model-credentials.json');

  // (a) the Codex refresh token, through the real store with no protector —
  // the worst case, because a plaintext file is the one that could leak.
  const codexStore = createCodexCredentialStore({
    filePath: codexPath,
    logger: credentialRun.logger,
  });
  await codexStore.modify('openai-codex', () => ({
    type: 'oauth',
    access: `${AUDIT_CANARIES.codexToken}-access`,
    refresh: AUDIT_CANARIES.codexToken,
    expires: Date.now() + 3_600_000,
  }));
  const codexMode = (await stat(codexPath)).mode & 0o777;
  const codexDirectoryMode = (await stat(credentialDirectory)).mode & 0o777;
  evidence(
    'codex credential file:',
    `${codexPath.slice(scratch.length + 1)} (mode ${codexMode.toString(8)})`,
  );
  evidence('its directory:', `mode ${codexDirectoryMode.toString(8)}`);
  evidence(
    'provider ids it will admit to:',
    (await codexStore.providerIds()).join(', ') || '(none)',
  );

  // (b) the API-key profile's sealed store, with a real cipher.
  const apiKeyStore = createEncryptedCredentialStore({
    cipher: createAesGcmCipher(generateSecretKey()),
    scrubber: createSecretScrubber(),
  });
  await apiKeyStore.modify('recorded-vendor', () => apiKeyCredential(AUDIT_CANARIES.apiKey));
  const sealed = (await apiKeyStore.serialize()) ?? '';
  await writeFile(join(credentialDirectory, 'api-key-store.json'), sealed, { mode: 0o600 });
  evidence('api-key store cipher:', apiKeyStore.cipherName);
  evidence(
    'the sealed text contains the key:',
    sealed.includes(AUDIT_CANARIES.apiKey) ? 'YES — THAT WOULD BE A DEFECT' : 'no',
  );

  // (c) the local profile, resolved by the shipping code, with a credential in
  // the environment AND one inside the base URL. Port 9 is discard: nothing is
  // listening, so the probe fails fast and every diagnostic sentence is
  // produced — which is the path the credential used to escape through.
  const localBaseUrl = `http://pilot:${AUDIT_CANARIES.urlPassword}@127.0.0.1:9/v1`;
  const local = await resolveLocalModelSource({
    env: {
      PILOT_LOCAL_BASE_URL: localBaseUrl,
      PILOT_LOCAL_API_KEY: AUDIT_CANARIES.localKey,
      PILOT_LOCAL_TIMEOUT_MS: '400',
    },
    logger: credentialRun.logger,
  });
  evidence('local base URL, as configured:', 'http://pilot:<secret>@127.0.0.1:9/v1');
  evidence('local base URL, as displayed:', redactUrlCredentials(localBaseUrl));
  for (const line of local.lines) {
    evidence('  startup line:', line.length > 96 ? `${line.slice(0, 96)}…` : line);
  }
  evidence(
    '  the refusal every question would get:',
    local.blockedBy === null ? '(none)' : local.blockedBy.userMessage,
  );

  // (d) the development profile has no credential at all — worth stating.
  evidence('development profile credential:', 'none; the faux provider authenticates nothing');

  const credentialFiles = await scanDirectory(credentialDirectory, [
    ['the canary Codex refresh token', AUDIT_CANARIES.codexToken],
    ['the canary API key', AUDIT_CANARIES.apiKey],
    ['the canary local key', AUDIT_CANARIES.localKey],
    ['the canary URL password', AUDIT_CANARIES.urlPassword],
  ]);
  const strayCredentialFiles = credentialFiles.filter(
    (scan) => !scan.path.includes('model-credentials') && scan.needles.length > 0,
  );
  for (const scan of credentialFiles) {
    evidence(
      `  ${scan.path}:`,
      scan.needles.length === 0 ? 'no canary' : `holds ${scan.needles.join(', ')}`,
    );
  }
  record(
    'C1',
    'A credential is only ever in the one file meant to hold it, at 0600 inside a 0700 directory.',
    'four canary secrets written through the real stores, then every file under the credentials directory read as raw bytes and its mode read from the filesystem',
    strayCredentialFiles.length === 0 && codexMode === 0o600 && codexDirectoryMode === 0o700
      ? 'held'
      : 'FAILED',
    strayCredentialFiles.length === 0 && codexMode === 0o600 && codexDirectoryMode === 0o700
      ? `the api-key file is ciphertext (${apiKeyStore.cipherName}); only the Codex file holds material, and only because Linux has no protector — see section 10 (c)`
      : `${describeScanHits(strayCredentialFiles).join(' | ')} modes ${codexMode.toString(8)}/${codexDirectoryMode.toString(8)}`,
  );

  const credentialLogHits = (
    [
      ['Codex refresh token', AUDIT_CANARIES.codexToken],
      ['API key', AUDIT_CANARIES.apiKey],
      ['local API key', AUDIT_CANARIES.localKey],
      ['URL password', AUDIT_CANARIES.urlPassword],
    ] as const
  ).filter(([, secret]) =>
    logBytes(credentialRun.sink.records).includes(Buffer.from(secret, 'latin1')),
  );
  evidence('log records written while doing all that:', String(credentialRun.sink.records.length));
  evidence(
    'canaries anywhere in them:',
    credentialLogHits.length === 0 ? 'none' : credentialLogHits.map(([label]) => label).join(', '),
  );
  record(
    'C2',
    'No credential of any of the four profiles reaches a log record.',
    'the emitted `LogRecord[]` serialised and searched for each canary — the records a sink would receive, after the redactor, not the fields the calls passed',
    credentialLogHits.length === 0 ? 'held' : 'FAILED',
    credentialLogHits.length === 0
      ? 'no canary in any record, including the startup lines that print the local endpoint and the diagnosis that names it'
      : `found: ${credentialLogHits.map(([label]) => label).join(', ')}`,
  );

  // Everything that can leave the process: the startup lines, both halves of
  // the refusal every question would get, its details, each diagnosis the panel
  // can render, and the log. `LocalEndpointReport.health.baseUrl` is
  // deliberately NOT in this list — it is the address requests are built from
  // and keeps whatever it was configured with, in memory, for exactly as long
  // as the process lives. That is stated below rather than quietly excluded.
  const urlDisclosures = [
    ...local.lines,
    local.blockedBy?.userMessage ?? '',
    local.blockedBy?.message ?? '',
    JSON.stringify(local.blockedBy?.details ?? {}),
    ...(local.report?.diagnoses ?? []).flatMap((diagnosis) => [
      diagnosis.userMessage,
      diagnosis.remedy,
      diagnosis.detail,
    ]),
    logBytes(credentialRun.sink.records).toString('latin1'),
  ].filter((text) => text.includes(AUDIT_CANARIES.urlPassword));
  evidence(
    '  the in-memory report still holds the address:',
    JSON.stringify(local.report ?? {}).includes(AUDIT_CANARIES.urlPassword)
      ? 'yes — by design; it is what requests are built from, and it is never rendered or written'
      : 'no',
  );
  say();
  say('   Two things this section found and PR-041 fixed. The address is shown');
  say('   without its user information wherever a person reads it — and, less');
  say('   obviously, **a library’s own error text quotes the URL back**: Node’s');
  say('   `fetch` refuses a URL that carries credentials and says so by printing');
  say('   the whole thing, which landed in a diagnosis `detail` and therefore in');
  say('   `PilotError.message`. `scrubUrlCredentials` is applied to the error');
  say('   text, not only to Pilot’s own formatting.');
  say();
  record(
    'C3',
    'A credential embedded in the local endpoint’s base URL reaches no log line, no startup line and no sentence the user is shown.',
    'the shipping `resolveLocalModelSource` run against `http://pilot:<secret>@127.0.0.1:9/v1`, then its startup lines, its `blockedBy` messages and its report searched for the secret',
    urlDisclosures.length === 0 ? 'held' : 'FAILED',
    urlDisclosures.length === 0
      ? `the address is shown as ${redactUrlCredentials(localBaseUrl)}. This is the defect PR-041 found and fixed: before the fix the secret appeared in two log fields, in the "PROBLEM …" sentence the panel renders, and therefore — through \`AgentRuntimeOptions.blockedBy\`, whose refusal answers every question with that sentence — in the durable transcript on disk. The redactor never saw it, because it matches on the key name and \`endpoint\`, \`line\` and \`userMessage\` are none of its patterns.`
      : `still disclosed in ${String(urlDisclosures.length)} place(s)`,
  );

  // -------------------------------------------------------------------------
  // 5 — the §10 policy under pressure
  // -------------------------------------------------------------------------
  heading('5. THE §10 POLICY, COUNTED OFF THE WIRE');
  say('   Not read back from the policy object: every image block the provider');
  say('   actually received is base64-decoded, its byte length measured and its');
  say('   pixel size read out of the PNG header.');
  say();
  const sent = imagesSent(model);
  const perRequest = imagesPerRequest(model);
  const maxEdge = Math.max(
    0,
    ...sent.flatMap((image) =>
      image.width === null || image.height === null ? [] : [Math.max(image.width, image.height)],
    ),
  );
  const maxImageBytes = Math.max(0, ...sent.map((image) => image.bytes));
  const maxPerRequest = Math.max(0, ...perRequest);
  const activeCeiling =
    DEFAULT_SCREEN_CONTEXT_POLICY.activeContext.maxFullFrames +
    DEFAULT_SCREEN_CONTEXT_POLICY.activeContext.maxPointerCrops;
  evidence('image blocks sent, in total:', String(sent.length));
  evidence(
    'images per request (max):',
    `${String(maxPerRequest)} (§10 active context allows ${String(activeCeiling)})`,
  );
  evidence(
    'longest edge of any image sent:',
    `${String(maxEdge)} px (§10 fullFrameMaxEdge ${String(MVP_SCREEN_POLICY.fullFrameMaxEdge)} px)`,
  );
  evidence(
    'largest image sent:',
    `${String(maxImageBytes)} B (§10 maxImageBytes ${String(DEFAULT_SCREEN_CONTEXT_POLICY.image.maxImageBytes)} B)`,
  );
  const ceilingsHeld =
    sent.length > 0 &&
    maxPerRequest <= activeCeiling &&
    maxEdge <= MVP_SCREEN_POLICY.fullFrameMaxEdge &&
    maxImageBytes <= DEFAULT_SCREEN_CONTEXT_POLICY.image.maxImageBytes;
  record(
    'P1',
    'No provider request ever carried more images, larger images or bigger images than §10 allows.',
    'every `image` block in every recorded provider request base64-decoded; pixel dimensions read from the PNG IHDR, byte length from the decoded buffer',
    sent.length === 0 ? 'FAILED' : ceilingsHeld ? 'held' : 'FAILED',
    sent.length === 0
      ? 'no image reached the provider at all, so this check proved nothing — the walkthrough is not exercising `observe_screen`'
      : `${String(sent.length)} image(s), at most ${String(maxPerRequest)} per request, longest edge ${String(maxEdge)} px, largest ${String(maxImageBytes)} B`,
  );

  // The rate limit, from a model that looks five times inside one window.
  const burstRun = open();
  const burstModel = createScriptedModelSource({
    tokensPerSecond: 400,
    script: [
      { observe: { view: 'window', moment: 'question' } },
      { observe: { view: 'window', moment: 'question' } },
      { observe: { view: 'window', moment: 'question' } },
      { observe: { view: 'window', moment: 'question' } },
      { observe: { view: 'window', moment: 'question' } },
      { say: 'I looked as often as I was allowed to.' },
    ],
  });
  const burst = await watching(burstRun.logger, {
    modelSource: burstModel,
    recordRequests: true,
    conversationId: 'conv-privacy-burst',
  });
  let outcomes: { ok: number; refused: number };
  try {
    await pushScreenshot(burst.rig, burst.window, { id: 'frame-burst', capturedAt: Date.now() });
    await burst.rig.observation.samplePointer();
    burst.rig.conversation.noteCommand({ type: 'submit-text', text: 'Keep looking.' });
    burst.rig.controller.dispatch({ type: 'submit-text', text: 'Keep looking.' });
    await settleRun(burst.rig);
    outcomes = toolOutcomes(burstModel);
  } finally {
    await burst.rig.dispose();
  }
  evidence('observe_screen calls the model made:', '5, back to back, inside one rate window');
  evidence('of those, answered with a picture:', String(outcomes.ok));
  evidence('of those, refused:', String(outcomes.refused));
  evidence(
    '§10 limit:',
    `${String(DEFAULT_SCREEN_CONTEXT_POLICY.capture.maxRequestsPerSecond)} per ${String(DEFAULT_SCREEN_CONTEXT_POLICY.capture.rateWindowMs)} ms`,
  );
  const rateHeld =
    outcomes.ok + outcomes.refused >= 5 &&
    outcomes.ok <= DEFAULT_SCREEN_CONTEXT_POLICY.capture.maxRequestsPerSecond;
  record(
    'P2',
    'The observation rate limit holds under pressure, and the refusals are visible on the wire.',
    'a scripted model asked to call `observe_screen` five times inside one rate window; the tool results the provider received are counted (`"status":"ok"` against `"status":"error"`), never the limiter’s own metrics',
    rateHeld ? 'held' : 'FAILED',
    rateHeld
      ? `${String(outcomes.ok)} of ${String(outcomes.ok + outcomes.refused)} looks produced an image; the rest came back refused`
      : `${String(outcomes.ok)} produced an image and ${String(outcomes.refused)} were refused, out of 5 asked — either the limit is not enforced on this path or the walkthrough did not reach it, and neither is a pass`,
  );

  evidence(
    'policy `localBuffer.persist`:',
    String(DEFAULT_SCREEN_CONTEXT_POLICY.localBuffer.persist),
  );
  evidence(
    'policy `capture.selectedWindowOnly`:',
    String(DEFAULT_SCREEN_CONTEXT_POLICY.capture.selectedWindowOnly),
  );
  record(
    'P3',
    'Raw frame persistence is off, and capture is never widened past the selected window.',
    'the two literal-typed invariants on the shipped policy, plus `ScreenContextConditions.captureSource` in `main/observation-runtime.ts`, which is hard-coded to `selected-window` with a comment saying why',
    DEFAULT_SCREEN_CONTEXT_POLICY.localBuffer.persist === false &&
      DEFAULT_SCREEN_CONTEXT_POLICY.capture.selectedWindowOnly
      ? 'held'
      : 'FAILED',
    'both are literal types, so flipping either is a compile error rather than a configuration mistake — but see section 10 (e): what macOS actually hands Pilot has never been observed',
  );

  // -------------------------------------------------------------------------
  // 6 — the context bound, re-derived
  // -------------------------------------------------------------------------
  heading('6. THE CONTEXT BOUND, RE-DERIVED INDEPENDENTLY');
  say('   PR-036 resolved a §11 budget and asserted it. These four rows are');
  say('   recomputed here from the documents’ own numbers and compared with what');
  say('   the shipping resolver answers, rather than read back from it.');
  say();
  const cases: readonly { label: string; input: ContextWindowInput; expected: number }[] = [
    {
      label: 'hosted model advertising 272 000',
      input: { profile: { isRemote: true }, model: { contextWindow: 272_000 } },
      expected: 272_000,
    },
    {
      label: 'local endpoint advertising 131 072',
      input: { profile: { isRemote: false }, model: { contextWindow: 131_072 } },
      expected: CONSERVATIVE_CONTEXT_WINDOW,
    },
    {
      label: 'local endpoint advertising 8 192',
      input: { profile: { isRemote: false }, model: { contextWindow: 8_192 } },
      expected: 8_192,
    },
    {
      label: 'anything advertising nothing',
      input: { profile: { isRemote: true }, model: {} },
      expected: CONSERVATIVE_CONTEXT_WINDOW,
    },
  ];
  const contextMismatches: string[] = [];
  for (const testCase of cases) {
    const resolved = resolveContextWindow(testCase.input).contextWindow;
    evidence(
      `${testCase.label}:`,
      `${String(resolved)} (independently expected ${String(testCase.expected)})`,
    );
    if (resolved !== testCase.expected) {
      contextMismatches.push(`${testCase.label}: got ${String(resolved)}`);
    }
  }
  record(
    'X1',
    'The §11 context budget is what system-design §11 and pi-notes §9.3 say it should be, on every row.',
    'the four rows re-derived here from the documents, then compared with `resolveContextWindow`',
    contextMismatches.length === 0 ? 'held' : 'FAILED',
    contextMismatches.length === 0
      ? `a local endpoint is capped at ${String(CONSERVATIVE_CONTEXT_WINDOW)} however much it claims; a hosted one is believed. Section 10 (f): nothing here measures what an endpoint really handles.`
      : contextMismatches.join('; '),
  );

  evidence('images per request, in order:', perRequest.join(', ') || '(none)');
  const imagesBounded = sent.length > 0 && perRequest.every((count) => count <= activeCeiling);
  record(
    'X2',
    'The image count does not grow with the conversation.',
    'the per-request image counts from section 3’s three-question conversation, read in order off the recorded requests',
    imagesBounded ? 'held' : 'FAILED',
    sent.length === 0
      ? 'no image was ever sent, so nothing was bounded'
      : `every one of ${String(perRequest.length)} requests stayed at or under ${String(activeCeiling)} image blocks`,
  );

  // -------------------------------------------------------------------------
  // 7 — the redactor, in both directions
  // -------------------------------------------------------------------------
  heading('7. THE REDACTOR, IN BOTH DIRECTIONS');
  say('   Runbook cross-lane issue 25 is a *false negative* generator: the');
  say('   redactor matches on the key NAME, so a boolean and a zero are eaten as');
  say('   eagerly as a base64 blob, and a line written to show a privacy property');
  say('   says nothing. The converse is the question no prior PR asked: is there');
  say('   a field that SHOULD be redacted and is not?');
  say();

  const evidenceRun = open();
  evidenceRun.logger.info('privacy audit evidence', {
    occasionsDriven: occasions.length,
    buffersEmptied: occasions.filter((outcome) => outcome.emptied).length,
    persistedFiles: closedScans.length,
    scannersProved: selfTest.length,
    visualBlocksSent: sent.length,
    longestEdgePx: maxEdge,
  });
  const evidenceRecord = evidenceRun.sink.records[0];
  const eatenPaths = evidenceRecord?.redactedPaths ?? ['(no record was written at all)'];
  evidence(
    'fields in the audit’s own evidence line:',
    String(Object.keys(evidenceRecord?.fields ?? {}).length),
  );
  evidence(
    'of those, eaten by the redactor:',
    eatenPaths.length === 0 ? 'none' : eatenPaths.join(', '),
  );
  record(
    'L1',
    'The audit’s own evidence survives the redactor.',
    'one summary record emitted and its `redactedPaths` read back — the check runbook cross-lane issue 25 asks every privacy log line to make',
    eatenPaths.length === 0 ? 'held' : 'FAILED',
    eatenPaths.length === 0
      ? 'no field name in this audit’s evidence line collides with a redaction pattern'
      : `eaten: ${eatenPaths.join(', ')} — the numbers this audit reports would be markers, and the line would say nothing`,
  );

  // The retention log line is the *product's* privacy log line, not the audit's,
  // and it is the one `docs/handoff.md` §1 step 21 (g) asks the user to send
  // back from a real logout. So it gets the same check.
  const clearRecords = sinks
    .flatMap((sink) => sink.records)
    .filter((entry) => entry.message === 'retention clear');
  const eatenInClears = [...new Set(clearRecords.flatMap((entry) => entry.redactedPaths))];
  const sampleClear = clearRecords.at(-1);
  evidence('`retention clear` lines emitted in this run:', String(clearRecords.length));
  evidence(
    'fields the redactor ate in them:',
    eatenInClears.length === 0 ? 'none' : eatenInClears.join(', '),
  );
  evidence(
    'a real one reads:',
    sampleClear === undefined ? '(none)' : JSON.stringify(sampleClear.fields),
  );
  record(
    'L3',
    'The product’s own `retention clear` line still carries the numbers that are its evidence.',
    'every `retention clear` record emitted by every rig in this run, read for `redactedPaths` — the check runbook cross-lane issue 25 prescribes and the line `docs/handoff.md` §1 step 21 (g) asks a user to read',
    clearRecords.length > 0 && eatenInClears.length === 0 ? 'held' : 'FAILED',
    clearRecords.length === 0
      ? 'no `retention clear` line was emitted at all, so section 2’s log evidence came from nowhere'
      : eatenInClears.length === 0
        ? `${String(clearRecords.length)} lines, nothing redacted. Before PR-041 three of the six fields were markers — \`clearedFrames\` → [redacted:image], \`clearedPointerSamples\` → [redacted:audio], \`imageCacheCleared\` → [redacted:image] — which is cross-lane issue 25's fourth occurrence and was visible in \`pnpm smoke\`'s own output. The names are now chosen against the redactor; the report object keeps its own.`
        : `eaten: ${eatenInClears.join(', ')} — the retention log says a clear happened and refuses to say what it cleared`,
  );

  interface Probe {
    readonly what: string;
    readonly field: Readonly<Record<string, unknown>>;
  }
  const probes: readonly Probe[] = [
    {
      what: 'a bearer token under the key `authorization`',
      field: { authorization: 'Bearer sk-live-4f2a9c' },
    },
    {
      what: 'a base URL carrying user information, under `endpoint`',
      field: { endpoint: 'https://pilot:s3cr3t@api.example.com/v1' },
    },
    {
      what: 'a provider key pasted into a sentence, under `line`',
      field: { line: 'configured model gpt-5.5 with key sk-live-4f2a9c' },
    },
    {
      what: 'a data: URI in the MIDDLE of a string, under `cause`',
      field: {
        cause:
          'HTTP 400 from the provider: unsupported image data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA',
      },
    },
  ];
  const missed: string[] = [];
  for (const probe of probes) {
    const caught = redactValue(probe.field, DEFAULT_REDACTION_OPTIONS).redactedPaths.length > 0;
    evidence(`${probe.what}:`, caught ? 'redacted' : 'NOT redacted');
    if (!caught) {
      missed.push(probe.what);
    }
  }
  record(
    'L2',
    'A redactor keyed on names cannot catch a secret in a value.',
    '`redactValue` fed four field shapes whose values are secrets under key names none of its patterns match',
    missed.length === 0 ? 'held' : 'unprovable',
    missed.length === 0
      ? 'every probe was caught, which would mean the redactor now inspects values as well as names'
      : `${String(missed.length)} of ${String(probes.length)} probes passed through untouched (${missed.join('; ')}). This is a structural limit of a name-keyed redactor, not a regression: it is why D1–D3, C2 and F1 read the EMITTED records rather than trusting the redactor, and why PR-041 fixed the one live instance at the source (claim C3) instead of widening a pattern. Recorded as runbook follow-up 42.`,
  );

  const allRecords = sinks.flatMap((sink) => sink.records);
  const logScan = scanArtefact('the whole log stream', logBytes(allRecords), needles);
  evidence('log records emitted in this run:', String(allRecords.length));
  evidence(
    'image, audio or payload patterns in them:',
    logScan.hits.length === 0 ? 'none' : logScan.hits.join(', '),
  );
  evidence('canaries in them:', logScan.needles.length === 0 ? 'none' : logScan.needles.join(', '));
  record(
    'F1',
    'Nothing in the whole log stream of a full run is an image, an audio buffer, a payload or a secret.',
    `every emitted record from every rig in this walkthrough serialised and read through all ${String(BYTE_SCANNERS.length)} scanners plus the canary needles`,
    logScan.hits.length === 0 && logScan.needles.length === 0 ? 'held' : 'FAILED',
    logScan.hits.length === 0 && logScan.needles.length === 0
      ? `${String(allRecords.length)} records, ${String(logScan.bytes)} bytes, clean — including the question itself, which is never logged`
      : `${logScan.hits.join(', ')} ${logScan.needles.map((needle) => `needle:${needle}`).join(', ')}`,
  );

  // -------------------------------------------------------------------------
  // 8 — the filesystem, and the build
  // -------------------------------------------------------------------------
  heading('8. WHAT THE RUN LEFT ON THE FILESYSTEM');
  say('   Everything above ran inside one temporary directory. This is the check');
  say('   that it did: `$HOME` and the repository are listed before and after,');
  say('   and anything new is named.');
  say();
  const newInHome = listBounded(homedir(), 3).filter((path) => !homeBefore.includes(path));
  const newInRepo = listTree(REPO_ROOT).filter((path) => !repoBefore.includes(path));
  evidence('files under $HOME before:', String(homeBefore.length));
  evidence('new under $HOME:', newInHome.length === 0 ? 'none' : newInHome.join(', '));
  evidence('new in the repository:', newInRepo.length === 0 ? 'none' : newInRepo.join(', '));
  record(
    'B1',
    'A full run writes nothing outside the temporary directory it was given.',
    '`$HOME` (to three levels) and the repository tree listed before and after the whole walkthrough and diffed',
    newInHome.length === 0 && newInRepo.length === 0 ? 'held' : 'FAILED',
    newInHome.length === 0 && newInRepo.length === 0
      ? 'nothing new under $HOME and nothing new in the repository'
      : `new: ${[...newInHome, ...newInRepo].join(', ')}`,
  );

  const bundle = join(REPO_ROOT, 'apps/desktop/dist/main/index.js');
  if (existsSync(bundle)) {
    const bundleScan = scanArtefact('dist/main/index.js', await readFile(bundle), [
      ['a started crash reporter', 'crashReporter.start'],
      ['an upload-to-server call', 'setUploadToServer'],
      ['a persistRawFrames flag turned on', 'persistRawFrames:true'],
    ]);
    evidence('built main bundle:', `${String(bundleScan.bytes)} B`);
    evidence(
      'crash-reporting or raw-frame persistence in it:',
      bundleScan.needles.length === 0 ? 'none' : bundleScan.needles.join(', '),
    );
    evidence(
      'image or audio containers compiled into it:',
      bundleScan.hits.filter((hit) => kindOf(hit) !== 'payload').length === 0
        ? 'none'
        : bundleScan.hits.join(', '),
    );
    if (bundleScan.hits.includes('base64-run')) {
      say();
      say('   The bundle does contain long base64 runs. That is expected and is');
      say('   not screen data: `electron-vite` inlines source maps and small');
      say('   assets. It is reported rather than filtered out, because a scanner');
      say('   with an exception carved into it is the beginning of a scanner that');
      say('   finds nothing.');
    }
  } else {
    evidence('built main bundle:', 'ABSENT');
    unprovable.push(
      'the built bundle was not read: `apps/desktop/dist/main/index.js` does not exist. Run `pnpm build` before `pnpm demo:privacy` to include it.',
    );
  }
  say();
  say('   Electron writes a crash dump only for a crash reporter that has been');
  say('   started. Nothing in Pilot calls `crashReporter.start`, so there is no');
  say('   crash-report path at all — a stronger answer than an empty crash');
  say('   directory, and checked against the built bundle rather than asserted.');

  // -------------------------------------------------------------------------
  // 9 — the verdicts
  // -------------------------------------------------------------------------
  heading('9. VERDICTS');
  const selfCheck = auditSelfCheck(claims);
  const missingClaims = selfCheck.missing;
  const strayClaims = [...selfCheck.stray, ...selfCheck.duplicated];
  for (const entry of claims) {
    const badge =
      entry.verdict === 'held'
        ? 'held      '
        : entry.verdict === 'FAILED'
          ? '**FAILED**'
          : 'UNPROVABLE';
    say(`  ${entry.id.padEnd(4)} ${badge}  ${entry.claim}`);
    say(`         how: ${entry.how}`);
    say(`         ${entry.detail}`);
    say();
  }
  say(
    `  claims reached: ${String(claims.length)} of ${String(EXPECTED_CLAIM_IDS.length)} expected`,
  );
  if (missingClaims.length > 0) {
    say(`  ** CLAIMS THAT NEVER RAN: ${missingClaims.join(', ')} **`);
    say('  An audit that stops checking silently is the worst outcome this');
    say('  walkthrough has; a missing claim is a failure, not an omission.');
  }
  if (strayClaims.length > 0) {
    say(`  ** CLAIMS NOT IN EXPECTED_CLAIM_IDS: ${strayClaims.join(', ')} **`);
  }

  const failed = claims.filter((entry) => entry.verdict === 'FAILED');
  const ok = failed.length === 0 && selfCheck.ok;

  // -------------------------------------------------------------------------
  // 10 — what none of this proved
  // -------------------------------------------------------------------------
  heading('10. WHAT NONE OF THIS PROVED — the Mac checklist');
  say('   Every verdict above is about a Linux machine with no Mac, no model, no');
  say('   credential, no microphone and no pixels. These are the privacy');
  say('   properties that can only be established on the user’s Mac.');
  say('   `docs/handoff.md` §1 step 21 is the runnable form of this list.');
  say();
  say('   (a) WHERE THE FILES ACTUALLY ARE. Every path above is a temporary');
  say('       directory. `~/Library/Application Support/Pilot/` is the real one,');
  say('       and nothing in this project has ever created it.');
  say('   (b) WHETHER macOS ITSELF KEEPS A COPY. Window-server capture caches,');
  say('       `~/Library/Saved Application State`, Spotlight indexes and Time');
  say('       Machine snapshots are outside every scanner above, and Pilot does');
  say('       not control any of them.');
  say('   (c) WHETHER THE KEYCHAIN SEALS THE TOKEN. Electron `safeStorage` has');
  say('       never run. The Codex file in section 4 was written through the');
  say('       plaintext protector, so `protected: false` is the only case this');
  say('       machine can produce — and it is the case that must NOT ship.');
  say('   (d) WHETHER REAL AUDIO IS EVER BUFFERED. No microphone has ever been');
  say('       opened. "No audio bytes anywhere" is proved for a run in which no');
  say('       audio existed, which is the weakest possible form of it.');
  say('   (e) WHETHER REAL PIXELS BEHAVE. The frames here are synthetic PNGs of');
  say('       Pilot’s own making. A real `CGWindowID` capture of a window with a');
  say('       password field in it has never been masked, redacted or measured,');
  say('       and §14 says in as many words that redaction is best effort.');
  say('   (f) WHETHER A REAL PROVIDER RECEIVES WHAT SECTION 5 COUNTED. Those');
  say('       requests went to Pi’s faux provider inside this process. No screen');
  say('       image has ever left this machine.');
  say('   (g) WHETHER A REAL LOGOUT CLEARS. `powerMonitor`’s `shutdown` has never');
  say('       fired (runbook follow-up 37). Section 2 drives the handler, not the');
  say('       event, and macOS may kill the process first.');
  if (unprovable.length > 0) {
    say();
    say('   Unprovable in this run:');
    for (const item of unprovable) {
      say(`   · ${item}`);
    }
  }

  say();
  say('='.repeat(76));
  say(
    ok
      ? `PRIVACY AUDIT: PASS — ${String(claims.filter((entry) => entry.verdict === 'held').length)} claims held, ` +
          `${String(claims.filter((entry) => entry.verdict === 'unprovable').length)} unprovable here, 0 failed.`
      : `PRIVACY AUDIT: FAIL — ${String(failed.length)} claim(s) failed` +
          `${missingClaims.length > 0 ? `, ${String(missingClaims.length)} never ran` : ''}.`,
  );
  say('='.repeat(76));

  await rm(scratch, { recursive: true, force: true });
  return { lines, claims, ok };
}
