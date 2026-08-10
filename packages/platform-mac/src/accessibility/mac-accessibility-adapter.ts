import {
  nullLogger,
  type AccessibilityNode,
  type Logger,
  type ScreenPoint,
  type WindowId,
} from '@pilot/shared';
import type {
  AccessibilityAdapter,
  AccessibilityAvailability,
  AccessibilityGroundingTarget,
  PointerGroundingSample,
} from '@pilot/platform';
import {
  accessibilityElementAtOperation,
  accessibilitySampleOperation,
  type AccessibilityElement,
  type ElementOutcome,
} from '../protocol/accessibility-ops.js';
import type { NativeHelperTransport } from '../transport/helper-transport.js';
import { groundPointer, shouldHitTest, toAccessibilityNode } from './pointer-grounding.js';

/**
 * macOS `AccessibilityAdapter` (system-design §5), backed by the native helper.
 *
 * Three things this adapter is responsible for, beyond forwarding calls:
 *
 * 1. **Degraded, not dead.** A denied Accessibility permission is a degraded
 *    mode (system-design §16, and PR-008's onboarding UI already models it that
 *    way). `ground()` keeps answering with a pointer position and reports
 *    `degraded: true` with `targetOutcome: 'accessibility-denied'`. Nothing
 *    throws, because a thrown error here would stop question anchoring
 *    altogether — and the pointer position alone is still useful grounding.
 * 2. **No hit test outside the window.** The decision is taken *before* the
 *    round trip (`shouldHitTest`), so when the pointer is elsewhere the helper
 *    is never asked what is under it. See `pointer-grounding.ts`.
 * 3. **Values are opt-in.** `AXValue` is not read unless
 *    `includeElementValues` is set. The secure-field flag that would otherwise
 *    protect it is best effort (system-design §14), so the default is to carry
 *    what an element *is*, never what it says.
 *
 * Trust state is cached: `AXIsProcessTrusted()` costs a round trip and cannot
 * change without the user visiting System Settings, which the permission
 * adapter's polling already observes. {@link refreshAvailability} discards it.
 */

export interface MacAccessibilityAdapterOptions {
  readonly transport: NativeHelperTransport;
  /**
   * Read `AXValue` for non-secure elements. Off by default (system-design §14):
   * a value is arbitrary screen content, and the flag that keeps a password out
   * of it is best effort.
   */
  readonly includeElementValues?: boolean;
  /**
   * Confine hit testing to the selected window's application. Defaults to true;
   * only set false to reproduce the system-wide behaviour in a test.
   */
  readonly scopeToOwningApplication?: boolean;
  readonly logger?: Logger;
  /** Injected clock. Every timestamp on a sample comes from here. */
  readonly clock?: () => number;
}

export class MacAccessibilityAdapter implements AccessibilityAdapter {
  readonly #transport: NativeHelperTransport;
  readonly #logger: Logger;
  readonly #clock: () => number;
  readonly #includeValues: boolean;
  readonly #scopeToOwner: boolean;

  readonly #insideByWindow = new Map<WindowId, boolean>();

  #trusted: boolean | undefined;

  constructor(options: MacAccessibilityAdapterOptions) {
    this.#transport = options.transport;
    this.#logger = (options.logger ?? nullLogger).child('mac-accessibility');
    this.#clock = options.clock ?? (() => Date.now());
    this.#includeValues = options.includeElementValues ?? false;
    this.#scopeToOwner = options.scopeToOwningApplication ?? true;
  }

  /** Last observed trust state, or `undefined` before the first call. */
  get lastTrusted(): boolean | undefined {
    return this.#trusted;
  }

  async getPointer(): Promise<ScreenPoint> {
    const response = await this.#transport.request(accessibilitySampleOperation, {});
    this.#note(response.payload.axTrusted);
    return { x: response.payload.point.x, y: response.payload.point.y };
  }

