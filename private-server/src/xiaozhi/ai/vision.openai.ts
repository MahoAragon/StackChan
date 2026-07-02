/**
 * Vision provider backed by an OpenAI-compatible /v1/chat/completions server
 * that accepts image_url content parts (multimodal llama.cpp with an --mmproj
 * projector, or any cloud-compatible endpoint). The camera JPEG travels inline
 * as a base64 data URL — no shared filesystem or object store needed.
 */

import OpenAI from 'openai';

import type { XiaozhiConfig } from '../config';
import type { VisionProvider } from './provider.interface';

export class OpenAiCompatVisionProvider implements VisionProvider {
  private readonly client: OpenAI;

  constructor(private readonly config: XiaozhiConfig) {
    this.client = new OpenAI({
      baseURL: config.vision.baseUrl,
      apiKey: config.vision.apiKey,
      // Hard-bounded WELL under the device's 30s wait for the response headers
      // (see config.vision.timeoutMs): an answer the camera has stopped
      // waiting for helps nobody and — with vision sharing the chat llama.cpp
      // by default — would block the turn's follow-up hop. No retries for the
      // same reason: a retry doubles the time budget.
      timeout: config.vision.timeoutMs,
      maxRetries: 0,
    });
  }

  /** Answer `question` about the JPEG; returns the model's text verbatim. */
  async describe(question: string, jpeg: Buffer): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.config.vision.model,
      messages: [
        { role: 'system', content: this.config.vision.systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: question },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
              },
            },
          ],
        },
      ],
    });
    return response.choices[0]?.message?.content?.trim() ?? '';
  }
}
