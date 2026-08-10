import { runSceneTimelineDemo } from './scene-demo.js';

/** Entry point for `pnpm --filter @pilot/observation demo:scene`. */
const result = await runSceneTimelineDemo();
process.stdout.write(`${result.lines.join('\n')}\n`);