  /**
   * `AccessibilityAdapter.elementAt`, verbatim from system-design §5: the
   * element at an arbitrary screen point, with no window in the picture.
   *
   * This is the unscoped form and it is deliberately *not* what grounding uses.
   * Callers grounding a question must use {@link ground}, which knows which
   * window is selected and refuses to look outside it.
   */
  async elementAt(point: ScreenPoint): Promise<AccessibilityNode | null> {
    const response = await this.#transport.request(accessibilityElementAtOperation, {
      point: { x: point.x, y: point.y },
      includeValue: this.#includeValues,
    });
    this.#note(response.payload.axTrusted);
    return this.#nodeFrom(response.payload.element, response.payload.outcome);
  }

  async availability(): Promise<AccessibilityAvailability> {
    const trusted = this.#trusted ?? (await this.#probeTrust());
    return {
      trusted,
      // The pointer comes from `CGEvent(source: nil)?.location`, which needs no
      // grant. That asymmetry is the whole reason degraded mode exists.
      pointer: true,
      hitTesting: trusted,
      degraded: !trusted,
    };
  }

  /** Discards the cached trust state and probes again. */
  async refreshAvailability(): Promise<AccessibilityAvailability> {
    this.#trusted = undefined;
    return this.availability();
  }

  /**
   * Reads the pointer and grounds it against the selected window.
   *
   * Two round trips when the pointer is inside the window and **one** when it
   * is outside, because the decision not to hit-test is taken here, before the
   * second request exists. That is the strict form of the outside-window rule
   * and the reason this — not `groundFast` — is what question anchoring uses.
   */
  async ground(target: AccessibilityGroundingTarget): Promise<PointerGroundingSample> {
    const position = await this.#transport.request(accessibilitySampleOperation, {});
    this.#note(position.payload.axTrusted);
    const screenPoint = { x: position.payload.point.x, y: position.payload.point.y };
    const at = this.#clock();

    if (!shouldHitTest(screenPoint, target.geometry)) {
      // Defence 1: no hit test is issued at all. Whatever is under the pointer
      // belongs to a window Pilot is not observing.
      return groundPointer({
        at,
        screenPoint,
        target,
        elementOutcome: 'not-requested',
        axTrusted: position.payload.axTrusted,
      });
    }

    if (!position.payload.axTrusted) {
      return groundPointer({
        at,
        screenPoint,
        target,
        elementOutcome: 'not-trusted',
        axTrusted: false,
      });
    }

    const hit = await this.#transport.request(accessibilityElementAtOperation, {
      point: screenPoint,
      includeValue: this.#includeValues,
      ...this.#scope(target),
    });
    this.#note(hit.payload.axTrusted);
    return groundPointer({
      at,
      screenPoint,
      target,
      element: hit.payload.element,
      elementOutcome: hit.payload.outcome,
      axTrusted: hit.payload.axTrusted,
    });
  }

  /**
   * Reads the pointer and hit-tests it in a **single** round trip.
   *
   * Used by `PointerSampler` on the ~30 Hz path (system-design §17), where the
   * two-request form would be sixty round trips a second through a
   * single-threaded stdio loop, and where the position and the element would be
   * read at different instants.
   *
   * The cost of atomicity is that the helper must be told whether to hit-test
   * *before* the position is known. So the decision is made from the previous
   * sample for the same window:
   *
   * | Previous sample | Requests | Hit test issued |
   * | --- | --- | --- |
   * | inside, or none yet | 1 | yes |
   * | outside | 1 | **no** |
   * | outside → now inside | 2 | yes, scoped, after the position is known |
   *
   * So a pointer resting outside the selected window issues no hit test at all,
   * and the one crossing sample that does is scoped to the selected window's
   * own application and has its element discarded by `groundPointer` before any
   * consumer sees it. The strict single-sample guarantee — never ask — is
   * {@link ground}, which is what question anchoring uses.
   */
  async groundFast(target: AccessibilityGroundingTarget): Promise<PointerGroundingSample> {
    const windowId = target.geometry.windowId;
    const wasInside = this.#insideByWindow.get(windowId) ?? true;
    const includeElement = wasInside && this.#trusted !== false;

    const response = await this.#transport.request(accessibilitySampleOperation, {
      includeElement,
      includeValue: this.#includeValues,
      ...this.#scope(target),
    });
    this.#note(response.payload.axTrusted);

    const at = this.#clock();
    const screenPoint = { x: response.payload.point.x, y: response.payload.point.y };
    const inside = shouldHitTest(screenPoint, target.geometry);
    this.#insideByWindow.set(windowId, inside);

    if (inside && !includeElement && this.#trusted !== false) {
      // The pointer has crossed back in. One follow-up round trip, once.
      const hit = await this.#transport.request(accessibilityElementAtOperation, {
        point: screenPoint,
        includeValue: this.#includeValues,
        ...this.#scope(target),
      });
      this.#note(hit.payload.axTrusted);
      return groundPointer({
        at,
        screenPoint,
        target,
        element: hit.payload.element,
        elementOutcome: hit.payload.outcome,
        axTrusted: hit.payload.axTrusted,
      });
    }

    return groundPointer({
      at,
      screenPoint,
      target,
      element: response.payload.element,
      elementOutcome: includeElement ? response.payload.outcome : 'not-requested',
      axTrusted: response.payload.axTrusted,
    });
  }

  /** Forgets which side of the border each window's pointer was last on. */
  resetGroundingState(): void {
    this.#insideByWindow.clear();
  }

  // -------------------------------------------------------------------------

  /** The `ownerPid` argument that confines a hit test to one application. */
  #scope(target: AccessibilityGroundingTarget): { ownerPid?: number } {
    return this.#scopeToOwner && target.ownerPid !== undefined ? { ownerPid: target.ownerPid } : {};
  }

  #nodeFrom(
    element: AccessibilityElement | null,
    outcome: ElementOutcome,
  ): AccessibilityNode | null {
    if (outcome !== 'reported' || element === null) {
      return null;
    }
    return toAccessibilityNode(element);
  }

  async #probeTrust(): Promise<boolean> {
    const response = await this.#transport.request(accessibilitySampleOperation, {});
    this.#note(response.payload.axTrusted);
    return response.payload.axTrusted;
  }

  #note(trusted: boolean): void {
    if (this.#trusted === trusted) {
      return;
    }
    const first = this.#trusted === undefined;
    this.#trusted = trusted;
    if (trusted) {
      this.#logger.info('accessibility hit testing is available');
    } else {
      this.#logger.warn(
        first
          ? 'accessibility is not granted; grounding runs on pointer position only'
          : 'accessibility was revoked; grounding degraded to pointer position only',
      );
    }
  }
}
