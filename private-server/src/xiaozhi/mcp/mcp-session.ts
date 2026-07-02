/**
 * MCP (Model Context Protocol) client for one device connection.
 *
 * The firmware runs an MCP *server* (firmware/xiaozhi-esp32/main/mcp_server.cc)
 * whose JSON-RPC 2.0 messages are tunneled as the `payload` of `{"type":"mcp"}`
 * control frames on the conversation websocket — there is no separate
 * connection. We are the MCP *client*: we send `initialize` / `tools/list` /
 * `tools/call` requests and the device replies with `{id, result|error}`.
 *
 * Firmware contract quirks this mirrors (mcp_server.cc ParseMessage):
 *   - `id` MUST be a JSON number (strings are rejected at :380-384).
 *   - errors come back as {error:{message}} with NO code field (:446-453).
 *   - `initialize` params.capabilities.vision.{url,token} is the ONLY channel
 *     that provisions the camera's photo-upload endpoint (:334-351) — this
 *     vendored ota.cc has no `vision` block, so skipping initialize silently
 *     breaks self.camera.take_photo ("Image explain URL or token is not set").
 *   - `tools/list` paginates by tool NAME cursor with an 8000-byte payload cap
 *     (:455-509); user-only tools are already excluded server-side.
 *   - tool results arrive MCP-shaped: {content:[{type:'text',text}...],isError}.
 */
import { Logger } from '@nestjs/common';

/** One tool as described by the device's tools/list response. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema of the arguments object ({type:'object', properties, required}). */
  inputSchema: Record<string, unknown>;
  annotations?: { audience?: string[] };
}

/** Vision capability advertised to the device during initialize. */
export interface VisionCapability {
  /** HTTP endpoint the camera POSTs its multipart question+JPEG to. */
  url: string;
  /** Sent back to us as `Authorization: Bearer <token>` on that POST. */
  token: string;
}

/** How long to wait for ordinary control replies (initialize, tools/list). */
const CONTROL_TIMEOUT_MS = 15_000;
/**
 * How long to wait for a tools/call reply. take_photo is the slow path:
 * capture + JPEG encode on-device, HTTP upload, then the vision inference —
 * itself capped at config.vision.timeoutMs (default 25s) because the device
 * abandons the upload's response after 30s anyway. 45s covers that worst case
 * plus capture/network slack; a stuck call should release the turn promptly.
 */
const TOOL_CALL_TIMEOUT_MS = 45_000;

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpSession {
  private readonly logger = new Logger('McpSession');
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private disposed = false;

  /**
   * @param sendPayload transmits one JSON-RPC object to the device, wrapped in
   *        the `{"type":"mcp","payload":...}` websocket frame by the caller.
   */
  constructor(
    private readonly sendPayload: (payload: Record<string, unknown>) => void,
    private readonly sessionId: string,
  ) {}

  /**
   * Route an inbound `mcp` frame payload (a JSON-RPC response) to the request
   * that is waiting for it. Unknown ids are logged and dropped — the device
   * never initiates requests of its own.
   */
  onPayload(payload: unknown): void {
    const msg = payload as {
      id?: unknown;
      result?: unknown;
      error?: { message?: unknown };
    } | null;
    if (!msg || typeof msg.id !== 'number') {
      this.logger.warn(
        `Ignoring mcp payload without numeric id (session=${this.sessionId}): ${JSON.stringify(payload)?.slice(0, 200)}`,
      );
      return;
    }
    const req = this.pending.get(msg.id);
    if (!req) {
      this.logger.warn(
        `No pending MCP request for id=${msg.id} (session=${this.sessionId})`,
      );
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(req.timer);
    if (msg.error) {
      req.reject(
        new Error(
          typeof msg.error.message === 'string'
            ? msg.error.message
            : `MCP ${req.method} failed`,
        ),
      );
    } else {
      req.resolve(msg.result);
    }
  }

  /**
   * MCP handshake. Besides being polite protocol, this is what hands the
   * device its camera photo-upload endpoint (see file header).
   */
  async initialize(vision?: VisionCapability): Promise<void> {
    const capabilities: Record<string, unknown> = vision
      ? { vision: { url: vision.url, token: vision.token } }
      : {};
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities,
      clientInfo: { name: 'stackchan-private-server', version: '0.1.0' },
    });
  }

  /** Fetch the complete tool catalog, following nextCursor pagination. */
  async listTools(): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor = '';
    // The device paginates by name with ~8KB pages; a handful of pages covers
    // any realistic catalog. Bound the loop so a misbehaving cursor can't spin.
    for (let page = 0; page < 16; page++) {
      const result = (await this.request(
        'tools/list',
        cursor ? { cursor } : {},
      )) as { tools?: McpToolDescriptor[]; nextCursor?: string } | null;
      for (const tool of result?.tools ?? []) {
        // tools/list already excludes user-only tools; filter defensively in
        // case a future firmware marks audience without honoring the flag.
        if (tool.annotations?.audience?.includes('user')) continue;
        tools.push(tool);
      }
      if (!result?.nextCursor) return tools;
      cursor = result.nextCursor;
    }
    this.logger.warn(
      `tools/list pagination did not terminate; returning ${tools.length} tools (session=${this.sessionId})`,
    );
    return tools;
  }

  /**
   * Invoke one device tool and reduce its MCP result to plain text for the
   * LLM. An {isError:true} result or an {error:{message}} reply both surface
   * as a thrown Error.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = (await this.request(
      'tools/call',
      { name, arguments: args },
      TOOL_CALL_TIMEOUT_MS,
    )) as {
      content?: Array<{ type?: string; text?: string; image?: string }>;
      isError?: boolean;
    } | null;

    const text = (result?.content ?? [])
      .map((part) =>
        part?.type === 'text'
          ? (part.text ?? '')
          : `[unsupported ${part?.type ?? 'unknown'} content]`,
      )
      .filter(Boolean)
      .join('\n');
    if (result?.isError) {
      throw new Error(text || `Device tool ${name} reported an error`);
    }
    return text;
  }

  /** Reject everything in flight; called when the websocket closes. */
  dispose(): void {
    this.disposed = true;
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error(`MCP session closed (${req.method} id=${id})`));
    }
    this.pending.clear();
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = CONTROL_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error('MCP session closed'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`MCP ${method} timed out after ${timeoutMs}ms (id=${id})`),
        );
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.sendPayload({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}
