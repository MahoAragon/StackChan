/**
 * Per-session tool catalog: server-side tools (defined in server-tools.ts)
 * merged with the tools the connected device exposes over MCP (discovered
 * asynchronously — see device-tools.ts and xiaozhi-ws.service.ts).
 *
 * Implements the ToolSource interface the LLM provider consumes, so the model
 * sees one flat function list and never knows which side executes a call.
 */
import { Logger } from '@nestjs/common';
import type { ToolSource, ToolSpec } from '../ai/provider.interface';

/** A ToolSpec that knows how to run itself. */
export interface ExecutableTool extends ToolSpec {
  execute(args: Record<string, unknown>): Promise<string>;
}

export class ToolRegistry implements ToolSource {
  private readonly logger = new Logger('ToolRegistry');
  private readonly serverTools = new Map<string, ExecutableTool>();
  private deviceTools = new Map<string, ExecutableTool>();

  constructor(serverTools: ExecutableTool[] = []) {
    for (const tool of serverTools) {
      if (this.serverTools.has(tool.name)) {
        this.logger.warn(`Duplicate server tool "${tool.name}" ignored`);
        continue;
      }
      this.serverTools.set(tool.name, tool);
    }
  }

  /** Replace the device-tool set once (or whenever) MCP discovery completes. */
  setDeviceTools(tools: ExecutableTool[]): void {
    const next = new Map<string, ExecutableTool>();
    for (const tool of tools) {
      if (this.serverTools.has(tool.name) || next.has(tool.name)) {
        this.logger.warn(`Duplicate device tool "${tool.name}" ignored`);
        continue;
      }
      next.set(tool.name, tool);
    }
    this.deviceTools = next;
  }

  list(): ToolSpec[] {
    return [...this.serverTools.values(), ...this.deviceTools.values()].map(
      ({ name, description, parameters }) => ({ name, description, parameters }),
    );
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.serverTools.get(name) ?? this.deviceTools.get(name);
    if (!tool) {
      return `Error: unknown tool "${name}"`;
    }
    try {
      const result = await tool.execute(args);
      // An empty result reads as a failed call to some models; make it explicit.
      return result || 'OK (tool returned no output)';
    } catch (err) {
      // Errors become conversational material ("sorry, my camera failed"),
      // never a crashed turn.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Tool ${name} failed: ${message}`);
      return `Error: ${message}`;
    }
  }
}
