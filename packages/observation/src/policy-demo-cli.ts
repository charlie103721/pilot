import { runScreenPolicyDemo } from './policy-demo.js';

/** Entry point for `pnpm --filter @pilot/observation demo:policy`. */
const result = await runScreenPolicyDemo();
process.stdout.write(`${result.lines.join('\n')}\n`);
