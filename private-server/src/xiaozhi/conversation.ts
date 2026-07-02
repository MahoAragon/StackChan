/**
 * One live conversation over a single xiaozhi WebSocket connection.
 *
 * Lifecycle of a turn:
 *   listen state=start  -> begin buffering upstream opus (decoded to PCM16 16k)
 *   end of utterance    -> wrap PCM as WAV -> STT -> stream LLM (split into
 *                          sentences) -> TTS each sentence -> opus-encode 24k ->
 *                          send as BINARY frames, bracketed by tts start/stop.
 *
 * End of utterance is whichever happens first: the device's `listen stop`
 * (auto/manual mode), server-side VAD silence, or a hard length cap. The VAD /
 * cap matter because some firmware configs (realtime mode) stream continuously
 * and never send stop, and even in auto mode a stop can be lost.
 *
 * Downstream audio is ALWAYS bracketed by {"type":"tts","state":"start"} and
 * {"type":"tts","state":"stop"} because the firmware only decodes opus while it
 * is in the Speaking state. The start is sent just-in-time before the first
 * audio frame (not at STT time): entering Speaking also starts the device's
 * talking animation, which must not lead the sound. Errors are caught so a
 * turn can never leave the device stuck without a tts stop.
 *
 * Downstream frames are paced to real time (TTS_PREBUFFER_MS): the device's
 * decode queue is tiny and drops packets when full, so sending as fast as TTS
 * encodes would truncate every reply longer than ~2.4s.
 *
 * Sentence text (tts sentence_start) is scheduled onto the same playback
 * clock: the device renders the text the moment the message arrives, so it is
 * sent when the sentence is projected to be HEARD, not when its audio bytes
 * are sent (which run a prebuffer ahead).
 */
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { AudioCodec } from './audio/opus-codec';
import { pcm16ToWav } from './audio/wav';
import type { Providers, ToolSource } from './ai/provider.interface';
import {
  FRAME_DURATION_MS,
  SAMPLE_RATE_IN,
  buildLlm,
  buildStt,
  buildTtsSentenceStart,
  buildTtsStart,
  buildTtsStop,
  encodeServerMessage,
  type ServerMessage,
} from './protocol/messages';

// End-of-utterance detection tuning (env-overridable for real-mic tuning).
const VAD_RMS_THRESHOLD = Number(process.env.VAD_RMS_THRESHOLD ?? 600);
const VAD_HANGOVER_MS = Number(process.env.VAD_HANGOVER_MS ?? 800);
const MAX_UTTERANCE_MS = Number(process.env.MAX_UTTERANCE_MS ?? 15000);

/**
 * How far ahead of real-time playback we let downstream audio run. The
 * firmware's decode queue holds only ~2.4s of opus (40 x 60ms packets,
 * audio_service.h MAX_DECODE_PACKETS_IN_QUEUE) and SILENTLY DROPS packets
 * pushed while it is full (application.cc OnIncomingAudio pushes with
 * wait=false). TTS + opus encode outrun playback by an order of magnitude,
 * so unpaced sending loses most frames of any reply longer than the queue —
 * heard as the reply repeatedly cutting out mid-sentence. Must stay well
 * under 2400; large enough to ride out network jitter and the TTS synthesis
 * gap between sentences.
 */
const TTS_PREBUFFER_MS = Number(process.env.TTS_PREBUFFER_MS ?? 1200);

/**
 * Pause pacing while more than this many bytes sit unflushed in the socket.
 * Without this, a multi-second TCP stall (WiFi roaming/congestion) would let
 * paced frames pile up in the socket buffer and arrive at the device as one
 * burst on recovery, overflowing its decode queue just like unpaced sending.
 * ~2 KB is a handful of opus frames.
 */
const SOCKET_BACKLOG_LIMIT_BYTES = 2048;
const VAD_HANGOVER_FRAMES = Math.max(1, Math.round(VAD_HANGOVER_MS / FRAME_DURATION_MS));
const MAX_UTTERANCE_FRAMES = Math.max(1, Math.round(MAX_UTTERANCE_MS / FRAME_DURATION_MS));
const VAD_MIN_SPEECH_FRAMES = 5; // ~300ms of speech before silence may end a turn
const LOG_EVERY_FRAMES = 50; // ~3s heartbeat while listening

export class ConversationSession {
  private readonly logger = new Logger('XiaozhiConv');

