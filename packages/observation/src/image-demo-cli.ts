import { runImagePipelineDemo } from './image-demo.js';

/** Entry point for `pnpm --filter @pilot/observation demo:image`. */
const outIndex = process.argv.indexOf('--out');
const outDir = outIndex === -1 ? undefined : process.argv[outIndex + 1];
const result = await runImagePipelineDemo(outDir === undefined ? {} : { outDir });
process.stdout.write(`${result.lines.join('\n')}\n`);
