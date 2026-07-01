/**
 * Speech-to-text backed by an OpenAI-compatible /v1/audio/transcriptions server
 * (e.g. a local whisper server). Uploads a WAV buffer and returns the recognized
 * text. Depends only on the `openai` SDK and the canonical config/interface.
 */

import OpenAI, { toFile } from 'openai';

import { XiaozhiConfig } from '../config';
import { SttProvider } from './provider.interface';

export class OpenAiCompatSttProvider implements SttProvider {
  private readonly client: OpenAI;

  constructor(private readonly config: XiaozhiConfig) {
    this.client = new OpenAI({
      baseURL: config.stt.baseUrl,
      apiKey: config.stt.apiKey,
    });
  }

  /** Transcribe a PCM16 mono WAV buffer (16 kHz upstream audio) to text. */
  async transcribe(wav: Buffer): Promise<string> {
    // Wrap the raw WAV bytes into a File the SDK's multipart upload accepts.
    const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });

    const result = await this.client.audio.transcriptions.create({
      file,
      model: this.config.stt.model,
      // Omit language when unset so the server can auto-detect.
      ...(this.config.stt.language ? { language: this.config.stt.language } : {}),
      response_format: 'json',
    });

    // `create` returns a Transcription ({ text }) for json/verbose_json formats.
    return (result.text ?? '').trim();
  }
}
