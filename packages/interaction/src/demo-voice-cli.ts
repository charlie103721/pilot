import { runVoiceDemo } from './demo-voice.js';

/** Entry point for `pnpm demo:voice`. Prints the five voice-orchestration scenes. */
const result = await runVoiceDemo();
process.stdout.write(`${result.lines.join('\n')}\n`);
