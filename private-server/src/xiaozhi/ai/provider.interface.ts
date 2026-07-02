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

/** One callable tool, described in OpenAI function-calling terms. */
export interface ToolSpec {
  /** Function name the model calls ([a-zA-Z0-9_-] only). */
  name: string;
  description: string;
  /** JSON Schema of the arguments object ({type:'object', properties, ...}). */
  parameters: Record<string, unknown>;
}

/**
 * The tools available to one conversation session. `list()` is re-read every
 * turn because device tools appear asynchronously (MCP discovery finishes
 * shortly after the websocket opens).
 */
export interface ToolSource {
  list(): ToolSpec[];
  /**
   * Run a tool. Never rejects for tool-level failures — errors come back as a
   * result string so the model can react to them in conversation.
   */
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}

/** Large language model: stream an assistant reply as text chunks. */
export interface LlmProvider {
  /**
   * Produce a streamed reply for one user turn. Implementations keep per-session
   * conversation history keyed by `sessionId`. When `tools` is given, the model
   * may call them (tool round-trips happen inside this generator; only the
   * spoken text is yielded).
   *
   * @param cancelled polled between internal steps: an async generator only
   *        observes its consumer's early return at a yield, so without this an
   *        aborted turn would keep executing tools and model hops.
   * @returns an async iterable of text chunks (deltas) making up the reply.
   */
  reply(
    sessionId: string,
    userText: string,
    tools?: ToolSource,
    cancelled?: () => boolean,
  ): AsyncIterable<string>;

  /** Release any per-session state (history); call when the session ends. */
  forget?(sessionId: string): void;
}

/** Vision-language model: answer a question about a JPEG camera photo. */
export interface VisionProvider {
  describe(question: string, jpeg: Buffer): Promise<string>;
}

/** Text-to-speech: stream synthesized audio for the given text. */
export interface TtsProvider {
  /** @returns async iterable of PCM16 mono 24 kHz audio chunks. */
  synthesize(text: string): AsyncIterable<Buffer>;
}

/**
 * The providers a conversation session needs, bundled together. (The vision
 * provider is not here: it serves the HTTP photo-upload endpoint, which is
 * owned by XiaozhiVisionController.)
 */
export interface Providers {
  stt: SttProvider;
  llm: LlmProvider;
  tts: TtsProvider;
}
