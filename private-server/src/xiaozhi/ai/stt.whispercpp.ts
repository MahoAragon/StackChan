/**
 * Speech-to-text backed by a native whisper.cpp `whisper-server`.
 *
 * whisper.cpp exposes a (near-OpenAI) HTTP endpoint at POST /inference rather
 * than the OpenAI path /v1/audio/transcriptions, so it needs its own small
 * client instead of the `openai` SDK. The payoff on Apple Silicon: whisper runs
 * on the GPU (Metal) / ANE natively instead of the emulated CPU that the
 * Dockerized faster-whisper image is stuck on.
 *
 * Uses Node's built-in fetch / FormData / Blob — zero extra dependencies.
 */
import { XiaozhiConfig } from '../config';
import { SttProvider } from './provider.interface';

export class WhisperCppSttProvider implements SttProvider {
  constructor(private readonly config: XiaozhiConfig) {}

  /** Transcribe a PCM16 mono WAV buffer (16 kHz upstream audio) to text. */
  async transcribe(wav: Buffer): Promise<string> {
    const form = new FormData();
    // whisper-server reads the audio from the multipart `file` field. Wrap in a
    // fresh Uint8Array so the Blob part is ArrayBuffer-backed (Buffer's type can
    // be SharedArrayBuffer, which BlobPart rejects).
    form.append(
      'file',
      new Blob([new Uint8Array(wav)], { type: 'audio/wav' }),
      'audio.wav',
    );
    // Force JSON so we always parse a { text } object back. whisper.cpp ignores
    // the `model` field (the model is chosen when the server starts).
    form.append('response_format', 'json');
    if (this.config.stt.language) {
      form.append('language', this.config.stt.language);
    }

    const res = await fetch(this.config.stt.whisperCppUrl, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `whisper.cpp STT failed: ${res.status} ${res.statusText} ${detail}`.trim(),
      );
    }

    // response_format=json → { "text": "..." }. Be tolerant of a plain-text
    // body or a `transcription` key in case a build differs.
    const body = await res.text();
    try {
      const json = JSON.parse(body) as { text?: string; transcription?: string };
      return (json.text ?? json.transcription ?? '').trim();
    } catch {
      return body.trim();
    }
  }
}
