/**
 * PR-043 — the verdict model for the acceptance suite.
 *
 * `docs/mvp-01-point-ask-hear.md` §18 is a table of fifteen scenarios and their
 * pass conditions. §19 turns it into a release gate ("all acceptance tests
 * pass"). Nothing in this repository can honestly satisfy that gate: there is
 * no macOS, no model, no microphone, no speaker and no screen (runbook §5
 * amendment 8). So the deliverable is not a pass/fail run — it is a *structure*
 * that says, per criterion and re-runnably, which of that criterion's claims
 * have actually been executed here, which are waiting on a Mac, which are
 * waiting on a model, and which are not built at all.
 *
 * ## The rule this file exists for
 *
 * **A criterion with no executed evidence cannot report as passing.** That is
 * the failure mode a hand-written acceptance table has, and it is the one the
 * plan's "90% grounding accuracy" invites: a number computed against a scripted
 * provider measures the script. So a verdict here is never written down. It is
 * *derived* from the checks that ran, by {@link acceptanceVerdict}, under rules
 * that make `verified` unreachable without executed pass-condition checks, and
 * that make an evidence-free check impossible to construct at all —
 * {@link executed} throws on empty evidence and {@link pending} throws on an
 * empty reason.
 *
 * ## Pass conditions versus supporting evidence
 *
 * §18's pass condition is the sentence in the right-hand column and nothing
 * else. A check tagged {@link CheckKind} `pass-condition` is part of deciding
 * that sentence; a check tagged `supporting` is evidence a reader wants but
 * which does not by itself decide the row. The distinction is load-bearing:
 * A-02's pass condition is "Answer identifies or explains the marked target",
 * which needs a model, and no amount of input-side evidence — that the right
 * crop, the right role and the right label reached the provider — can turn that
 * row green. Supporting checks are printed; they never lift a verdict.
 *
 * The result is deliberately harder to make look good than the prose verdict
 * `docs/handoff.md` carries from PR-034. Where the two disagree, the reason is
 * always that this suite runs a scenario per criterion instead of reading one
 * trace, never that a rule was relaxed.
 */

/** Why a check could not be executed on this machine. */
export type Blocker =
  /** Needs macOS: a real window server, TCC, a key, a microphone, a speaker. */
  | 'mac'
  /** Needs a real language model, which no provider in this repository is. */
  | 'model'
  /** Needs both, and a Mac first. */
  | 'mac-and-model';

/** What a check contributes to. See the file comment. */
export type CheckKind = 'pass-condition' | 'supporting';

/** A check that ran here, on the shipping objects, and produced a result. */
export interface ExecutedCheck {
  readonly state: 'executed';
  readonly kind: CheckKind;
  readonly claim: string;
  readonly passed: boolean;
  /** What was read, in concrete terms. Never empty — {@link executed} refuses. */
  readonly evidence: string;
}

/** A check that could not run here, with the concrete reason it could not. */
export interface PendingCheck {
  readonly state: 'pending';
  readonly kind: CheckKind;
  readonly claim: string;
  readonly blocker: Blocker;
  /** What would have to happen, and where the procedure is. Never empty. */
  readonly reason: string;
}

export type Check = ExecutedCheck | PendingCheck;

/**
 * The closed set of verdicts.
 *
 * Ordered from most to least evidence, which is the order the distribution
 * prints in.
 */
export const VERDICTS = [
  'verified',
  'verified-in-part',
  'failed',
  'blocked-on-mac',
  'blocked-on-model',
  'not-implemented',
] as const;

export type Verdict = (typeof VERDICTS)[number];

/** One row of §18, with everything that was read for it. */
export interface CriterionResult {
  readonly id: string;
  readonly scenario: string;
  /** §18's pass condition, verbatim. */
  readonly passCondition: string;
  readonly verdict: Verdict;
  readonly checks: readonly Check[];
  /** One line saying why the verdict is what it is. Derived, never written. */
  readonly summary: string;
}

