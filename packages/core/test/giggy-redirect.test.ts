import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createGiggy, generateSpeech, streamSpeech } from '../src/speech';
import {
  createGiggyTranscription,
  createGiggyLiveTranscriptionSession,
  streamTranscription,
} from '../src/transcription';

const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

async function redirectPair() {
  let targetRequests = 0;
  let targetSawKey = false;
  const target = createServer((req, res) => {
    targetRequests += 1;
    targetSawKey ||= req.headers['xi-api-key'] !== undefined;
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  const targetURL = await listen(target);
  const source = createServer((_req, res) => {
    res.writeHead(302, { location: `${targetURL}/capture` }).end();
  });
  const sourceURL = await listen(source);
  return {
    sourceURL,
    get targetRequests() {
      return targetRequests;
    },
    get targetSawKey() {
      return targetSawKey;
    },
  };
}

describe('Giggy authenticated HTTP requests reject redirects', () => {
  it('does not forward TTS credentials to a cross-origin redirect target', async () => {
    const pair = await redirectPair();
    const model = createGiggy({ apiKey: 'test-only-key', baseURL: `${pair.sourceURL}/v1` })(
      'giggyspeech',
    );
    await expect(generateSpeech({ model, text: 'hello', voice: 'voice-id' })).rejects.toBeTruthy();
    await expect(streamSpeech({ model, text: 'hello', voice: 'voice-id' })).rejects.toBeTruthy();
    expect(pair.targetRequests).toBe(0);
    expect(pair.targetSawKey).toBe(false);
  });

  it('does not forward uploaded transcription credentials to a redirect target', async () => {
    const pair = await redirectPair();
    const model = createGiggyTranscription({
      apiKey: 'test-only-key',
      baseURL: `${pair.sourceURL}/v1`,
    })('giggy-stt');
    await expect(streamTranscription({ model, audio: new Uint8Array([1, 2, 3, 4]) })).rejects.toBeTruthy();
    expect(pair.targetRequests).toBe(0);
    expect(pair.targetSawKey).toBe(false);
  });

  it('does not forward live-generation credentials to a redirect target', async () => {
    const pair = await redirectPair();
    const model = createGiggyTranscription({
      apiKey: 'test-only-key',
      baseURL: `${pair.sourceURL}/v1`,
    })('giggy-stt');
    const listeners = new Map<string, (event: unknown) => void>();
    const session = createGiggyLiveTranscriptionSession({
      model,
      deps: {
        webSocket: () => ({
          readyState: 0,
          send() {},
          close() {},
          addEventListener(type, listener) {
            listeners.set(type, listener);
          },
        }),
      },
    });
    const connected = session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    listeners.get('open')?.({});
    const send = (payload: unknown) => listeners.get('message')?.({ data: JSON.stringify(payload) });
    send({ type: 'generation_created', generation_uuid: 'generation-1' });
    send({ type: 'ready', generation_uuid: 'generation-1', attempt: 1 });
    await connected;
    session.sendAudio(new Uint8Array(32_000));
    const stopped = session.stop();
    send({ type: 'input_complete', generation_uuid: 'generation-1', sequence: 1 });
    send({
      type: 'generation_updated',
      generation: { generation_uuid: 'generation-1', status: 'completed' },
    });
    await expect(stopped).rejects.toBeTruthy();
    expect(pair.targetRequests).toBe(0);
    expect(pair.targetSawKey).toBe(false);
  });
});
