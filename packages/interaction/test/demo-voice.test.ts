import { describe, expect, it } from 'vitest';
import { runVoiceDemo, type VoiceDemoScene } from '../src/demo-voice.js';

/**
 * The PR-025 demo is the documented verification procedure, so it is pinned
 * here: `pnpm demo:voice` must keep producing exactly this run.
 */

function sceneNamed(scenes: readonly VoiceDemoScene[], name: string): VoiceDemoScene {
  const scene = scenes.find((candidate) => candidate.name === name);
  if (scene === undefined) {
    throw new Error(`no demo scene named "${name}"`);
  }
  return scene;
}

describe('voice orchestration demo', () => {
  it('completes a fake spoken question into an agent submission', async () => {
    const { scenes } = await runVoiceDemo();
    const scene = sceneNamed(scenes, 'spoken question');

    expect(scene.path).toEqual([
      'idle',
      'observing',
      'listening',
      'transcribing',
      'thinking',
      'speaking',
    ]);
    expect(scene.submitted.map((envelope) => envelope.transcript)).toEqual(['What is this?']);
    expect(scene.submitted[0]?.anchor?.grounding).toBe('pointer-in-window');
    expect(scene.spokenText).toBe('That is the Auto Renew toggle.');
    expect(scene.diagnostics).toEqual([]);
    expect(scene.adapter).toEqual({ started: 1, stopped: 1, cancelled: 0, stillRecording: false });
  });

  it('drops a transcript that arrives after its utterance was cancelled', async () => {
    const { scenes } = await runVoiceDemo();
    const scene = sceneNamed(scenes, 'late transcript after cancel');

    expect(scene.submitted).toEqual([]);
    expect(scene.diagnostics).toEqual(['discarded final for utt-000001: cancelled']);
    expect(scene.adapter.cancelled).toBe(1);
    expect(scene.adapter.stillRecording).toBe(false);
  });

  it('asks only the second of two overlapping push-to-talk presses', async () => {
    const { scenes } = await runVoiceDemo();
    const scene = sceneNamed(scenes, 'overlapping push-to-talk presses');

    expect(scene.submitted.map((envelope) => envelope.transcript)).toEqual([
      'No wait — what is that?',
    ]);
    expect(scene.rejections).toEqual([
      'push-to-talk-down in listening: illegal-transition',
      'transcript-partial in listening: stale-utterance',
      'transcript-final in listening: stale-utterance',
    ]);
    expect(scene.adapter.started).toBe(2);
    expect(scene.adapter.stillRecording).toBe(false);
  });

  it('lets the user type after the recogniser fails', async () => {
    const { scenes } = await runVoiceDemo();
    const scene = sceneNamed(scenes, 'STT failure, then typing');

    expect(scene.path).toContain('error');
    expect(scene.textFallbackStates).toContain('error');
    expect(scene.submitted.map((envelope) => envelope.transcript)).toEqual(['What is this?']);
    expect(scene.spokenText).toBe('That is the Auto Renew toggle.');
    expect(scene.adapter.cancelled).toBe(1);
    expect(scene.diagnostics).toEqual(['discarded final for utt-000001: already-failed']);
  });

  it('accepts one transcript per utterance when the adapter finalizes twice', async () => {
    const { scenes } = await runVoiceDemo();
    const scene = sceneNamed(scenes, 'duplicate finalize');

    expect(scene.submitted).toHaveLength(1);
    expect(scene.diagnostics).toEqual(['discarded final for utt-000001: already-finalized']);
    expect(scene.rejections).toEqual([]);
  });

  it('submits the same envelope whether the question was spoken or typed', async () => {
    const { scenes } = await runVoiceDemo();
    const spoken = sceneNamed(scenes, 'spoken question').submitted[0];
    const typed = sceneNamed(scenes, 'STT failure, then typing').submitted[0];

    expect(spoken?.transcript).toBe(typed?.transcript);
    expect(Object.keys(spoken ?? {}).sort()).toEqual(Object.keys(typed ?? {}).sort());
    expect(typed?.anchor?.grounding).toBe(spoken?.anchor?.grounding);
    expect(typed?.pointer.targetLabel).toBe(spoken?.pointer.targetLabel);
  });

  it('is deterministic: two runs are identical', async () => {
    const [first, second] = await Promise.all([runVoiceDemo(), runVoiceDemo()]);
    expect(first.lines).toEqual(second.lines);
  });
});
