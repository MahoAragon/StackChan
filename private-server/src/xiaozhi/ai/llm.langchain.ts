/**
 * LangChain-backed LLM provider targeting an OpenAI-compatible server
 * (llama.cpp `/v1/chat/completions`). Streams the assistant reply as text
 * chunks and keeps per-session conversation history so each ws connection gets
 * a coherent multi-turn dialogue. No cloud keys required — the base URL and a
 * dummy API key point at the local server.
 */

import { ChatOpenAI } from '@langchain/openai';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';

import { XiaozhiConfig } from '../config';
import { LlmProvider } from './provider.interface';

/** Keep at most this many user/assistant messages (excludes the system turn). */
const MAX_HISTORY_MESSAGES = 40; // ~20 turns

export class LangChainLlmProvider implements LlmProvider {
  private readonly model: ChatOpenAI;
  private readonly systemPrompt: string;
  /** Per-session running history (user + assistant messages only). */
  private readonly histories = new Map<string, BaseMessage[]>();

  constructor(config: XiaozhiConfig) {
    this.systemPrompt = config.llm.systemPrompt;
    this.model = new ChatOpenAI({
      model: config.llm.model,
      apiKey: config.llm.apiKey,
      streaming: true,
      configuration: { baseURL: config.llm.baseUrl },
    });
  }

  /**
   * Stream a reply for one user turn. Prepends the system prompt, appends the
   * user message, streams assistant deltas, and once complete stores the full
   * assistant reply back into the session history (capped).
   */
  async *reply(sessionId: string, userText: string): AsyncIterable<string> {
    const history = this.histories.get(sessionId) ?? [];
    history.push(new HumanMessage(userText));

    const messages: BaseMessage[] = [
      new SystemMessage(this.systemPrompt),
      ...history,
    ];

    let full = '';
    try {
      const stream = await this.model.stream(messages);
      for await (const chunk of stream) {
        const text = chunkToText(chunk.content);
        if (text) {
          full += text;
          yield text;
        }
      }
    } finally {
      // Persist whatever we managed to produce so context survives errors.
      history.push(new AIMessage(full));
      this.trim(history);
      this.histories.set(sessionId, history);
    }
  }

  /** Drop a ws session's history (call on disconnect). */
  forget(sessionId: string): void {
    this.histories.delete(sessionId);
  }

  /** Keep only the most recent messages to bound memory/context growth. */
  private trim(history: BaseMessage[]): void {
    if (history.length > MAX_HISTORY_MESSAGES) {
      history.splice(0, history.length - MAX_HISTORY_MESSAGES);
    }
  }
}

/**
 * ChatOpenAI message content is either a plain string or an array of content
 * parts; normalize both to a text delta.
 */
function chunkToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : part && typeof part === 'object' && 'text' in part
            ? String((part as { text: unknown }).text ?? '')
            : '',
      )
      .join('');
  }
  return '';
}
