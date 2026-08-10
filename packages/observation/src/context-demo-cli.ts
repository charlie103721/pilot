import { runScreenContextDemo } from './context-demo.js';

/** Entry point for `pnpm --filter @pilot/observation demo:context`. */
const result = await runScreenContextDemo();
process.stdout.write(`${result.lines.join('\n')}\n`);
