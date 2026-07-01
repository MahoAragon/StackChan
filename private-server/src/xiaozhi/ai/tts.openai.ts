/**
 * Text-to-speech provider backed by an OpenAI-compatible /v1/audio/speech
 * server (Kokoro-FastAPI / openedai-speech / Piper, etc). We request raw PCM16
 * mono 24 kHz audio (`response_format: "pcm"`) so it lines up exactly with the
 * device downstream rate and no resampling is needed — the caller just opus
 * encodes the yielded PCM chunks.
 */

import OpenAI from 'openai';

import type { XiaozhiConfig } from '../config';
import type { TtsProvider } from './provider.interface';

export class OpenAiCompatTtsProvider implements TtsProvider {
  private readonly client: OpenAI;

  constructor(private readonly config: XiaozhiConfig) {
    this.client = new OpenAI({
      baseURL: config.tts.baseUrl,
      apiKey: config.tts.apiKey,
    });
  }

  /**
   * Synthesize `text` and yield PCM16 mono 24 kHz audio as Buffer chunks.
   * Streams the response body when possible; otherwise falls back to buffering
   * the whole response and yielding it as a single chunk.
   */
  async *synthesize(text: string): AsyncIterable<Buffer> {
    const response = await this.client.audio.speech.create({
      model: this.config.tts.model,
      voice: this.config.tts.voice,
      input: text,
      response_format: 'pcm',
    });

    const body = (response as { body?: unknown }).body;

    // Node Readable / web ReadableStream are both async-iterable — stream chunks.
    if (body && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
      for await (const chunk of body as AsyncIterable<Uint8Array | Buffer>) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
      return;
    }

    // Fallback: no streamable body, buffer the full response and yield once.
    const arrayBuffer = await response.arrayBuffer();
    yield Buffer.from(arrayBuffer);
  }
}
