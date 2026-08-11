import { describe, expect, it } from 'vitest';
import {
  INTERACTION_STATES,
  type InteractionState,
  type PermissionSnapshot,
  type PermissionState,
} from '@pilot/shared';
import { FIXTURE_PERMISSIONS_GRANTED } from '@pilot/platform/fakes';
import {
  ALL_PERMISSIONS,
  INTERACTION_INPUT_TYPES,
  REQUIRED_PERMISSIONS,
  TRANSITION_REJECTION_REASONS,
  allTransitionCells,
  describeTransitionTable,
  isStaleRejection,
  lookupRule,
  permissionsSatisfied,
  resolveTarget,
  restingState,
} from '@pilot/interaction';
import { EXPECTED_TRANSITION_TABLE } from './transition-table.expected.js';
import { driveTo, representativeInput } from './support.js';

/**
 * The transition table is the specification, so these tests read it as data
 * rather than re-stating it in prose.
 */
describe('transition table', () => {
  it('answers every state x input pair', () => {
    const cells = allTransitionCells();
    expect(cells).toHaveLength(INTERACTION_STATES.length * INTERACTION_INPUT_TYPES.length);
    for (const cell of cells) {
      expect(cell.rule.kind, `${cell.from} + ${cell.input} has no rule`).toMatch(
        /^(accept|reject)$/,
      );
    }
  });

  it('matches the reviewed table, cell for cell', () => {
    expect(describeTransitionTable()).toEqual(EXPECTED_TRANSITION_TABLE);
  });

  it('only ever rejects with a declared reason', () => {
    for (const cell of allTransitionCells()) {
      if (cell.rule.kind === 'reject') {
        expect(TRANSITION_REJECTION_REASONS).toContain(cell.rule.reason);
        continue;
      }
      for (const reason of cell.rule.mayReject) {
        expect(TRANSITION_REJECTION_REASONS).toContain(reason);
      }
      expect(cell.rule.to.length).toBeGreaterThan(0);
    }
  });

  /**
   * The declared `to` list is documentation only if it is true. This drives the
   * machine into every state, feeds it every input, and checks that the state
   * it actually lands in was declared, and that any rejection was either
   * declared or an identity (stale) rejection.
   */
  it('never lands outside the targets its rule declares', () => {
    for (const state of INTERACTION_STATES) {
      for (const inputType of INTERACTION_INPUT_TYPES) {
        const harness = driveTo(state);
        const input = representativeInput(harness, inputType);
        const before = harness.machine.context;
        const rule = lookupRule(state, inputType);
        const outcome = harness.machine.send(input);
        const where = `${state} + ${inputType}`;

        if (outcome.kind === 'rejected') {
          const allowed =
            rule.kind === 'reject' ? [rule.reason] : [...rule.mayReject, 'illegal-transition'];
          expect(
            allowed.includes(outcome.rejection.reason) ||
              isStaleRejection(outcome.rejection.reason),
            `${where} rejected with undeclared reason "${outcome.rejection.reason}"`,
          ).toBe(true);
          continue;
        }

        expect(rule.kind, `${where} was accepted by a reject rule`).toBe('accept');
        if (rule.kind !== 'accept') {
          continue;
        }
        const declared = new Set<InteractionState>(
          rule.to.map((target) =>
            resolveTarget(target, { ...outcome.context, state: before.state }),
          ),
        );
        // `resting` must be resolved against the *patched* context too, since a
        // patch (pause, permissions, window selection) changes where rest is.
        for (const target of rule.to) {
          declared.add(resolveTarget(target, outcome.context));
        }
        expect(declared.has(outcome.to), `${where} landed in "${outcome.to}"`).toBe(true);
      }
    }
  });

  it('resolves the resting state by permission, then pause, then window', () => {
    const base = driveTo('observing').machine.context;
    expect(restingState(base)).toBe('observing');
    expect(restingState({ ...base, observationEnabled: false })).toBe('idle');
    expect(restingState({ ...base, paused: true })).toBe('paused');
    expect(restingState({ ...base, screenLocked: true })).toBe('paused');
    expect(restingState({ ...base, paused: true, permissions: null })).toBe('paused');
  });
});

/**
 * PR-044 — which permissions stop the machine, and which do not.
 *
 * `REQUIRED_PERMISSIONS` is the single definition of "Pilot cannot work at
 * all", and it is read by `restingState`, `permissionsSatisfied`,
 * `resolveTarget`, `InteractionMachine` and the `permissions-changed` row.
 * Narrowing it to Screen Recording alone is what closes runbook follow-up 35
 * (system-design §16), so the set itself is pinned here rather than inferred
 * from a state name three layers away.
 */
describe('required permissions (system-design §16)', () => {
  const withAccessibility = (state: PermissionState): PermissionSnapshot => ({
    ...FIXTURE_PERMISSIONS_GRANTED,
    accessibility: { kind: 'accessibility', state, canRequest: false },
  });

  it('requires Screen Recording, and only Screen Recording', () => {
    expect([...REQUIRED_PERMISSIONS]).toEqual(['screen-recording']);
    // The full onboarding set is still all four: degraded must not become "we
    // stopped asking" (PR-008/PR-009).
    expect([...ALL_PERMISSIONS]).toEqual([
      'screen-recording',
      'accessibility',
      'microphone',
      'speech-recognition',
    ]);
  });

  it('rests in `observing` with Accessibility refused, and stops without Screen Recording', () => {
    const base = driveTo('observing').machine.context;
    for (const state of ['denied', 'restricted', 'unknown'] as const) {
      expect(restingState({ ...base, permissions: withAccessibility(state) }), state).toBe(
        'observing',
      );
    }
    expect(
      restingState({
        ...base,
        permissions: {
          ...FIXTURE_PERMISSIONS_GRANTED,
          'screen-recording': { kind: 'screen-recording', state: 'denied', canRequest: false },
        },
      }),
    ).toBe('needs-permission');
  });

  it('leaves the voice permissions to the recogniser, not to the machine', () => {
    // §16 handles a failing recogniser with "offer text input", and the panel
    // reports `limited` readiness. Neither is a reason to refuse a typed
    // question, which is what `needs-permission` would do.
    const base = driveTo('observing').machine.context;
    expect(
      restingState({
        ...base,
        permissions: {
          ...FIXTURE_PERMISSIONS_GRANTED,
          microphone: { kind: 'microphone', state: 'denied', canRequest: false },
          'speech-recognition': {
            kind: 'speech-recognition',
            state: 'denied',
            canRequest: false,
          },
        },
      }),
    ).toBe('observing');
  });

  it('is still overridable, so a harness can require more or fewer', () => {
    const base = driveTo('observing').machine.context;
    expect(
      restingState({ ...base, permissions: withAccessibility('denied') }, ALL_PERMISSIONS),
    ).toBe('needs-permission');
    expect(restingState({ ...base, permissions: withAccessibility('denied') }, [])).toBe(
      'observing',
    );
  });

  it('agrees with `permissionsSatisfied`, which every caller shares', () => {
    expect(permissionsSatisfied(withAccessibility('denied'))).toBe(true);
    expect(permissionsSatisfied(withAccessibility('denied'), ALL_PERMISSIONS)).toBe(false);
    // An unknown snapshot never blocks: the platform publishes as soon as it
    // knows, and refusing in the meantime is hazard 22's bug.
    expect(permissionsSatisfied(null)).toBe(true);
  });
});
