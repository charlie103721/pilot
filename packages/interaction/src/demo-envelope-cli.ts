import { runEnvelopeDemo } from './demo-envelope.js';

/** Entry point for `pnpm demo:envelope`. Prints one envelope per recording. */
const result = runEnvelopeDemo();
process.stdout.write(`${result.lines.join('\n')}\n`);
