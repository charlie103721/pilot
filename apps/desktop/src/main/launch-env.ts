import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The launch environment file (PR-042).
 *
 * ## The problem it exists for
 *
 * Pilot chooses its model provider from `process.env`, and only from there:
 * `PILOT_MODEL_PROFILE=codex` (PR-037), `PILOT_MODEL_PROFILE=api-key`
 * (PR-038), `PILOT_LOCAL_BASE_URL` (PR-039). A double-clicked `.app` inherits
 * **none** of it — Finder launches through `launchd`, not through a shell, so
 * there is no `~/.zshrc`, no `export`, and nothing Pilot can read. Every one of
 * those selectors is therefore unreachable from the only way a user actually
 * starts a packaged Mac app, and the `??` chain in `main/index.ts` falls all
 * the way through to Pi's faux provider — which answers questions, has no
 * network, and **is not a language model**.
 *
 * That is the worst failure shape this project has a name for: the app starts,
 * looks right, answers, and is wrong. It is hazard 19's shape one level up.
 *
 * ## What this does about it
 *
 * A plain `KEY=value` file in the app's own data directory, read once at
 * startup, filling in **only variables that are absent** from the real
 * environment. A real environment always wins, so `pnpm dev`, every demo and
 * every test are unaffected by a file that happens to exist.
 *
 * ## What it will not carry, and why
 *
 * {@link LAUNCH_ENV_ALLOWED} is an allowlist, not a filter, and
 * `PILOT_API_KEY` is deliberately **not** in it. PR-038's whole property is
 * that the key is sealed through `safeStorage` and removed from `process.env`
 * before anything can inherit it; honouring it here would put the same secret
 * in a plaintext file in the same directory, which is a privacy regression
 * dressed as a convenience. A refused key is *reported*, not ignored — see
 * {@link LaunchEnvResult.refused} — because silently dropping it would look
 * exactly like a typo.
 *
 * Nothing here can make Pilot do something an environment variable could not
 * already make it do; it is a second, terminal-free way to set the same
 * variables.
 */

/** File name, inside `app.getPath('userData')`. */
export const LAUNCH_ENV_FILE = 'pilot.env';

/**
 * Variables a launch file may set.
 *
 * Every entry is a *selector* or a *diagnostic* — something the user would
 * otherwise have to put in front of a shell command. Secrets are not here on
 * purpose (see the note above), and neither are the fixture switches
 * (`PILOT_*_FIXTURE`, `PILOT_HELPER_STUB*`, `PILOT_PLATFORM`): those exist to
 * make development states reachable, and a file that could flip a shipped app
 * onto fake adapters is a support problem, not a feature.
 */
export const LAUNCH_ENV_ALLOWED: readonly string[] = [
  'PILOT_MODEL_PROFILE',
  'PILOT_CODEX_MODEL',
  'PILOT_API_KEY_PROVIDER',
  'PILOT_API_KEY_MODEL',
  'PILOT_LOCAL_BASE_URL',
  'PILOT_LOCAL_MODEL',
  'PILOT_LOCAL_VISION_COMPREHENSION',
  'PILOT_CONTEXT_WINDOW',
  'PILOT_HELPER_BINARY',
  'PILOT_LOG_LEVEL',
];

/** Named so the refusal can say *why*, rather than "unknown key". */
export const LAUNCH_ENV_REFUSED_SECRETS: readonly string[] = ['PILOT_API_KEY'];

export interface LaunchEnvResult {
  /** Absolute path that was read, whether or not it existed. */
  readonly path: string;
  /** `false` when there is no file — the normal case, and not a problem. */
  readonly present: boolean;
  /** Names applied to the environment, in file order. */
  readonly applied: readonly string[];
  /** `name: reason` for every line that was understood but not applied. */
  readonly refused: readonly { readonly name: string; readonly reason: string }[];
  /** Parse problems, by 1-based line number. Never throws; always reports. */
  readonly problems: readonly string[];
}

export interface ReadLaunchEnvOptions {
  /** `app.getPath('userData')`. */
  readonly userDataPath: string;
  /** Defaults to reading the file; injected by tests. */
  readonly read?: (path: string) => string | null;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Strips one layer of matching quotes; leaves everything else alone. */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Parses a launch file without touching the environment.
 *
 * Exported separately from {@link applyLaunchEnv} so the parse can be tested,
 * and printed, without a process to mutate.
 */
export function parseLaunchEnv(
  contents: string,
  env: Readonly<Record<string, string | undefined>>,
): Omit<LaunchEnvResult, 'path' | 'present'> {
  const applied: string[] = [];
  const refused: { name: string; reason: string }[] = [];
  const problems: string[] = [];

  contents.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      return;
    }
    const match = LINE.exec(line);
    if (match === null || match[1] === undefined) {
      problems.push(`line ${String(lineNumber)}: not a NAME=value assignment`);
      return;
    }
    const name = match[1];
    if (LAUNCH_ENV_REFUSED_SECRETS.includes(name)) {
      refused.push({
        name,
        reason:
          'a credential must not sit in a plaintext file; set it once with ' +
          `${name}=… on a terminal launch and Pilot seals it in the keychain`,
      });
      return;
    }
    if (!LAUNCH_ENV_ALLOWED.includes(name)) {
      refused.push({ name, reason: 'not one of the variables a launch file may set' });
      return;
    }
    const existing = env[name];
    if (existing !== undefined && existing !== '') {
      refused.push({ name, reason: 'already set in the real environment, which wins' });
      return;
    }
    if (applied.includes(name)) {
      refused.push({ name, reason: 'set by an earlier line in this file, which wins' });
      return;
    }
    applied.push(name);
  });

  return { applied, refused, problems };
}

/**
 * Reads the launch file and fills in the absent variables.
 *
 * Total: a missing file, an unreadable file and a malformed line are all
 * reported through the result rather than thrown. Startup must not depend on
 * this succeeding.
 */
export function applyLaunchEnv(
  options: ReadLaunchEnvOptions,
  env: Record<string, string | undefined>,
): LaunchEnvResult {
  const path = join(options.userDataPath, LAUNCH_ENV_FILE);
  const read = options.read ?? ((target: string): string => readFileSync(target, 'utf8'));

  // The `catch` is the whole contract: an absent file, a directory where the
  // file should be, a permissions problem and a full disk all mean "no launch
  // file", and none of them may stop the app from starting.
  let contents: string | null;
  try {
    contents = read(path);
  } catch {
    contents = null;
  }
  if (contents === null) {
    return { path, present: false, applied: [], refused: [], problems: [] };
  }

  const parsed = parseLaunchEnv(contents, env);
  // Second pass, over the same lines, assigning only what the parse approved.
  // Kept separate so the decision and the mutation cannot disagree.
  const approved = new Set(parsed.applied);
  for (const line of contents.split(/\r?\n/)) {
    const match = LINE.exec(line);
    const name = match?.[1];
    if (name !== undefined && approved.has(name) && match?.[2] !== undefined) {
      env[name] = unquote(match[2]);
      // First occurrence wins, matching the parse's own refusal of the rest.
      approved.delete(name);
    }
  }

  return { path, present: true, ...parsed };
}
