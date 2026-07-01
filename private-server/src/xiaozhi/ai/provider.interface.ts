/**
 * Pluggable provider interfaces for the voice pipeline. Concrete
 * implementations wrap OpenAI-compatible local servers (whisper, llama.cpp,
 * Kokoro/openedai/Piper) but callers depend only on these interfaces so the
 * backends stay swappable. Imports NOTHING external.
 */

/** Speech-to-text: transcribe a WAV buffer to text. */
export interface SttProvider {
  /** @param wav PCM16 mono WAV (16 kHz upstream audio). */
  transcribe(wav: Buffer): Promise<string>;
}

/** Large language model: stream an assistant reply as text chunks. */
export interface LlmProvider {
  /**
   * Produce a streamed reply for one user turn. Implementations keep per-session
   * conversation history keyed by `sessionId`.
   *
   * @returns an async iterable of text chunks (deltas) making up the reply.
   */
  reply(sessionId: string, userText: string): AsyncIterable<string>;
}

/** Text-to-speech: stream synthesized audio for the given text. */
export interface TtsProvider {
  /** @returns async iterable of PCM16 mono 24 kHz audio chunks. */
  synthesize(text: string): AsyncIterable<Buffer>;
}

/** The three providers a conversation session needs, bundled together. */
export interface Providers {
  stt: SttProvider;
  llm: LlmProvider;
  tts: TtsProvider;
}
