import { runInteractionDemo } from './demo.js';

/** Entry point for `pnpm demo:interaction`. Prints the scripted fake flow. */
const result = await runInteractionDemo();
process.stdout.write(`${result.lines.join('\n')}\n`);
