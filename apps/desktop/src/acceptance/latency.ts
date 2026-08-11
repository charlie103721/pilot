import { createScriptedModelSource } from '@pilot/agent';
import { MVP_SCREEN_POLICY, type Logger } from '@pilot/shared';
import { buildFrame, openAcceptanceRig } from './rig-support.js';

/**
 * PR-043 — the latency spot checks, against `docs/system-design.md` §17.
 *
 * §17 lists six budgets and eight metrics. **Two of the budgets have a half that
 * has never run on any machine**, and the honest thing is to report the half
 * that is measurable *as a half* rather than as the whole:
 *
 *  - "Image preprocessing: target below 150 ms per observation on supported
 *    Macs" is fully measurable here in the sense that every line of the pipeline
 *    is the shipping one — it really decodes a PNG, really crops, really
 *    resizes, really re-encodes. What is not real is the subject (a synthetic
 *    screenshot, not a ScreenCaptureKit surface) and the machine (an idle Linux
 *    box, not a Mac).
 *  - "TTS interruption: target below 300 ms" is measurable only up to the pipe.
 *    Pilot's half is the time from the command being dispatched to
 *    `speech.output.stop` crossing the framed stdio protocol. The rest of the
 *    budget is `AVSpeechSynthesizer.stopSpeaking` and the audio device, and
 *    **nothing in this project has ever made a sound**.
 *
 * Two more §17 metrics are not measured at all and say so: time to first model
 * token (there is no model) and time to first spoken sentence (there is no
 * speaker). Two are policy constants rather than measurements — sample FPS and
 * pointer sample rate — and reporting a measured value for a constant would be
 * a way of pretending a scheduler had been observed.
 */

export interface LatencySample {
  readonly what: string;
  /** The §17 budget this is against, or `null` when §17 lists it as a metric. */
  readonly budgetMs: number | null;
  readonly samplesMs: readonly number[];
  readonly caveat: string;
}

export interface LatencyReport {
  readonly measured: readonly LatencySample[];
  readonly notMeasured: readonly { readonly what: string; readonly why: string }[];
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

/**
 * Times the §10 pipeline on the object the `observe_screen` tool drives.
 *
 * `PilotScreenContextService.observeDetailed` is the same call the tool makes,
 * so this is the pipeline and not a re-implementation of it. The model is left
 * out on purpose: a number that included Pi's faux provider would be measuring
 * a `tokensPerSecond` constant this file chose.
 */
export async function measureImagePreprocessing(options: {
  readonly logger: Logger;
  readonly rounds?: number;
}): Promise<{ readonly sample: LatencySample; readonly ageMs: LatencySample }> {
  const rounds = options.rounds ?? 5;
  const model = createScriptedModelSource({ script: [{ say: '…' }] });
  const opened = await openAcceptanceRig({
    scaleFactor: 2,
    stub: { pointer: { x: 700, y: 480 } },
    rig: { modelSource: model, logger: options.logger },
  });
  const { rig, window, captureSize } = opened;
  const durations: number[] = [];
  const ages: number[] = [];
  try {
    for (let round = 0; round < rounds; round += 1) {
      // Out of the §10 rate window, which is two observations per second.
      await new Promise((resolve) => setTimeout(resolve, 600));
      rig.observation.session.ingestFrame(
        await buildFrame(window, {
          id: `latency-${String(round)}`,
          capturedAt: Date.now(),
          size: captureSize,
          scaleFactor: 2,
          toggleOn: round % 2 === 0,
        }),
      );
      await rig.observation.samplePointer();
      const startedAt = process.hrtime.bigint();
      const result = await rig.observation.screenContext.observeDetailed({
        view: 'both',
        moment: 'question',
      });
      durations.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
      ages.push(result.metadata.frames[0]?.ageMs ?? Number.NaN);
    }
  } finally {
    await rig.dispose();
  }
  return {
    sample: {
      what: 'image preprocessing, per observation (decode → crop → resize → encode → two images)',
      budgetMs: 150,
      samplesMs: durations,
      caveat:
        `real pipeline, real bytes: a ${String(captureSize.width)}×${String(captureSize.height)} ` +
        `PNG decoded, cropped to ${String(MVP_SCREEN_POLICY.pointerCropPixels)} px and ` +
        `re-encoded twice. The subject is a synthetic screenshot and the machine is an ` +
        `idle Linux box, not a Mac with a ScreenCaptureKit surface.`,
    },
    ageMs: {
      what: 'capture-to-observation age of the frame the model was shown (§17 metric)',
      budgetMs: null,
      samplesMs: ages,
      caveat:
        'the frame was pushed by this file microseconds earlier, so this measures the ' +
        'ring and the selection, not a window server. On a Mac the 2–3 FPS sampler puts ' +
        'a floor of roughly 330 ms under it that nothing here can see.',
    },
  };
}
