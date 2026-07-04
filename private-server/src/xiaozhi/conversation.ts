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
  FRAME_SAMPLES_OUT,
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
//
// This VAD is not a fallback: with AEC on, the firmware listens in REALTIME
// mode and never sends `listen stop` (application.cc:952 picks
// kListeningModeRealtime whenever aec_mode_ != kAecOff), so this is the only
// thing that ends an utterance on real hardware.
//
// Speech is classified against an ADAPTIVE threshold derived from a running
// ambient-noise estimate, not a fixed RMS: a fixed cutoff tuned for one
// room/voice silently breaks in another — set too high, normal speech never
// registers, the session "keeps listening", and only a louder repeat ends the
// turn with BOTH sentences in the buffer. VAD_RMS_THRESHOLD (legacy) pins a
// fixed threshold and disables adaptation, as an escape hatch for tuning.
const VAD_FIXED_RMS = Number(process.env.VAD_RMS_THRESHOLD ?? 0);
/** Attack threshold never drops below this, however quiet the room gets. */
const VAD_RMS_FLOOR = Number(process.env.VAD_RMS_FLOOR ?? 250);
/** Speech starts at noiseFloor * this (attack)... */
const VAD_SPEECH_FACTOR = Number(process.env.VAD_SPEECH_FACTOR ?? 3.0);
/** ...and continues down to noiseFloor * this (release) — hysteresis. */
const VAD_RELEASE_FACTOR = Number(process.env.VAD_RELEASE_FACTOR ?? 2.0);
const VAD_HANGOVER_MS = Number(process.env.VAD_HANGOVER_MS ?? 800);
const MAX_UTTERANCE_MS = Number(process.env.MAX_UTTERANCE_MS ?? 15000);
/** Where the noise estimate starts before any audio has been heard. */
const VAD_NOISE_FLOOR_INIT = 150;
/**
 * Ceiling on the noise estimate. Quiet-but-audible speech misread as noise
 * would otherwise ratchet the floor (and with it the attack threshold) up
 * until nothing registers as speech — the exact failure this VAD replaces.
 */
const VAD_NOISE_FLOOR_MAX = 350;
/**
 * Consecutive above-threshold frames before they count as speech. A single
 * 60ms spike (servo click, tap) would otherwise reset the accumulated
 * silence and stretch the turn.
 */
const VAD_SPEECH_DEBOUNCE_FRAMES = 2;

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

/**
 * Server events waiting for a quiet moment (bounded so a runaway producer
 * can't build an hour-long backlog the robot then dutifully recites).
 */
const SERVER_EVENT_QUEUE_MAX = 8;

/**
 * How long the conversation must have been quiet (no reply playing, no user
 * speech, no listen/abort control traffic) before a queued server event may
 * start. Closes the race where an event fires in the instant between the
 * user starting to interact and the VAD registering their voice (~2 frames),
 * and keeps notifications from slamming in the moment a reply ends.
 */
const EVENT_QUIET_GRACE_MS = Number(process.env.EVENT_QUIET_GRACE_MS ?? 2000);

/** Sentence boundaries shared by the LLM-delta splitter and fixed-text events. */
const SENTENCE_BOUNDARY = /(?<=[.!?。！？\n])/;

/**
 * A server-initiated event played over the conversation socket: speak text
 * via TTS, or play a pre-decoded sound (PCM16 mono 24k). Both ride the same
 * tts start/stop bracket as a normal reply because the firmware only decodes
 * downstream opus in the Speaking state — which also means the device runs
 * its talking animation for sounds; that is a firmware constraint, not a
 * choice. Expression-only pushes don't queue (see sendEmotion).
 */
export type ServerEvent =
  | { kind: 'say'; text: string; emotion?: string }
  | { kind: 'sound'; pcm: Buffer; label: string };

/** Immediate outcome of posting a server event (delivery is asynchronous). */
export type ServerEventPost = 'playing' | 'queued' | 'queue-full';

