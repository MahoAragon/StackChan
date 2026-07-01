/**
 * One live conversation over a single xiaozhi WebSocket connection.
 *
 * Lifecycle of a turn:
 *   listen state=start  -> begin buffering upstream opus (decoded to PCM16 16k)
 *   listen state=stop   -> wrap PCM as WAV -> STT -> stream LLM (split into
 *                          sentences) -> TTS each sentence -> opus-encode 24k ->
 *                          send as BINARY frames, bracketed by tts start/stop.
 *
 * Downstream audio is ALWAYS bracketed by {"type":"tts","state":"start"} and
 * {"type":"tts","state":"stop"} because the firmware only decodes opus while it
 * is in the Speaking state. Errors are caught so a turn can never leave the
 * device stuck without a tts stop.
 */
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { AudioCodec } from './audio/opus-codec';
import { pcm16ToWav } from './audio/wav';
import type { Providers } from './ai/provider.interface';
import {
  SAMPLE_RATE_IN,
  buildLlm,
  buildStt,
  buildTtsSentenceStart,
  buildTtsStart,
  buildTtsStop,
  encodeServerMessage,
  type ServerMessage,
} from './protocol/messages';

export class ConversationSession {
  private readonly logger = new Logger('XiaozhiConv');

  /** Decoded upstream PCM16 16k accumulated for the in-flight utterance. */
  private pcmChunks: Buffer[] = [];
  private listening = false;

  /**
   * Monotonic id of the current response turn. Bumping it (via abort, a new
   * utterance, or socket close) signals any in-flight async loop to bail so we
   * never talk over ourselves.
   */
  private turnId = 0;
  private speaking = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly codec: AudioCodec,
    private readonly providers: Providers,
    private readonly sessionId: string,
  ) {}

  /* ------------------------------ Control ------------------------------- */

  /** listen state=start | detect — begin a fresh utterance. */
  onListenStart(): void {
    // A new utterance supersedes anything we might still be saying.
    this.abort();
    this.pcmChunks = [];
    this.listening = true;
  }

  /** listen state=stop — end of utterance, run the STT->LLM->TTS turn. */
  onListenStop(): void {
    if (!this.listening) return;
    this.listening = false;
    const pcm = Buffer.concat(this.pcmChunks);
    this.pcmChunks = [];
    if (pcm.length === 0) {
      this.logger.warn('Utterance ended with no audio; ignoring');
      return;
    }
    void this.runTurn(pcm);
  }

  /** abort — stop buffering and cut off any response in progress. */
  abort(): void {
    this.listening = false;
    this.pcmChunks = [];
    if (this.speaking) {
      // Bump the turn id so the streaming loop stops, then close out the tts
      // bracket the device is expecting.
      this.turnId++;
      this.speaking = false;
      this.sendTtsStop();
    }
  }

  /** Called when the socket closes so no async loop keeps sending. */
  dispose(): void {
    this.turnId++;
    this.listening = false;
    this.speaking = false;
    this.pcmChunks = [];
  }

  /* --------------------------- Upstream audio --------------------------- */

  /** A BINARY frame: one raw opus packet from the device microphone. */
  onOpusPacket(opus: Buffer): void {
    if (!this.listening) return;
    try {
      const pcm = this.codec.decodeUpstreamPacket(opus);
      if (pcm.length) this.pcmChunks.push(pcm);
    } catch (err) {
      this.logger.warn(`Failed to decode upstream opus: ${asMessage(err)}`);
    }
  }

  /* ------------------------------ The turn ------------------------------ */

  private async runTurn(pcm: Buffer): Promise<void> {
    const turn = ++this.turnId;
    this.speaking = true;

    try {
      const wav = pcm16ToWav(pcm, SAMPLE_RATE_IN);
      const userText = (await this.providers.stt.transcribe(wav)).trim();
      if (this.isStale(turn)) return;

      if (!userText) {
        this.logger.log('STT produced no text; skipping turn');
        this.speaking = false;
        return;
      }
      this.logger.log(`STT: "${userText}"`);
      this.send(buildStt(userText, this.sessionId));

      // Open the speaking bracket before any audio.
      this.send(buildTtsStart(this.sessionId));
      this.send(buildLlm('neutral', this.sessionId));

      let spokeAnything = false;
      for await (const sentence of this.sentences(
        this.providers.llm.reply(this.sessionId, userText),
      )) {
        if (this.isStale(turn)) return;
        spokeAnything = true;
        this.send(buildTtsSentenceStart(sentence, this.sessionId));
        await this.speakSentence(sentence, turn);
        if (this.isStale(turn)) return;
      }
      if (!spokeAnything) this.logger.log('LLM produced no reply text');
    } catch (err) {
      this.logger.error(`Turn failed: ${asMessage(err)}`);
    } finally {
      // Only close the bracket if this turn is still the active one; an abort
      // that superseded us already sent its own tts stop.
      if (!this.isStale(turn)) {
        this.speaking = false;
        this.sendTtsStop();
      }
    }
  }

  /** Synthesize one sentence and stream its opus frames downstream. */
  private async speakSentence(sentence: string, turn: number): Promise<void> {
    for await (const pcmChunk of this.providers.tts.synthesize(sentence)) {
      if (this.isStale(turn)) return;
      for (const packet of this.codec.encodeDownstreamPcm(pcmChunk)) {
        if (this.isStale(turn)) return;
        this.sendBinary(packet);
      }
    }
  }

  /* ------------------------------ Helpers ------------------------------- */

  /** True if `turn` is no longer the active turn or the socket is gone. */
  private isStale(turn: number): boolean {
    return turn !== this.turnId || this.ws.readyState !== WebSocket.OPEN;
  }

  /**
   * Re-chunk a stream of LLM text deltas into whole sentences so TTS gets
   * natural, low-latency units instead of the model's arbitrary token deltas.
   */
  private async *sentences(
    deltas: AsyncIterable<string>,
  ): AsyncIterable<string> {
    let buf = '';
    for await (const delta of deltas) {
      buf += delta;
      // Flush on sentence-ending punctuation (latin + CJK) or newlines.
      const parts = buf.split(/(?<=[.!?。！？\n])/);
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const s = part.trim();
        if (s) yield s;
      }
    }
    const tail = buf.trim();
    if (tail) yield tail;
  }

  private sendTtsStop(): void {
    this.send(buildTtsStop(this.sessionId));
  }

  private send(msg: ServerMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeServerMessage(msg));
  }

  private sendBinary(packet: Buffer): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(packet, { binary: true });
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
