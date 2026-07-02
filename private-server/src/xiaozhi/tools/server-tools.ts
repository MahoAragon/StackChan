/**
 * Server-side tools: capabilities that live in this process rather than on the
 * device. To add one, append an entry here — it shows up in the model's
 * function list next to the device's MCP tools automatically.
 *
 * Keep names in snake_case ([a-zA-Z0-9_-]; OpenAI-compatible servers reject
 * anything else) and descriptions written for the model, not for humans:
 * say when to use the tool, not how it works.
 */
import type { ExecutableTool } from './tool-registry';

export function createServerTools(): ExecutableTool[] {
  return [
    {
      name: 'get_current_time',
      description:
        'Get the current date and time (with weekday and timezone). ' +
        'Use whenever the user asks about the time, date, or day.',
      parameters: { type: 'object', properties: {} },
      execute: async () => new Date().toString(),
    },
  ];
}
