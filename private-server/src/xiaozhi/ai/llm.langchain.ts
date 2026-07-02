/**
 * LangChain-backed LLM provider targeting an OpenAI-compatible server
 * (llama.cpp `/v1/chat/completions`). Streams the assistant reply as text
 * chunks and keeps per-session conversation history so each ws connection gets
 * a coherent multi-turn dialogue. No cloud keys required — the base URL and a
 * dummy API key point at the local server.
 *
 * Tool calling: when the caller provides a ToolSource (server tools + the
 * device's MCP tools), the model is bound to those functions and this provider
 * runs the agent loop — stream a hop, execute any tool calls it requested,
 * append the results, stream the next hop — until a hop produces no tool
 * calls. Only spoken text is yielded; tool traffic stays inside the loop.
 * Text the model emits BEFORE a tool call ("Let me take a look…") is yielded
 * immediately, so the robot can speak while the tool (e.g. the camera) runs.
 * That preamble is kept as its own plain assistant message in history — the
 * OpenAI serializer nulls `content` on any message carrying tool_calls
 * (@langchain/openai chat_models.js:202), so text stored there would vanish
 * from every later request and the model would repeat itself.
 */

import { ChatOpenAI } from '@langchain/openai';
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { XiaozhiConfig } from '../config';
import { LlmProvider, ToolSource } from './provider.interface';

/** Keep at most this many user/assistant messages (excludes the system turn). */
const MAX_HISTORY_MESSAGES = 40; // ~20 turns

/**
 * Cap on model→tool→model round-trips inside ONE user turn. A photo turn uses
 * two hops (call take_photo, then speak the description); chained tool use
 * ("look, then nod") needs a couple more. The cap only exists so a model stuck
 * in a call-tool-forever loop cannot hold the turn open indefinitely.
 */
const MAX_TOOL_HOPS = 4;

export class LangChainLlmProvider implements LlmProvider {
  private readonly logger = new Logger('LangChainLLM');
  private readonly model: ChatOpenAI;
  /**
   * Same server, `streaming: false`. ChatOpenAI bakes `stream` into its
   * invocation params (chat_models.js invocationParams), so invoke() on the
   * streaming instance still sends stream:true — a real non-streaming fallback
   * for llama.cpp builds that reject tools+stream needs a second instance.
   */
  private readonly modelNoStream: ChatOpenAI;
  private readonly systemPrompt: string;
  /** Per-session running history (user + assistant messages only). */
  private readonly histories = new Map<string, BaseMessage[]>();
  /**
   * Monotonic per-session turn counter. Turns can overlap: the user can
   * interrupt while the previous reply generator is suspended in a tool call
   * (up to the MCP timeout), and an async generator only notices its
   * consumer's early return at the next yield. Each turn works on a COPY of
   * the history and only commits if it is still the newest turn, so a
   * superseded turn's late writes can never interleave into — or orphan tool
   * messages inside — the history a newer turn is already using.
   */
  private readonly generations = new Map<string, number>();

  constructor(config: XiaozhiConfig) {
    this.systemPrompt = config.llm.systemPrompt;
    const options = {
      model: config.llm.model,
      apiKey: config.llm.apiKey,
      configuration: { baseURL: config.llm.baseUrl },
    };
    this.model = new ChatOpenAI({ ...options, streaming: true });
    this.modelNoStream = new ChatOpenAI({ ...options, streaming: false });
  }

  /**
   * Stream a reply for one user turn. Prepends the system prompt, appends the
   * user message, streams assistant deltas (running the tool loop when tools
   * are available), and stores the full exchange back into the session history
   * (capped).
   *
   * @param cancelled polled between yields — before every hop and every tool
   *        execution — so an aborted turn stops driving the device and the
   *        model even while the generator is not suspended at a yield.
   */
  async *reply(
    sessionId: string,
    userText: string,
    tools?: ToolSource,
    cancelled?: () => boolean,
  ): AsyncIterable<string> {
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    const history = [...(this.histories.get(sessionId) ?? [])];
    history.push(new HumanMessage(userText));

    const specs = tools?.list() ?? [];
    const toolDefs = specs.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    let streamModel = specs.length ? this.model.bindTools(toolDefs) : this.model;
    let fallbackModel = specs.length
      ? this.modelNoStream.bindTools(toolDefs)
      : this.modelNoStream;

    const superseded = () =>
      this.generations.get(sessionId) !== generation || cancelled?.() === true;

    try {
      for (let hop = 0; ; hop++) {
        const messages: BaseMessage[] = [
          new SystemMessage(this.systemPrompt),
          ...history,
        ];

        let full = '';
        let toolCalls: ToolCall[] = [];
        let completed = false;
        try {
          for await (const delta of this.streamHop(messages, streamModel, fallbackModel)) {
            if (typeof delta === 'string') {
              full += delta;
              yield delta;
            } else {
              toolCalls = delta;
            }
          }
          completed = true;
        } finally {
          if (!completed) {
            // Consumer bailed mid-stream (turn aborted / socket gone). Persist
            // the partial text WITHOUT tool_calls: an assistant tool_calls
            // message with no tool results after it is invalid input on the
            // next request.
            history.push(new AIMessage(full));
            if (full) this.logger.log(`LLM (incomplete): "${full}"`);
          }
        }
        // Mirror the STT/tool-call logs with the response side of the turn.
        if (full) this.logger.log(`LLM: "${full}"`);

        if (!toolCalls.length || !tools) {
          history.push(new AIMessage(full));
          return;
        }
        // Preamble text goes into its OWN message (see file header): content
        // stored on the tool_calls message is nulled on re-serialization.
        if (full) history.push(new AIMessage(full));
        history.push(new AIMessage({ content: '', tool_calls: toolCalls }));

        if (hop >= MAX_TOOL_HOPS) {
          this.logger.warn(
            `Tool-hop cap (${MAX_TOOL_HOPS}) hit; answering without further calls`,
          );
          for (const tc of toolCalls) {
            history.push(toolResult(tc, 'Error: tool call limit reached for this turn'));
          }
          // Final hop runs with tools UNBOUND so it must produce text — a
          // model that keeps requesting tools could otherwise loop forever.
          streamModel = this.model;
          fallbackModel = this.modelNoStream;
          continue;
        }

        for (const tc of toolCalls) {
          // The user interrupted (or the socket died): do not drive the robot
          // any further. History is discarded by the commit guard below.
          if (superseded()) return;
          this.logger.log(`Tool call: ${tc.name}(${JSON.stringify(tc.args)})`);
          const result = await tools.execute(tc.name, tc.args ?? {});
          this.logger.log(
            `Tool result: ${tc.name} -> ${result.slice(0, 200)}${result.length > 200 ? '…' : ''}`,
          );
          history.push(toolResult(tc, result));
        }
        if (superseded()) return;
      }
    } finally {
      this.trim(history);
      // Commit only if still the newest turn — see `generations`. A superseded
      // turn's partial exchange is intentionally dropped: the user cut it off.
      if (this.generations.get(sessionId) === generation) {
        this.histories.set(sessionId, history);
      }
    }
  }

