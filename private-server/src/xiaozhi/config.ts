/**
 * Configuration for the local, cloud-free xiaozhi voice pipeline.
 *
 * Everything is wired to OpenAI-compatible HTTP servers running on localhost by
 * default (llama.cpp for the LLM, whisper for STT, a Kokoro/openedai/Piper style
 * server for TTS). API keys default to a dummy value because local servers do
 * not require real credentials. Reads process.env only — no external imports.
 */

export interface XiaozhiConfig {
  /** LLM: OpenAI-compatible /v1/chat/completions server (e.g. llama.cpp). */
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
  };
  /** STT: OpenAI-compatible /v1/audio/transcriptions server (whisper). */
  stt: {
    /** 'openai' = any OpenAI-compatible server; 'whispercpp' = native whisper.cpp. */
    backend: 'openai' | 'whispercpp';
    baseUrl: string;
    apiKey: string;
    model: string;
    language: string;
    /** whisper.cpp whisper-server /inference URL (used when backend='whispercpp'). */
    whisperCppUrl: string;
  };
  /** TTS: OpenAI-compatible /v1/audio/speech server (Kokoro/openedai/Piper). */
  tts: {
    baseUrl: string;
    apiKey: string;
    model: string;
    voice: string;
  };
  /**
   * Vision: OpenAI-compatible /v1/chat/completions server that accepts
   * image_url content parts (multimodal llama.cpp). Defaults to the LLM server
   * so a single multimodal model serves both chat and camera-photo questions.
   */
  vision: {
    baseUrl: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
    /**
     * Hard bound on one photo inference. The device waits at most 30s for the
     * response headers after uploading (esp-ml307 HttpClient default
     * timeout_ms_, http_client.h:101; Explain never raises it), so an answer
     * that takes longer is undeliverable — and with vision sharing the chat
     * llama.cpp by default, an orphaned request would also block the follow-up
     * turn. Must stay under 30s.
     */
    timeoutMs: number;
  };
  /** Shared bootstrap token handed to the device by the OTA endpoint. */
  token: string;
  /** Server-push device events API (events.controller.ts). */
  events: {
    /**
     * Bearer token external producers (hooks, notifiers) must present.
     * Empty = the events API is disabled. Unlike the advisory device tokens
     * above, this one IS enforced: the endpoint makes the robot speak
     * arbitrary text.
     */
    token: string;
    /** Directory of named notification sounds (WAV), relative to the CWD. */
    soundsDir: string;
    /**
     * Period of the JSON keepalive sent to idle device sockets; 0 disables.
     * Must stay well under 120000: the firmware marks the channel dead after
     * 120s without a data frame (protocol.cc IsTimeout) and may light-sleep.
     * The default gives a 3-missed-frame margin. Side effect while connected:
     * the device never enters light sleep / battery power-off — notification
     * targets should run docked.
     */
    keepaliveMs: number;
  };
}

/** Dummy key for local OpenAI-compatible servers that don't check auth. */
const DUMMY_KEY = 'sk-local-dummy';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/** Build the runtime config from environment variables with localhost defaults. */
export function loadXiaozhiConfig(): XiaozhiConfig {
  const llm = {
    baseUrl: env('LLM_BASE_URL', 'http://127.0.0.1:10000/v1'),
    apiKey: env('LLM_API_KEY', DUMMY_KEY),
    model: env('LLM_MODEL', 'default'),
    systemPrompt: env(
      'LLM_SYSTEM_PROMPT',
      'You are StackChan, a friendly desktop robot companion. ' +
        'Keep replies short, warm, and conversational. ' +
        'Your replies are read aloud by text-to-speech: never use emojis, ' +
        'emoticons, or other symbols that do not read well aloud.',
    ),
  };
  return {
    llm,
    stt: {
      backend:
        env('STT_BACKEND', 'whispercpp') === 'openai' ? 'openai' : 'whispercpp',
      baseUrl: env('STT_BASE_URL', 'http://127.0.0.1:8000/v1'),
      apiKey: env('STT_API_KEY', DUMMY_KEY),
      model: env('STT_MODEL', 'deepdml/faster-whisper-large-v3-turbo-ct2'),
      language: env('STT_LANGUAGE', 'en'),
      whisperCppUrl: env('STT_WHISPERCPP_URL', 'http://127.0.0.1:10010/inference'),
    },
    tts: {
      baseUrl: env('TTS_BASE_URL', 'http://127.0.0.1:50060/v1'),
      apiKey: env('TTS_API_KEY', DUMMY_KEY),
      model: env('TTS_MODEL', 'kokoro'),
      voice: env('TTS_VOICE', 'af_sky'),
    },
    vision: {
      baseUrl: env('VISION_BASE_URL', llm.baseUrl),
      apiKey: env('VISION_API_KEY', llm.apiKey),
      model: env('VISION_MODEL', llm.model),
      systemPrompt: env(
        'VISION_SYSTEM_PROMPT',
        'You are the eyes of StackChan, a desktop robot. The attached photo ' +
          'was just taken by your camera. Answer the question about it ' +
          'directly and concisely in one or two sentences; your answer is ' +
          'spoken aloud by the robot.',
      ),
      timeoutMs: Number(env('VISION_TIMEOUT_MS', '25000')),
    },
    token: env('XIAOZHI_TOKEN', 'stackchan'),
    events: {
      token: env('XIAOZHI_EVENTS_TOKEN', ''),
      soundsDir: env('XIAOZHI_SOUNDS_DIR', 'sounds'),
      keepaliveMs: Number(env('XIAOZHI_KEEPALIVE_MS', '30000')),
    },
  };
}

/**
 * The host:port a device should use to reach this server over HTTP/WS —
 * whichever host it already reached us on (works across LAN IPs), with
 * PUBLIC_WS_HOST as the explicit override. Shared by the OTA bootstrap
 * (websocket URL) and the MCP handshake (vision photo-upload URL).
 *
 * The port CANNOT be trusted to arrive in the Host header: the firmware's
 * HTTP client appends non-default ports (esp-ml307 http_client.cc:126-129, so
 * OTA requests carry "10.0.0.200:12800") but its WEBSOCKET client sends the
 * bare host (web_socket.cc:141-142). A URL built naively from a ws upgrade's
 * Host header therefore points at port 80 and the camera's photo upload dies
 * with "Failed to connect to explain URL". When the header has no port, take
 * it from the very TCP socket the device is connected on — by definition the
 * port it can reach us at. The last-resort constant only matters for clients
 * that omit the Host header entirely.
 */
export function resolvePublicHost(
  requestHost: string | undefined,
  socket?: { localAddress?: string; localPort?: number },
): string {
  const override = process.env.PUBLIC_WS_HOST;
  if (override) return override;
  if (requestHost) {
    // Port present? (colon after the last ']' so bracketed IPv6 works)
    const afterV6 = requestHost.slice(requestHost.lastIndexOf(']') + 1);
    if (afterV6.includes(':')) return requestHost;
    if (socket?.localPort) return `${requestHost}:${socket.localPort}`;
    return requestHost;
  }
  if (socket?.localAddress && socket.localPort) {
    // Node reports IPv4 on a dual-stack listener as "::ffff:10.0.0.200".
    const ip = socket.localAddress.replace(/^::ffff:/, '');
    const host = ip.includes(':') ? `[${ip}]` : ip;
    return `${host}:${socket.localPort}`;
  }
  return '10.0.0.200:12800';
}
