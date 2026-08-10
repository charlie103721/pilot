import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inflateSync } from 'node:zlib';

/**
 * A stub OpenAI-compatible HTTP server (PR-039). **THIS IS A FIXTURE.**
 *
 * READ THIS BEFORE BELIEVING ANYTHING IT PROVES
 * ---------------------------------------------
 * There is no local inference server on the machine this repository is
 * developed on — no llama.cpp, no Ollama, no LM Studio, no GPU, no model
 * weights. This file is a hand-written HTTP server that answers the four
 * requests Pilot's local profile makes, in the shapes the OpenAI API documents.
 * **It is not an inference server and it does not contain a language model.**
 * Its "answers" are strings from the script the caller passed in.
 *
 * What it therefore *can* prove: that Pilot's probe ladder, its diagnostics,
 * the capability gate, the Pi `openai-completions` provider, the agent loop and
 * the streaming path all behave correctly against wire-shaped traffic, and that
 * each unsupported-model failure mode produces the message it is supposed to.
 *
 * What it *cannot* prove: that a real server produces those wire shapes.
 * `docs/handoff.md` §1 step 17 is the list of things only a real endpoint can
 * answer.
 *
 * It is **not a second Pilot service**. `docs/implementation.md` PR-039 requires
 * that Pilot run as one app against the user's own endpoint; in production
 * nothing in this file is constructed. It stands in for the *user's* server in
 * tests and in `pnpm demo:local`, exactly as `FakeScreenContextService` stands
 * in for a screen.
 *
 * It binds 127.0.0.1 on an ephemeral port and speaks to nothing else.
 */

/** Which broken (or working) local endpoint this stub imitates. */
export const STUB_ENDPOINT_BEHAVIOURS = [
  /** Vision and tools both work. */
  'healthy',
  /** Up, OpenAI-compatible, `data: []` — no model loaded. */
  'no-model-loaded',
  /** A perfectly good HTTP server that serves a web page, not an API. */
  'not-openai',
  /** 401 on everything. */
  'unauthorized',
  /** 400 on any request carrying an image block. */
  'vision-rejected',
  /** Accepts the image, answers about a colour it cannot have seen. */
  'vision-blind',
  /** 400 on any request carrying `tools`. */
  'tools-rejected',
  /** Accepts `tools`, replies in words and never emits `tool_calls`. */
  'tools-ignored',
] as const;

export type StubEndpointBehaviour = (typeof STUB_ENDPOINT_BEHAVIOURS)[number];

/** One scripted streamed reply for the agent path. */
export type StubReply =
  | { readonly say: string }
  | { readonly tool: { readonly name: string; readonly arguments: unknown } };

export interface StubRequestRecord {
  readonly method: string;
  readonly path: string;
  readonly streamed: boolean;
  /** Parsed JSON body, or `null` for a GET / unparseable body. */
  readonly body: Record<string, unknown> | null;
  /**
   * Decoded bytes of every image this request carried.
   *
   * The number exists so a test can assert that the only pixels which ever
   * reached the endpoint were the probe's own swatch — i.e. that the capability
   * gate refused *before* screen data, rather than after.
   */
  readonly imageBytes: number;
}

export interface StubOpenAiEndpoint {
  /** What goes in `LocalEndpointSettings.baseUrl`. Includes `/v1`. */
  readonly baseUrl: string;
  /** The same server without the version prefix, for the 404 diagnosis. */
  readonly rootUrl: string;
  readonly modelId: string;
  /** Every request received, oldest first. */
  readonly requests: readonly StubRequestRecord[];
  setScript(replies: readonly StubReply[]): void;
  close(): Promise<void>;
}

export interface StubOpenAiEndpointOptions {
  readonly behaviour?: StubEndpointBehaviour;
  readonly modelId?: string;
  /** Reported as `meta.n_ctx` on the model entry. Omit to report nothing. */
  readonly contextWindow?: number;
  /** When set, requests without this bearer token get 401. */
  readonly apiKey?: string;
  /** Streamed replies for the agent path, consumed in order then repeated. */
  readonly script?: readonly StubReply[];
}

