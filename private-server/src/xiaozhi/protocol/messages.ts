/**
 * Xiaozhi WebSocket protocol message types + frame builders.
 *
 * These mirror the contract the firmware enforces
 * (firmware/xiaozhi-esp32/main/protocols/websocket_protocol.cc, protocol.cc,
 * application.cc). Control messages travel as JSON TEXT frames; audio travels
 * as RAW OPUS BINARY frames (websocket protocol version 1, no header).
 *
 * This file imports NOTHING external so every other component can depend on it.
 */

/* --------------------------------- Audio ---------------------------------- */

/** Upstream (device -> server) opus sample rate. */
export const SAMPLE_RATE_IN = 16000;
/** Downstream (server -> device) opus sample rate. */
export const SAMPLE_RATE_OUT = 24000;
/** Opus frame duration in milliseconds (both directions). */
export const FRAME_DURATION_MS = 60;
/** Mono. */
export const CHANNELS = 1;
/** Samples per upstream frame: 16000 Hz * 60 ms. */
export const FRAME_SAMPLES_IN = 960;
/** Samples per downstream frame: 24000 Hz * 60 ms. */
export const FRAME_SAMPLES_OUT = 1440;

/* ----------------------------- Message types ------------------------------ */

/** Audio params block exchanged in hello frames. */
export interface AudioParams {
  format?: string;
  sample_rate: number;
  channels?: number;
  frame_duration: number;
}

/** Client hello sent by the device immediately after the socket opens. */
export interface ClientHelloMessage {
  type: 'hello';
  version: number;
  transport: 'websocket';
  features?: { mcp?: boolean; [key: string]: unknown };
  audio_params: AudioParams;
}

/** Server hello the device waits (<=10s) for before it aborts. */
export interface ServerHelloMessage {
  type: 'hello';
  transport: 'websocket';
  session_id: string;
  audio_params: AudioParams;
}

/** device -> server: microphone turn-taking control. */
export interface ListenMessage {
  type: 'listen';
  session_id?: string;
  state: 'start' | 'stop' | 'detect';
  mode?: 'realtime' | 'auto' | 'manual';
  text?: string;
}

/** device -> server: abort the current response. */
export interface AbortMessage {
  type: 'abort';
  session_id?: string;
  reason?: string;
}

/** device <-> server: Model Context Protocol passthrough (JSON-RPC payload). */
export interface McpMessage {
  type: 'mcp';
  session_id?: string;
  payload: unknown;
}

/** server -> device: text-to-speech lifecycle + sentence markers. */
export interface TtsMessage {
  type: 'tts';
  session_id?: string;
  state: 'start' | 'stop' | 'sentence_start';
  text?: string;
}

/** server -> device: recognized user speech. */
export interface SttMessage {
  type: 'stt';
  session_id?: string;
  text: string;
}

/** server -> device: emotion / assistant metadata for the avatar. */
export interface LlmMessage {
  type: 'llm';
  session_id?: string;
  emotion?: string;
  text?: string;
}

/** Any control frame the device may send us. */
export type DeviceMessage =
  | ClientHelloMessage
  | ListenMessage
  | AbortMessage
  | McpMessage;

/** Any control frame we may send the device. */
export type ServerMessage =
  | ServerHelloMessage
  | TtsMessage
  | SttMessage
  | LlmMessage
  | McpMessage;

/* ----------------------------- Frame builders ----------------------------- */

/**
 * Build the server hello. `transport` MUST be the literal "websocket" (the
 * firmware dereferences transport->valuestring). `audio_params.sample_rate`
 * sets the DOWNSTREAM opus rate the device decodes at (24000).
 */
export function buildServerHello(sessionId: string): ServerHelloMessage {
  return {
    type: 'hello',
    transport: 'websocket',
    session_id: sessionId,
    audio_params: {
      sample_rate: SAMPLE_RATE_OUT,
      frame_duration: FRAME_DURATION_MS,
    },
  };
}

/** {"type":"tts","state":"start"} — must precede any downstream opus. */
export function buildTtsStart(sessionId?: string): TtsMessage {
  return { type: 'tts', state: 'start', session_id: sessionId };
}

/** {"type":"tts","state":"stop"} — must follow the last downstream opus. */
export function buildTtsStop(sessionId?: string): TtsMessage {
  return { type: 'tts', state: 'stop', session_id: sessionId };
}

/** Optional per-sentence marker so the avatar can show the spoken text. */
export function buildTtsSentenceStart(
  text: string,
  sessionId?: string,
): TtsMessage {
  return { type: 'tts', state: 'sentence_start', text, session_id: sessionId };
}

/** Report the recognized user utterance back to the device. */
export function buildStt(text: string, sessionId?: string): SttMessage {
  return { type: 'stt', text, session_id: sessionId };
}

/** Report assistant emotion/metadata to drive the avatar. */
export function buildLlm(emotion: string, sessionId?: string): LlmMessage {
  return { type: 'llm', emotion, session_id: sessionId };
}

/** Serialize any server message to the JSON TEXT payload sent over the socket. */
export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

/**
 * Parse a device TEXT frame into a typed message, or null if it is not valid
 * JSON / lacks a string `type`.
 */
export function parseDeviceMessage(data: string): DeviceMessage | null {
  try {
    const obj = JSON.parse(data) as { type?: unknown };
    if (obj && typeof obj.type === 'string') {
      return obj as DeviceMessage;
    }
  } catch {
    // fall through
  }
  return null;
}