/** Final outcome of one delivered server event. */
export type ServerEventResult = 'completed' | 'preempted' | 'failed';

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
  /** Currently inside a speech run (hysteresis: releases lower than it attacks). */
  private inSpeech = false;
  /** Consecutive above-threshold frames (debounce before a run starts). */
  private speechRun = 0;
  /**
   * Ambient-noise RMS estimate. Persists across utterances — it describes the
   * room, not the turn. Falls quickly, rises slowly (asymmetric EMA), so a
   * burst of misclassified speech cannot drag it up much before the next
   * inter-word gap pulls it back down.
   */
  private noiseFloor = VAD_NOISE_FLOOR_INIT;

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

  /**
   * Emotion sent in the llm frame when this turn's tts bracket opens. Normal
   * turns use 'neutral' (the LLM has no emotion channel yet); say-events carry
   * their requested emotion; sound-events set null to leave the face alone.
   */
  private bracketEmotion: string | null = 'neutral';

  /** Server events awaiting a quiet gap in the conversation (FIFO). */
  private pendingEvents: ServerEvent[] = [];
  /** True while the drain loop below is delivering queued events. */
  private drainingEvents = false;
  /**
   * Monotonic ms of the last conversation activity (listen/abort control
   * frames, detected user speech, end of a reply). Server events wait until
   * this is at least EVENT_QUIET_GRACE_MS in the past.
   */
  private lastActivityAtMs = 0;

  constructor(
    private readonly ws: WebSocket,
    private readonly codec: AudioCodec,
    private readonly providers: Providers,
    private readonly sessionId: string,
    /** Session tool catalog (server + MCP device tools) the LLM may call. */
    private readonly tools?: ToolSource,
  ) {}

  /* ------------------------------ Control ------------------------------- */

  /** True while a reply or server event is being spoken. */
  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** True while the mic is being buffered (always true in realtime mode). */
  get isListening(): boolean {
    return this.listening;
  }

  /**
   * True while an utterance with detected speech is in flight. Plain
   * `listening` must not gate server events: realtime-mode firmware streams
   * the mic forever, so the session is "listening" even when nobody talks.
   */
  get isUserTalking(): boolean {
    return this.listening && this.sawSpeech;
  }

  /** Server events still waiting to be delivered. */
  get queuedEventCount(): number {
    return this.pendingEvents.length;
  }

  /**
   * True when a server event must not start: a reply/event is being spoken,
   * the user is audibly talking, or a device-initiated listen window is open.
   * The window check is mode-aware: auto/manual arm listening only when the
   * user explicitly asked to talk (an event would hijack their utterance),
   * while realtime keeps listening forever, so there it cannot gate and
   * `isUserTalking` + the quiet grace carry the load.
   */
  private get busyForEvents(): boolean {
    return (
      this.speaking ||
      this.isUserTalking ||
      (this.listening && this.listenMode !== 'realtime')
    );
  }

  /**
   * Queue a server-initiated event (notification speech, a sound). Delivered
   * once the conversation has been quiet for EVENT_QUIET_GRACE_MS; a busy
   * session (speaking, user talking, or an armed listen window) delivers it
   * when the turn ends. The user wins mid-delivery too: anything that makes
   * the device send `listen start` or `abort` (wake word, tap) cancels an
   * in-flight event exactly like it cancels a normal reply.
   */
  postEvent(event: ServerEvent): ServerEventPost {
    if (this.pendingEvents.length >= SERVER_EVENT_QUEUE_MAX) return 'queue-full';
    this.pendingEvents.push(event);
    if (this.drainingEvents || this.busyForEvents) {
      return 'queued';
    }
    void this.drainServerEvents();
    return 'playing';
  }

  /**
   * Push an expression change immediately, whatever the device is doing —
   * the firmware applies llm frames in any state. Transient by design: the
   * next spoken turn/event opens with its own emotion frame.
   */
  sendEmotion(emotion: string): void {
    this.send(buildLlm(emotion, this.sessionId));
  }

  /** listen state=start | detect — begin a fresh utterance. */
  onListenStart(mode?: string): void {
    // A new utterance supersedes anything we might still be saying.
    this.abort();
    this.lastActivityAtMs = monotonicMs();
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
    this.inSpeech = false;
    this.speechRun = 0;
    // noiseFloor deliberately NOT reset: the room didn't change.
  }

  /** listen state=stop from the device — end of utterance. */
  onListenStop(): void {
    this.endUtterance('device-stop');
  }

  /** abort — stop buffering and cut off any response in progress. */
  abort(): void {
    this.listening = false;
    this.pcmChunks = [];
    this.lastActivityAtMs = monotonicMs();
    if (this.speaking) {
      // Bump the turn id so the streaming loop stops, then close out the tts
      // bracket the device is expecting.
      this.turnId++;
      this.speaking = false;
      this.sendTtsStop();
    }
    // A standalone abort (wake-word tap that leads nowhere) may be the last
    // signal for a while — don't strand queued events behind it. The drain's
    // quiet grace keeps this from talking over the turn that usually follows.
    this.maybeDrainServerEvents();
  }

  /** Called when the socket closes so no async loop keeps sending. */
  dispose(): void {
    this.turnId++;
    this.listening = false;
    this.speaking = false;
    this.pcmChunks = [];
    this.pendingEvents = [];
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

    const attack =
      VAD_FIXED_RMS > 0
        ? VAD_FIXED_RMS
        : Math.max(VAD_RMS_FLOOR, this.noiseFloor * VAD_SPEECH_FACTOR);
    const release =
      VAD_FIXED_RMS > 0
        ? VAD_FIXED_RMS
        : Math.max(VAD_RMS_FLOOR * 0.8, this.noiseFloor * VAD_RELEASE_FACTOR);

    if (rms >= (this.inSpeech ? release : attack)) {
      this.speechRun++;
      if (this.inSpeech || this.speechRun >= VAD_SPEECH_DEBOUNCE_FRAMES) {
        if (!this.sawSpeech) {
          this.logger.log(
            `Speech detected (rms=${Math.round(rms)}, attack=${Math.round(attack)}, floor=${Math.round(this.noiseFloor)})`,
          );
        }
        this.inSpeech = true;
        this.sawSpeech = true;
        this.speechFrames++;
        this.silenceFrames = 0;
        this.lastActivityAtMs = monotonicMs();
      }
      // else: an isolated spike — don't reset the silence run for it.
    } else {
      this.speechRun = 0;
      this.inSpeech = false;
      if (this.sawSpeech) this.silenceFrames++;
      // Only non-speech frames teach the noise estimate; fall fast, rise slow.
      this.noiseFloor =
        rms < this.noiseFloor
          ? this.noiseFloor * 0.7 + rms * 0.3
          : Math.min(VAD_NOISE_FLOOR_MAX, this.noiseFloor * 0.98 + rms * 0.02);
    }

    if (this.framesReceived % LOG_EVERY_FRAMES === 0) {
      this.logger.log(
        `...listening ${((this.framesReceived * FRAME_DURATION_MS) / 1000).toFixed(1)}s ` +
          `(peakRms=${Math.round(this.peakRms)}, speech=${this.sawSpeech}, silence=${this.silenceFrames}f, ` +
          `floor=${Math.round(this.noiseFloor)}, attack=${Math.round(attack)})`,
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
    this.lastActivityAtMs = monotonicMs();
    const pcm = Buffer.concat(this.pcmChunks);
    this.pcmChunks = [];
    if (pcm.length === 0) {
      this.logger.warn(`Utterance ended (${trigger}) with no audio; ignoring`);
      // No turn will run, so nothing else re-kicks queued server events.
      this.maybeDrainServerEvents();
      return;
    }
    const secs = (pcm.length / 2 / SAMPLE_RATE_IN).toFixed(1);
    this.logger.log(
      `Utterance ended (${trigger}, ${secs}s, ${this.framesReceived} frames, ` +
        `peakRms=${Math.round(this.peakRms)}, floor=${Math.round(this.noiseFloor)}) -> running turn`,
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
    this.bracketEmotion = 'neutral';

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
        // The turn is over — deliver any server events that queued behind it
        // (after the quiet grace, so they don't slam in as the reply ends).
        this.lastActivityAtMs = monotonicMs();
        this.maybeDrainServerEvents();
      }
    }
  }

  /* --------------------------- Server events ---------------------------- */

  /** Kick the event queue unless the session is busy or already draining. */
  private maybeDrainServerEvents(): void {
    if (this.pendingEvents.length === 0 || this.drainingEvents) return;
    if (this.busyForEvents) return;
    void this.drainServerEvents();
  }

  /**
   * Deliver queued server events one at a time until the queue is empty or a
   * user turn takes over (that turn's finally re-kicks the drain). Never runs
   * concurrently with itself (`drainingEvents`), and posting while a delivery
   * is in flight just extends the queue this loop is already consuming.
   *
   * Every delivery waits for EVENT_QUIET_GRACE_MS of conversation silence
   * first. This is what makes a preemption final: right after a barge-in the
   * VAD hasn't seen speech yet (sawSpeech lags by the debounce), so without
   * the grace this loop would start the next event over the user's opening
   * words.
   */
  private async drainServerEvents(): Promise<void> {
    this.drainingEvents = true;
    try {
      while (this.pendingEvents.length > 0) {
        if (this.ws.readyState !== WebSocket.OPEN) {
          this.pendingEvents = [];
          return;
        }
        if (this.busyForEvents) return; // re-kicked when the turn ends
        const quietForMs = monotonicMs() - this.lastActivityAtMs;
        if (quietForMs < EVENT_QUIET_GRACE_MS) {
          await sleep(EVENT_QUIET_GRACE_MS - quietForMs);
          continue; // re-check busy/quiet — activity may have resumed
        }
        const event = this.pendingEvents.shift();
        if (!event) return;
        const label =
          event.kind === 'say'
            ? `say "${truncateForLog(event.text)}"`
            : `sound "${event.label}"`;
        this.logger.log(`Server event: ${label}`);
        const result = await this.runServerEvent(event);
        this.logger.log(`Server event ${result}: ${label}`);
        // On preemption loop around rather than bail: the busy/quiet checks
        // yield to whatever interrupted us, and if it was a lone abort (no
        // turn follows to re-kick), the remaining events still drain.
      }
    } finally {
      this.drainingEvents = false;
    }
  }

  /**
   * Play one server event as its own tts-bracketed pseudo-turn, reusing the
   * turn machinery (just-in-time bracket, pacing, backpressure, staleness) so
   * pushed speech is indistinguishable from a reply and the device can never
   * be left stuck in Speaking.
   */
  private async runServerEvent(event: ServerEvent): Promise<ServerEventResult> {
    const turn = ++this.turnId;
    this.speaking = true;
    // Realtime-mode firmware streams the mic even while we speak; drop those
    // frames during the event and re-arm below, exactly like runTurn does for
    // replies. Mid-event preemption therefore comes from device control
    // frames (`listen start`/`abort` — wake word, tap), not from raw speech,
    // the same contract normal replies have.
    this.listening = false;
    this.codec.resetDownstream();
    this.playbackEndsAtMs = 0;
    this.ttsBracketOpen = false;
    this.bracketEmotion =
      event.kind === 'say' ? (event.emotion ?? 'neutral') : null;

    let outcome: ServerEventResult = 'completed';
    try {
      if (event.kind === 'say') {
        for (const sentence of splitIntoSentences(event.text)) {
          if (this.isStale(turn)) break;
          await this.speakSentence(sentence, turn);
        }
      } else {
        // Encode incrementally, a chunk ahead of the paced sends — encoding
        // a long WAV in one synchronous pass would block the event loop for
        // the whole file before its first frame leaves.
        const chunkBytes = FRAME_SAMPLES_OUT * 2 * 10; // ~600ms of PCM
        for (
          let off = 0;
          off < event.pcm.length && !this.isStale(turn);
          off += chunkBytes
        ) {
          const chunk = event.pcm.subarray(off, off + chunkBytes);
          for (const packet of this.codec.encodeDownstreamPcm(chunk)) {
            if (this.isStale(turn)) break;
            await this.sendAudioFramePaced(packet, turn);
          }
        }
        if (!this.isStale(turn)) {
          for (const packet of this.codec.flushDownstream()) {
            await this.sendAudioFramePaced(packet, turn);
          }
        }
      }
      // Drain the buffered tail so the bracket tracks real sound (see runTurn).
      if (!this.isStale(turn)) {
        const tailMs = this.playbackEndsAtMs - monotonicMs();
        if (tailMs > 0) await sleep(tailMs);
      }
    } catch (err) {
      outcome = 'failed';
      this.logger.error(`Server event failed: ${asMessage(err)}`);
    } finally {
      if (this.isStale(turn)) {
        // A user turn/abort superseded us and already sent its own tts stop.
        if (outcome !== 'failed') outcome = 'preempted';
      } else {
        this.speaking = false;
        this.turnId++;
        this.sendTtsStop();
        if (this.listenMode === 'realtime') this.rearmListening();
      }
    }
    return outcome;
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
      if (this.bracketEmotion !== null) {
        this.send(buildLlm(this.bracketEmotion, this.sessionId));
      }
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
      const parts = buf.split(SENTENCE_BOUNDARY);
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

/** Split fixed event text on the same boundaries as the streaming splitter. */
function splitIntoSentences(text: string): string[] {
  return text
    .split(SENTENCE_BOUNDARY)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function truncateForLog(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
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