/**
 * Builds an executed check.
 *
 * Throws on empty evidence rather than recording an unfalsifiable claim: "this
 * passed" with nothing beside it is exactly the shape a reader cannot check,
 * and a suite that permits it is a suite whose green rows mean nothing.
 */
export function executed(
  kind: CheckKind,
  claim: string,
  passed: boolean,
  evidence: string,
): ExecutedCheck {
  if (claim.trim() === '') {
    throw new Error('an executed check needs a claim');
  }
  if (evidence.trim() === '') {
    throw new Error(`an executed check needs evidence: ${claim}`);
  }
  return { state: 'executed', kind, claim, passed, evidence };
}

/** Builds a pending check. Throws on an empty reason, for the same cause. */
export function pending(
  kind: CheckKind,
  claim: string,
  blocker: Blocker,
  reason: string,
): PendingCheck {
  if (claim.trim() === '') {
    throw new Error('a pending check needs a claim');
  }
  if (reason.trim() === '') {
    throw new Error(`a pending check needs a reason: ${claim}`);
  }
  return { state: 'pending', kind, claim, blocker, reason };
}

function isPassCondition(check: Check): boolean {
  return check.kind === 'pass-condition';
}

/**
 * The dominant blocker across a set of pending checks.
 *
 * A Mac outranks a model, and not arbitrarily: every model-side question in
 * §18 is asked *about a real screen*, so a model alone would not close a row
 * that also needs pixels. `mac-and-model` therefore reports as `mac`.
 */
function dominantBlocker(checks: readonly PendingCheck[]): 'mac' | 'model' {
  return checks.some((check) => check.blocker !== 'model') ? 'mac' : 'model';
}

/**
 * Derives the verdict from the checks. **This is the whole honesty mechanism.**
 *
 * In order, and the order matters:
 *
 * 1. No pass-condition checks at all → `not-implemented`. A criterion nobody
 *    wrote a check for is not a criterion that passed. Supporting checks cannot
 *    rescue it: a row with five supporting greens and no pass condition is a row
 *    where nothing about §18's sentence was tested.
 * 2. Any executed check failed → `failed`, whether it was a pass condition or
 *    supporting evidence. A suite that hides a red supporting check is choosing
 *    what to notice.
 * 3. No pass-condition check *executed* → `blocked-on-mac`/`blocked-on-model`.
 *    This is the case supporting evidence is most tempting to launder, and the
 *    one where laundering does the most damage.
 * 4. Every pass-condition check executed and passed → `verified`.
 * 5. Otherwise — some executed and passed, some pending → `verified-in-part`.
 */
export function acceptanceVerdict(checks: readonly Check[]): Verdict {
  const passConditions = checks.filter(isPassCondition);
  if (passConditions.length === 0) {
    return 'not-implemented';
  }
  if (checks.some((check) => check.state === 'executed' && !check.passed)) {
    return 'failed';
  }
  const ran = passConditions.filter((check): check is ExecutedCheck => check.state === 'executed');
  const waiting = passConditions.filter(
    (check): check is PendingCheck => check.state === 'pending',
  );
  if (ran.length === 0) {
    return dominantBlocker(waiting) === 'mac' ? 'blocked-on-mac' : 'blocked-on-model';
  }
  if (waiting.length === 0) {
    return 'verified';
  }
  return 'verified-in-part';
}

function summarise(verdict: Verdict, checks: readonly Check[]): string {
  const passConditions = checks.filter(isPassCondition);
  const ran = passConditions.filter((check) => check.state === 'executed').length;
  const waiting = passConditions.filter((check) => check.state === 'pending').length;
  const failures = checks.filter((check) => check.state === 'executed' && !check.passed);
  switch (verdict) {
    case 'not-implemented':
      return 'no pass-condition check exists for this row';
    case 'failed':
      return `${String(failures.length)} executed check(s) did not hold: ${failures
        .map((check) => check.claim)
        .join('; ')}`;
    case 'blocked-on-mac':
    case 'blocked-on-model':
      return `${String(waiting)} pass-condition check(s), none of which can run here`;
    case 'verified':
      return `${String(ran)} pass-condition check(s), all executed here and all held`;
    case 'verified-in-part':
      return `${String(ran)} of ${String(ran + waiting)} pass-condition check(s) executed here`;
  }
}

