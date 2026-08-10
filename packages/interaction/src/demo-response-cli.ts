import { runResponseDemo } from './demo-response.js';

/** Entry point for `pnpm demo:response`. Prints the seven TTS-buffer scenes. */
const result = await runResponseDemo();
process.stdout.write(`${result.lines.join('\n')}\n`);
