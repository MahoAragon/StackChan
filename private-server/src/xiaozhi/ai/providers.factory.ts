/**
 * Wires the three concrete voice-pipeline providers together behind the generic
 * `Providers` bundle. Callers depend only on the interfaces in
 * provider.interface.ts, so swapping a backend is a one-line change here.
 */
import type { XiaozhiConfig } from '../config';
import type { Providers } from './provider.interface';
import { OpenAiCompatSttProvider } from './stt.openai';
import { WhisperCppSttProvider } from './stt.whispercpp';
import { LangChainLlmProvider } from './llm.langchain';
import { OpenAiCompatTtsProvider } from './tts.openai';

/** News up the concrete STT / LLM / TTS providers from runtime config. */
export function createProviders(config: XiaozhiConfig): Providers {
  return {
    stt:
      config.stt.backend === 'whispercpp'
        ? new WhisperCppSttProvider(config)
        : new OpenAiCompatSttProvider(config),
    llm: new LangChainLlmProvider(config),
    tts: new OpenAiCompatTtsProvider(config),
  };
}