/** Assembles a criterion result. The verdict is derived; the caller cannot set it. */
export function criterion(input: {
  readonly id: string;
  readonly scenario: string;
  readonly passCondition: string;
  readonly checks: readonly Check[];
}): CriterionResult {
  const verdict = acceptanceVerdict(input.checks);
  return {
    id: input.id,
    scenario: input.scenario,
    passCondition: input.passCondition,
    verdict,
    checks: input.checks,
    summary: summarise(verdict, input.checks),
  };
}

export type VerdictDistribution = Readonly<Record<Verdict, number>>;

export function distribution(results: readonly CriterionResult[]): VerdictDistribution {
  const counts: Record<Verdict, number> = {
    verified: 0,
    'verified-in-part': 0,
    failed: 0,
    'blocked-on-mac': 0,
    'blocked-on-model': 0,
    'not-implemented': 0,
  };
  for (const result of results) {
    counts[result.verdict] += 1;
  }
  return counts;
}

export interface CheckTally {
  readonly total: number;
  readonly executed: number;
  readonly pendingMac: number;
  readonly pendingModel: number;
  readonly pendingBoth: number;
}

/**
 * Pass-condition checks across every criterion, by state.
 *
 * A better measure of what is left than the row counts are: a row reads
 * `verified-in-part` whether one claim of five is pending or four are, and the
 * distinction is the whole of how much work a Mac would close.
 */
export function passConditionTally(results: readonly CriterionResult[]): CheckTally {
  const checks = results.flatMap((result) => result.checks).filter(isPassCondition);
  const waiting = checks.filter((check): check is PendingCheck => check.state === 'pending');
  return {
    total: checks.length,
    executed: checks.length - waiting.length,
    pendingMac: waiting.filter((check) => check.blocker === 'mac').length,
    pendingModel: waiting.filter((check) => check.blocker === 'model').length,
    pendingBoth: waiting.filter((check) => check.blocker === 'mac-and-model').length,
  };
}

const BLOCKER_WORDS: Readonly<Record<Blocker, string>> = {
  mac: 'a Mac',
  model: 'a real model',
  'mac-and-model': 'a Mac and a model',
};

/** Blocked rows and what each is waiting on, for the headline. */
export function blockedRows(
  results: readonly CriterionResult[],
): readonly { readonly id: string; readonly blockers: string }[] {
  return results
    .filter(
      (result) => result.verdict === 'blocked-on-mac' || result.verdict === 'blocked-on-model',
    )
    .map((result) => {
      const blockers = [
        ...new Set(
          result.checks
            .filter((check): check is PendingCheck => check.state === 'pending')
            .filter(isPassCondition)
            .map((check) => check.blocker),
        ),
      ];
      return {
        id: result.id,
        blockers: blockers.map((blocker) => BLOCKER_WORDS[blocker]).join(' + '),
      };
    });
}

/**
 * The sentence that goes at the very top of the output.
 *
 * Written so that it cannot be skimmed into good news: the count of fully
 * verified rows comes first, and the word "blocked" appears before any number
 * a reader might mistake for a score.
 */
export function headline(results: readonly CriterionResult[]): string {
  const counts = distribution(results);
  const blocked = counts['blocked-on-mac'] + counts['blocked-on-model'];
  return (
    `${String(counts.verified)} of ${String(results.length)} acceptance criteria are ` +
    `verified here; ${String(blocked)} are blocked ` +
    `(${String(counts['blocked-on-mac'])} on a Mac, ` +
    `${String(counts['blocked-on-model'])} on a real model), ` +
    `${String(counts['verified-in-part'])} are verified in part, ` +
    `${String(counts.failed)} failed, ` +
    `${String(counts['not-implemented'])} have no check.`
  );
}