const COLOUR_NAMES = ['red', 'green', 'blue', 'yellow', 'magenta', 'cyan'];

/** Total decoded byte length of every image block in a request body. */
function imageBytesIn(value: unknown): number {
  if (typeof value === 'string') {
    const match = /^data:image\/[a-z+]+;base64,(.+)$/iu.exec(value);
    return match?.[1] === undefined ? 0 : Buffer.from(match[1], 'base64').length;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + imageBytesIn(item), 0);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).reduce<number>((sum, item) => sum + imageBytesIn(item), 0);
  }
  return 0;
}

function parseBody(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = raw === '' ? null : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasImage(body: Record<string, unknown> | null): boolean {
  return body !== null && imageBytesIn(body) > 0;
}

function askedColour(body: Record<string, unknown> | null): string {
  // The probe names the candidate colours in its prompt; a "blind" model that
  // wants to guess has to pick one of them, which is exactly what a real one
  // does. It picks the first, which is wrong five times in six.
  const text = JSON.stringify(body ?? {}).toLowerCase();
  return COLOUR_NAMES.find((name) => text.includes(name)) ?? 'red';
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}

function chatCompletion(model: string, content: string): unknown {
  return {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
  };
}

function toolCompletion(model: string, name: string): unknown {
  return {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_probe', type: 'function', function: { name, arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
  };
}

/**
 * Starts the stub. Always resolves with a running server on 127.0.0.1.
 */
export async function startStubOpenAiEndpoint(
  options: StubOpenAiEndpointOptions = {},
): Promise<StubOpenAiEndpoint> {
  const behaviour = options.behaviour ?? 'healthy';
  const modelId = options.modelId ?? 'stub-vl-7b';
  const requests: StubRequestRecord[] = [];
  let script: readonly StubReply[] = options.script ?? [{ say: 'Stub reply.' }];
  let scriptIndex = 0;

  const streamReply = (response: ServerResponse, reply: StubReply): void => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (payload: unknown): void => {
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const base = {
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model: modelId,
    };
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    if ('say' in reply) {
      // Several chunks: streaming is the property under test, not the text.
      for (const piece of reply.say.match(/\S+\s*/gu) ?? [reply.say]) {
        send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    } else {
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_stub',
                  type: 'function',
                  function: {
                    name: reply.tool.name,
                    arguments: JSON.stringify(reply.tool.arguments),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    }
    send({
      ...base,
      choices: [],
      usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
    });
    response.write('data: [DONE]\n\n');
    response.end();
  };

  const handle = (request: IncomingMessage, response: ServerResponse, raw: string): void => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const body = parseBody(raw);
    const streamed = body?.['stream'] === true;
    requests.push({
      method: request.method ?? 'GET',
      path,
      streamed,
      body,
      imageBytes: imageBytesIn(body),
    });

    if (behaviour === 'not-openai') {
      const page = '<!doctype html><html><body><h1>llama.cpp</h1><p>Web UI</p></body></html>';
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(page);
      return;
    }

    const auth = request.headers.authorization;
    const keyOk = options.apiKey === undefined ? true : auth === `Bearer ${options.apiKey}`;
    if (behaviour === 'unauthorized' || !keyOk) {
      sendJson(response, 401, {
        error: { message: 'invalid api key', type: 'invalid_request_error' },
      });
      return;
    }

    if (path === '/v1/models') {
      if (behaviour === 'no-model-loaded') {
        sendJson(response, 200, { object: 'list', data: [] });
        return;
      }
      sendJson(response, 200, {
        object: 'list',
        data: [
          {
            id: modelId,
            object: 'model',
            owned_by: 'stub',
            ...(options.contextWindow === undefined
              ? {}
              : { meta: { n_ctx: options.contextWindow } }),
          },
        ],
      });
      return;
    }

    if (path === '/v1/chat/completions' && request.method === 'POST') {
      const carriesTools =
        Array.isArray(body?.['tools']) && (body['tools'] as unknown[]).length > 0;
      if (behaviour === 'vision-rejected' && hasImage(body)) {
        sendJson(response, 400, {
          error: {
            message: 'this model does not support image input',
            type: 'invalid_request_error',
            param: 'messages',
          },
        });
        return;
      }
      if (behaviour === 'tools-rejected' && carriesTools) {
        sendJson(response, 400, {
          error: {
            message: 'tools are not supported by this model',
            type: 'invalid_request_error',
            param: 'tools',
          },
        });
        return;
      }
      if (streamed) {
        const reply = script[scriptIndex] ?? script.at(-1) ?? { say: 'Stub reply.' };
        scriptIndex = Math.min(scriptIndex + 1, script.length);
        streamReply(response, reply);
        return;
      }
      // Non-streamed: this is a probe.
      if (carriesTools) {
        if (behaviour === 'tools-ignored') {
          sendJson(
            response,
            200,
            chatCompletion(modelId, 'Sure! I would call that tool if I could.'),
          );
          return;
        }
        sendJson(response, 200, toolCompletion(modelId, 'pilot_probe_ping'));
        return;
      }
      if (hasImage(body)) {
        if (behaviour === 'vision-blind') {
          // Names a colour without looking. The probe draws one of six.
          sendJson(response, 200, chatCompletion(modelId, askedColour(body)));
          return;
        }
        sendJson(response, 200, chatCompletion(modelId, describeSwatch(body)));
        return;
      }
      sendJson(response, 200, chatCompletion(modelId, 'ok'));
      return;
    }

    sendJson(response, 404, { error: { message: `no route for ${path}`, type: 'not_found' } });
  };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      handle(request, response, Buffer.concat(chunks).toString('utf8'));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const rootUrl = `http://127.0.0.1:${String(address.port)}`;

  return {
    baseUrl: `${rootUrl}/v1`,
    rootUrl,
    modelId,
    requests,
    setScript(replies: readonly StubReply[]): void {
      script = replies;
      scriptIndex = 0;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/**
 * Reads the swatch the probe sent and names its colour — by decoding the PNG,
 * not by guessing.
 *
 * This is the one place the stub does something a language model would do, and
 * it is deliberately *honest*: a healthy stub really looks at the pixels, so
 * "the vision probe passed" means the image arrived intact and round-tripped
 * through base64, the data URI and the content block. A stub that simply
 * answered correctly would pass a probe that sent no image at all.
 */
function describeSwatch(body: Record<string, unknown> | null): string {
  const url = findDataUrl(body);
  if (url === null) {
    return 'I cannot see an image.';
  }
  const rgb = firstPixelOf(Buffer.from(url, 'base64'));
  if (rgb === null) {
    return 'I cannot read that image.';
  }
  const [r, g, b] = rgb;
  const high = (channel: number): boolean => channel > 150;
  if (high(r) && high(g) && !high(b)) return 'yellow';
  if (high(r) && high(b) && !high(g)) return 'magenta';
  if (high(g) && high(b) && !high(r)) return 'cyan';
  if (high(r)) return 'red';
  if (high(g)) return 'green';
  if (high(b)) return 'blue';
  return 'black';
}

function findDataUrl(value: unknown): string | null {
  if (typeof value === 'string') {
    return /^data:image\/[a-z+]+;base64,(.+)$/iu.exec(value)?.[1] ?? null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDataUrl(item);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      const found = findDataUrl(item);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/** Decodes the first pixel of a truecolour, non-interlaced, filter-0 PNG. */
function firstPixelOf(png: Buffer): readonly [number, number, number] | null {
  let offset = 8;
  const parts: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') {
      parts.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  if (parts.length === 0) {
    return null;
  }
  try {
    const raw = inflateSync(Buffer.concat(parts));
    // byte 0 is the row filter; the first pixel follows.
    return [raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 0] as const;
  } catch {
    return null;
  }
}
