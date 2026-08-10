import { runInterruptDemo } from './demo-interrupt.js';

/** Entry point for `pnpm demo:interrupt`. Prints the eight interruption scenes. */
const result = await runInterruptDemo();
process.stdout.write(`${result.lines.join('\n')}\n`);