  /** Decoded upstream PCM16 16k accumulated for the in-flight utterance. */
  private pcmChunks: Buffer[] = [];
  private listening = false;
  private listenMode = 'auto';

  // Voice-activity state for the current utterance.
  private framesReceived = 0;
  private peakRms = 0;
  private sawSpeech = false;
  private speechFrames = 0;
  private silenceFrames = 0;

  /**
   * Monotonic id of the current response turn. Bumping it (via abort, a new
   * utterance, end of turn, or socket close) signals any in-flight async loop
   * and any scheduled sentence-text timer to bail so we never talk over
   * ourselves or paint text for a turn that is over.
   */
  private turnId = 0;
  private speaking = false;

  /**
   * Wall-clock ms at which the device will finish playing everything we have
   * sent this turn. Drives real-time pacing of downstream frames (see
   * TTS_PREBUFFER_MS) and the end-of-turn drain before tts stop.
   */
  private playbackEndsAtMs = 0;

  /**
   * Whether this turn's {"type":"tts","state":"start"} has been sent. The
   * bracket opens just-in-time before the first audio frame — the device
   * starts its talking animation on entering Speaking, so an eager start
   * (sent at STT time) animates a silent face for the whole LLM+TTS latency.
   */
  private ttsBracketOpen = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly codec: AudioCodec,
    private readonly providers: Providers,
    private readonly sessionId: string,
    /** Session tool catalog (server + MCP device tools) the LLM may call. */
    private readonly tools?: ToolSource,
  ) {}

  /* ------------------------------ Control ------------------------------- */

  /** listen state=start | detect — begin a fresh utterance. */
  onListenStart(mode?: string): void {
    // A new utterance supersedes anything we might still be saying.
    this.abort();
    this.listenMode = mode ?? 'auto';
    this.rearmListening();
    this.logger.log(`Listening started (mode=${this.listenMode})`);
  }

  /** Start buffering a fresh utterance with clean voice-activity state. */
  private rearmListening(): void {
    this.pcmChunks = [];
    this.listening = true;
    this.framesReceived = 0;
    this.peakRms = 0;
    this.sawSpeech = false;
    this.speechFrames = 0;
    this.silenceFrames = 0;
  }

  /** listen state=stop from the device — end of utterance. */
  onListenStop(): void {
    this.endUtterance('device-stop');
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

    let pcm: Buffer;
    try {
      pcm = this.codec.decodeUpstreamPacket(opus);
    } catch (err) {
      this.logger.warn(`Failed to decode upstream opus: ${asMessage(err)}`);
      return;
    }
    if (!pcm.length) return;

    this.pcmChunks.push(pcm);
    this.framesReceived++;
    if (this.framesReceived === 1) this.logger.log('Receiving audio from device...');

    // Track voice activity to detect end-of-utterance server-side.
    const rms = frameRms(pcm);
    if (rms > this.peakRms) this.peakRms = rms;
    if (rms >= VAD_RMS_THRESHOLD) {
      this.sawSpeech = true;
      this.speechFrames++;
      this.silenceFrames = 0;
    } else if (this.sawSpeech) {
      this.silenceFrames++;
    }

    if (this.framesReceived % LOG_EVERY_FRAMES === 0) {
      this.logger.log(
        `...listening ${((this.framesReceived * FRAME_DURATION_MS) / 1000).toFixed(1)}s ` +
          `(peakRms=${Math.round(this.peakRms)}, speech=${this.sawSpeech}, silence=${this.silenceFrames}f)`,
      );
    }

    if (
      this.sawSpeech &&
      this.speechFrames >= VAD_MIN_SPEECH_FRAMES &&
      this.silenceFrames >= VAD_HANGOVER_FRAMES
    ) {
      this.endUtterance('vad-silence');
    } else if (this.framesReceived >= MAX_UTTERANCE_FRAMES) {
      this.endUtterance('max-length');
    }
  }

  /* ------------------------------ The turn ------------------------------ */

  /** End the utterance (device stop, VAD silence, or length cap) and run a turn. */
  private endUtterance(trigger: string): void {
    if (!this.listening) return;
    this.listening = false;
    const pcm = Buffer.concat(this.pcmChunks);
    this.pcmChunks = [];
    if (pcm.length === 0) {
      this.logger.warn(`Utterance ended (${trigger}) with no audio; ignoring`);
      return;
    }
    const secs = (pcm.length / 2 / SAMPLE_RATE_IN).toFixed(1);
    this.logger.log(
      `Utterance ended (${trigger}, ${secs}s, ${this.framesReceived} frames, peakRms=${Math.round(this.peakRms)}) -> running turn`,
    );
    void this.runTurn(pcm);
  }

  private async runTurn(pcm: Buffer): Promise<void> {
    const turn = ++this.turnId;
    this.speaking = true;
    // Discard any downstream remainder left over from a prior/aborted turn.
    this.codec.resetDownstream();
    this.playbackEndsAtMs = 0;
    this.ttsBracketOpen = false;

    try {
      const wav = pcm16ToWav(pcm, SAMPLE_RATE_IN);
      this.logger.log('Transcribing (STT)...');
      const userText = (await this.providers.stt.transcribe(wav)).trim();
      if (this.isStale(turn)) return;

      if (!userText) {
        this.logger.log('STT produced no text; skipping turn');
        this.speaking = false;
        return;
      }
      this.logger.log(`STT: "${userText}"`);
      this.send(buildStt(userText, this.sessionId));
      // The tts start bracket is NOT sent here: the device starts its talking
      // animation the moment it enters Speaking, which would run soundless for
      // the ~1s of LLM + TTS latency. sendAudioFramePaced opens the bracket
      // just-in-time before the first audio frame.
      this.logger.log('Generating reply (LLM -> TTS)...');

      let spokeAnything = false;
      for await (const sentence of this.sentences(
        this.providers.llm.reply(this.sessionId, userText, this.tools, () =>
          this.isStale(turn),
        ),
      )) {
        if (this.isStale(turn)) return;
        spokeAnything = true;
        await this.speakSentence(sentence, turn);
        if (this.isStale(turn)) return;
      }
      if (!spokeAnything) this.logger.log('LLM produced no reply text');
      else {
        // Hold the tts stop until the buffered tail (~TTS_PREBUFFER_MS) has
        // actually played, so the bracket tracks real speech: the device may
        // treat stop as end-of-audio, and `speaking` should stay true while
        // sound is still coming out. (An abort during this sleep has already
        // sent its own tts stop; the staleness checks make the rest a no-op.)
        if (this.isStale(turn)) return;
        const tailMs = this.playbackEndsAtMs - monotonicMs();
        if (tailMs > 0) await sleep(tailMs);
        if (this.isStale(turn)) return;
        this.logger.log('Turn complete');
      }
    } catch (err) {
      this.logger.error(`Turn failed: ${asMessage(err)}`);
    } finally {
      // Only close the bracket if this turn is still the active one; an abort
      // that superseded us already sent its own tts stop.
      if (!this.isStale(turn)) {
        this.speaking = false;
        // Invalidate scheduled sentence text before closing the bracket: a
        // turn that ends through the error path skips the tail drain and can
        // leave a text timer armed up to TTS_PREBUFFER_MS out — firing after
        // the stop would paint a sentence that was never spoken.
        this.turnId++;
        this.sendTtsStop();
        // Realtime-mode firmware sends `listen start` exactly once and then
        // streams the mic forever — entering Speaking never stops its audio
        // processor, so returning to Listening skips SendStartListening
        // (application.cc). Re-arm ourselves or the session goes deaf after
        // the first turn.
        if (this.listenMode === 'realtime') this.rearmListening();
      }
    }
  }

  /**
   * Synthesize one sentence and stream its opus frames downstream. The
   * sentence_start text is scheduled for the projected playback start of the
   * sentence's first frame — NOT sent when the audio bytes are: frames run up
   * to TTS_PREBUFFER_MS ahead of the speaker, and the device renders the text
   * on receipt, so sending eagerly flashes sentence N+1 on screen while
   * sentence N is still being spoken.
   */
  private async speakSentence(sentence: string, turn: number): Promise<void> {
    let announced = false;
    const announceAt = (playsAtMs: number): void => {
      announced = true;
      this.sendAtPlaybackTime(buildTtsSentenceStart(sentence, this.sessionId), playsAtMs, turn);
    };
    for await (const pcmChunk of this.providers.tts.synthesize(sentence)) {
      if (this.isStale(turn)) return;
      for (const packet of this.codec.encodeDownstreamPcm(pcmChunk)) {
        if (this.isStale(turn)) return;
        const playsAtMs = await this.sendAudioFramePaced(packet, turn);
        if (!announced && playsAtMs !== null) announceAt(playsAtMs);
      }
    }
    // Emit this sentence's trailing partial frame so nothing is dropped and the
    // next sentence starts on a clean frame boundary.
    if (this.isStale(turn)) return;
    for (const packet of this.codec.flushDownstream()) {
      const playsAtMs = await this.sendAudioFramePaced(packet, turn);
      if (!announced && playsAtMs !== null) announceAt(playsAtMs);
    }
    // A sentence whose TTS yielded no audio still gets its text, once any
    // buffered audio before it has played out. Scheduled 1ms inside the
    // end-of-turn drain so the turn-closing turnId bump can't cancel it on an
    // exact timer tie.
    if (!announced && !this.isStale(turn)) announceAt(this.playbackEndsAtMs - 1);
  }

  /**
   * Send one 60ms downstream opus frame, paced to real time so the device's
   * small decode queue never overflows (see TTS_PREBUFFER_MS). The first
   * TTS_PREBUFFER_MS of a turn bursts out to build a cushion against network
   * jitter and inter-sentence TTS latency; after that frames flow at the
   * real-time cadence. The clock resets to "now" whenever we fall behind
   * (start of turn, or a pipeline stall drained the device), so a stall never
   * causes a catch-up burst bigger than the prebuffer.
   *
   * Returns the projected wall-clock ms at which this frame starts PLAYING on
   * the device (the value sentence text is scheduled against), or null if the
   * turn went stale and nothing was sent.
   */
  private async sendAudioFramePaced(packet: Buffer, turn: number): Promise<number | null> {
    // Open the speaking bracket just-in-time: the device must be in Speaking
    // to decode opus, but entering it also starts the talking animation, so
    // the start is held until there is audio to play. The firmware applies
    // the state change on its main task while binary frames are checked on
    // the receive task — give the change one frame to land or the first
    // packet would be silently discarded.
    if (!this.ttsBracketOpen) {
      this.ttsBracketOpen = true;
      this.send(buildTtsStart(this.sessionId));
      this.send(buildLlm('neutral', this.sessionId));
      await sleep(FRAME_DURATION_MS);
      if (this.isStale(turn)) return null;
    }
    // Backpressure: if the device's TCP connection stalls, ws.send() only
    // buffers — hold pacing so recovery delivers at most a prebuffer's worth
    // plus this backlog, instead of the whole stall's frames at once.
    while (this.ws.bufferedAmount > SOCKET_BACKLOG_LIMIT_BYTES) {
      await sleep(FRAME_DURATION_MS);
      if (this.isStale(turn)) return null;
    }
    const now = monotonicMs();
    if (this.playbackEndsAtMs < now) this.playbackEndsAtMs = now;
    const aheadMs = this.playbackEndsAtMs - now;
    if (aheadMs > TTS_PREBUFFER_MS) {
      await sleep(aheadMs - TTS_PREBUFFER_MS);
      if (this.isStale(turn)) return null;
    }
    const playsAtMs = this.playbackEndsAtMs;
    this.playbackEndsAtMs += FRAME_DURATION_MS;
    this.sendBinary(packet);
    return playsAtMs;
  }

  /**
   * Send a control message when the device's playback clock reaches
   * `playsAtMs`, so on-screen text tracks what is being heard rather than the
   * (up to TTS_PREBUFFER_MS earlier) moment its audio bytes were sent. A fire
   * after the turn ended (abort, error-path tts stop, new turn, close) is
   * dropped by the staleness check.
   */
  private sendAtPlaybackTime(msg: ServerMessage, playsAtMs: number, turn: number): void {
    const delayMs = playsAtMs - monotonicMs();
    if (delayMs <= 0) {
      this.send(msg);
      return;
    }
    setTimeout(() => {
      if (!this.isStale(turn)) this.send(msg);
    }, delayMs);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Monotonic milliseconds for the pacing clock — immune to wall-clock steps
 * (NTP corrections) that would stall or burst mid-reply audio with Date.now().
 */
function monotonicMs(): number {
  return performance.now();
}

/** RMS amplitude of a PCM16LE mono buffer (0..32767), for voice-activity detection. */
function frameRms(pcm: Buffer): number {
  const n = pcm.length >> 1;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}