  /**
   * One model hop: yields text deltas as strings and finishes with a single
   * ToolCall[] item (possibly empty). Falls back to a genuinely non-streaming
   * call when streaming fails before producing anything — some llama.cpp
   * builds/templates only support tool calling without stream:true. The
   * fallback trades delta streaming for a working reply; the sentence pipeline
   * downstream is unaffected, it just receives the text in one piece.
   */
  private async *streamHop(
    messages: BaseMessage[],
    streamModel: ChatOpenAI | ReturnType<ChatOpenAI['bindTools']>,
    fallbackModel: ChatOpenAI | ReturnType<ChatOpenAI['bindTools']>,
  ): AsyncGenerator<string | ToolCall[]> {
    let acc: AIMessageChunk | undefined;
    try {
      const stream = await streamModel.stream(messages);
      for await (const chunk of stream) {
        acc = acc === undefined ? chunk : acc.concat(chunk);
        const text = chunkToText(chunk.content);
        if (text) yield text;
      }
    } catch (err) {
      if (acc !== undefined) throw err; // mid-stream failure: not a capability gap
      this.logger.warn(
        `Streaming failed (${err instanceof Error ? err.message : err}); retrying without stream`,
      );
      const response = await fallbackModel.invoke(messages);
      const text = chunkToText(response.content);
      if (text) yield text;
      yield collectToolCalls(response as AIMessage, this.logger);
      return;
    }
    yield collectToolCalls(acc, this.logger);
  }

  /** Drop a ws session's history (call on disconnect). */
  forget(sessionId: string): void {
    this.histories.delete(sessionId);
    this.generations.delete(sessionId);
  }

  /** Keep only the most recent messages to bound memory/context growth. */
  private trim(history: BaseMessage[]): void {
    if (history.length > MAX_HISTORY_MESSAGES) {
      history.splice(0, history.length - MAX_HISTORY_MESSAGES);
    }
    // Never let the window open on an orphaned assistant/tool message: OpenAI-
    // compatible servers reject tool results whose calling message was trimmed.
    while (history.length && !(history[0] instanceof HumanMessage)) {
      history.shift();
    }
  }
}

/** Wrap a tool result for the model. Ids are guaranteed by collectToolCalls. */
function toolResult(tc: ToolCall, content: string): ToolMessage {
  return new ToolMessage({
    content,
    tool_call_id: tc.id ?? tc.name,
    name: tc.name,
  });
}

/**
 * Tool calls requested by an (accumulated) assistant message, every one
 * carrying an id (synthesized when the server omits it — the id must round-trip
 * into the paired ToolMessage or serialization of the next request fails).
 *
 * LangChain never surfaces an id-less call in `tool_calls`: the AIMessageChunk
 * constructor files any accumulated chunk group without an id under
 * `invalid_tool_calls` (@langchain/core messages/ai.js). Servers that omit ids
 * are exactly the ones the non-streaming fallback targets, so those entries
 * are recovered here when their name is present and their args parse; only
 * truly unparseable calls are dropped with a log.
 */
function collectToolCalls(
  msg: AIMessage | AIMessageChunk | undefined,
  logger: Logger,
): ToolCall[] {
  if (!msg) return [];
  const calls: ToolCall[] = (msg.tool_calls ?? [])
    .filter((tc) => !!tc.name)
    .map((tc) => ({ ...tc, id: tc.id || `call_${randomUUID()}` }));
  for (const c of msg.invalid_tool_calls ?? []) {
    if (!c.name) continue;
    try {
      const args = c.args ? (JSON.parse(c.args) as Record<string, unknown>) : {};
      calls.push({
        name: c.name,
        args,
        id: c.id || `call_${randomUUID()}`,
        type: 'tool_call',
      });
      logger.warn(`Recovered id-less/partial tool call ${c.name}`);
    } catch {
      logger.warn(`Dropping malformed tool call ${c.name}(${c.args ?? ''})`);
    }
  }
  return calls;
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
