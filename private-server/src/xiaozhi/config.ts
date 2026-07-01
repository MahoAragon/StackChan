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
  /** Shared bootstrap token handed to the device by the OTA endpoint. */
  token: string;
}

/** Dummy key for local OpenAI-compatible servers that don't check auth. */
const DUMMY_KEY = 'sk-local-dummy';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/** Build the runtime config from environment variables with localhost defaults. */
export function loadXiaozhiConfig(): XiaozhiConfig {
  return {
    llm: {
      baseUrl: env('LLM_BASE_URL', 'http://127.0.0.1:10000/v1'),
      apiKey: env('LLM_API_KEY', DUMMY_KEY),
      model: env('LLM_MODEL', 'default'),
      systemPrompt: env(
        'LLM_SYSTEM_PROMPT',
        'You are StackChan, a friendly desktop robot companion. ' +
          'Keep replies short, warm, and conversational.',
      ),
    },
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
    token: env('XIAOZHI_TOKEN', 'stackchan'),
  };
}
