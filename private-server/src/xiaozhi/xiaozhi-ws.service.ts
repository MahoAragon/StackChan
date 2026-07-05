/**
 * Xiaozhi realtime conversation gateway.
 *
 * Hosts a raw `ws` server (noServer) on the same HTTP listener as the rest of
 * private-server and drives the firmware's websocket protocol
 * (firmware/xiaozhi-esp32/main/protocols/websocket_protocol.cc):
 *
 *   1. device connects and sends a `hello` TEXT frame
 *   2. we reply with the server `hello` (transport MUST be "websocket")
 *   3. control frames (listen/abort/mcp) + BINARY opus frames flow both ways,
 *      each driven into a per-connection ConversationSession.
 *
 * When the client hello advertises features.mcp, we also run the MCP handshake
 * over the same socket: `initialize` hands the device the camera photo-upload
 * (vision) URL + token, then `tools/list` discovers the device's tools
 * (self.camera.take_photo, self.robot.* …), which join the per-session
 * ToolRegistry the LLM can call during turns.
 *
 * Style mirrors stackchan/avatar-ws.service.ts (raw-ws upgrade, per-socket
 * state, lenient logging).
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { createProviders } from './ai/providers.factory';
import type { Providers } from './ai/provider.interface';
import { AudioCodec } from './audio/opus-codec';
import { loadXiaozhiConfig, resolvePublicHost } from './config';
import {
  ConversationSession,
  type ServerEventPost,
} from './conversation';
import { McpSession } from './mcp/mcp-session';
import {
  buildMcp,
  buildPing,
  buildServerHello,
  encodeServerMessage,
  parseDeviceMessage,
} from './protocol/messages';
import { buildDeviceTools } from './tools/device-tools';
import { createServerTools } from './tools/server-tools';
import { ToolRegistry } from './tools/tool-registry';
import { VISION_EXPLAIN_PATH } from './vision.controller';

/** Path the firmware connects to for realtime conversation. */
export const XIAOZHI_WS_PATH = '/xiaozhi/v1/';
/** The device aborts if it doesn't get our hello in 10s; drop silent clients. */
const HELLO_TIMEOUT_MS = 10_000;

/** One connected device, addressable by server-push events. */
interface DeviceEntry {
  /** Device-Id upgrade header (the device MAC), or an address fallback. */
  deviceId: string;
  sessionId: string;
  socket: WebSocket;
  session: ConversationSession;
  remote: string;
  connectedAt: number;
}

/** Outcome of addressing one push at one (possibly absent) device. */
export type DevicePushResult =
  | { result: ServerEventPost | 'sent'; deviceId: string }
  | { result: 'no-device' };

@Injectable()
export class XiaozhiWsService implements OnModuleDestroy {
  private readonly logger = new Logger('XiaozhiWS');
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly config = loadXiaozhiConfig();
  /** LLM/STT/TTS providers are stateless-per-turn, so build them once. */
  private readonly providers: Providers = createProviders(this.config);
  /** Connected devices keyed by Device-Id, for server-push events. */
  private readonly devices = new Map<string, DeviceEntry>();

  constructor() {
    this.wss.on('connection', (socket, req) => this.onConnection(socket, req));
  }

  onModuleDestroy() {
    this.wss.close();
  }

  /**
   * Route an HTTP upgrade to this WS server. Called from main.ts for the
   * `/xiaozhi/v1/` path. No auth is enforced (the OTA token is advisory); the
   * firmware connects with whatever token the OTA bootstrap handed it.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) =>
      this.wss.emit('connection', ws, req),
    );
  }

  private onConnection(socket: WebSocket, req: IncomingMessage) {
    const sessionId = randomUUID();
    // Kill Nagle: downstream audio is a stream of small (~150-400B) frames,
    // and coalescing them against the ESP32's delayed ACKs (~250ms in lwIP)
    // turns the start-of-reply burst into a stall the device hears as a
    // stutter after the first words.
    req.socket.setNoDelay(true);
    const remote =
      (req.socket.remoteAddress ?? '?') + ':' + (req.socket.remotePort ?? '?');
    // The firmware sends its MAC as Device-Id on the upgrade request
    // (websocket_protocol.cc SetHeader) — the stable key push events address.
    const deviceId = headerValue(req.headers['device-id']) ?? `addr:${remote}`;
    const codec = new AudioCodec();
    const tools = new ToolRegistry(createServerTools(this.config.weather));
    const mcp = new McpSession((payload) => {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error('socket is not open');
      }
      socket.send(encodeServerMessage(buildMcp(payload, sessionId)));
    }, sessionId);
    const session = new ConversationSession(
      socket,
      codec,
      this.providers,
      sessionId,
      tools,
    );

    let keepaliveTimer: NodeJS.Timeout | undefined;
    let helloReceived = false;
    const helloTimer = setTimeout(() => {
      if (!helloReceived) {
        this.logger.warn(
          `No client hello within ${HELLO_TIMEOUT_MS}ms from ${remote}; closing`,
        );
        socket.close();
      }
    }, HELLO_TIMEOUT_MS);

    this.logger.log(`Device connected from ${remote} (session=${sessionId})`);

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        session.onOpusPacket(toBuffer(data));
        return;
      }
      const text = toBuffer(data).toString('utf8');
      const msg = parseDeviceMessage(text);
      if (!msg) {
        this.logger.warn(`Unparseable text frame from ${remote}: ${text}`);
        return;
      }

      switch (msg.type) {
        case 'hello':
          clearTimeout(helloTimer);
          socket.send(encodeServerMessage(buildServerHello(sessionId)));
          this.logger.log(`Handshake complete (session=${sessionId})`);
          if (!helloReceived) {
            helloReceived = true;
            // Only a client that completed the hello handshake becomes a
            // push target: registering at connect time would let any stray
            // socket (port scan, health check) receive events addressed to
            // the robot — or, with a copied Device-Id, evict its live
            // connection. Newest hello wins: the firmware silently discards
            // its old WebSocket when it reconnects (no close frame), so a
            // duplicate Device-Id means the old entry is the stale half.
            const prev = this.devices.get(deviceId);
            if (prev && prev.socket !== socket) {
              this.logger.warn(
                `Device ${deviceId} reconnected; dropping stale socket (session=${prev.sessionId})`,
              );
              prev.socket.terminate();
            }
            this.devices.set(deviceId, {
              deviceId,
              sessionId,
              socket,
              session,
              remote,
              connectedAt: Date.now(),
            });
            // Keepalive: a data frame (WS control pings don't count) every
            // interval keeps the firmware's 120s channel timer fresh so an
            // idle device stays reachable and awake for pushed events.
            const keepaliveMs = this.config.events.keepaliveMs;
            if (keepaliveMs > 0) {
              keepaliveTimer = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(encodeServerMessage(buildPing(sessionId)));
                }
              }, keepaliveMs);
            }
            if (msg.features?.mcp) {
              void this.discoverDeviceTools(mcp, tools, req, sessionId);
            }
          }
          break;

        case 'listen':
          if (msg.state === 'start' || msg.state === 'detect') {
            this.logger.log(
              `listen ${msg.state}${msg.mode ? ` mode=${msg.mode}` : ''} (session=${sessionId})`,
            );
            session.onListenStart(msg.mode);
          } else if (msg.state === 'stop') {
            this.logger.log(`listen stop (session=${sessionId})`);
            session.onListenStop();
          }
          break;

        case 'abort':
          this.logger.log(`abort (session=${sessionId})`);
          session.abort();
          break;

        case 'mcp':
          mcp.onPayload(msg.payload);
          break;

        default:
          this.logger.warn(
            `Unhandled frame type "${(msg as { type: string }).type}" (session=${sessionId})`,
          );
          break;
      }
    });

    socket.on('close', (code) => {
      clearTimeout(helloTimer);
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      // Only drop the registry entry if it is still ours: a reconnect has
      // already replaced it with the live socket by the time ours closes.
      if (this.devices.get(deviceId)?.socket === socket) {
        this.devices.delete(deviceId);
      }
      session.dispose();
      mcp.dispose();
      // Session ids are per-connection UUIDs, so this history can never be
      // revisited — free it (and stop any still-unwinding reply loop).
      this.providers.llm.forget?.(sessionId);
      this.logger.log(`Device disconnected (session=${sessionId}, code=${code})`);
    });

    socket.on('error', (err) => {
      this.logger.warn(`Socket error (session=${sessionId}): ${err.message}`);
    });
  }

  /**
   * MCP handshake, kicked off right after the hello exchange (fire-and-forget:
   * voice turns work without tools while this is in flight, and a failure only
   * costs tool support, never the conversation).
   *
   * `initialize` is load-bearing beyond the handshake: its capabilities.vision
   * URL+token is the ONLY channel that tells the camera where to upload photos
   * (mcp_server.cc ParseCapabilities) — this firmware's OTA response has no
   * vision block.
   */
  private async discoverDeviceTools(
    mcp: McpSession,
    tools: ToolRegistry,
    req: IncomingMessage,
    sessionId: string,
  ): Promise<void> {
    try {
      // Pass the socket too: the firmware's ws client sends a PORTLESS Host
      // header, and a vision URL without the port sends the camera to port 80.
      const host = resolvePublicHost(req.headers.host, req.socket);
      const visionUrl = `http://${host}${VISION_EXPLAIN_PATH}`;
      await mcp.initialize({ url: visionUrl, token: this.config.token });
      this.logger.log(
        `MCP initialized; vision endpoint ${visionUrl} (session=${sessionId})`,
      );
      const descriptors = await mcp.listTools();
      tools.setDeviceTools(buildDeviceTools(descriptors, mcp));
      this.logger.log(
        `Device tools: ${descriptors.map((d) => d.name).join(', ') || '(none)'} (session=${sessionId})`,
      );
    } catch (err) {
      this.logger.warn(
        `MCP discovery failed (session=${sessionId}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /* --------------------------- Server-push API ---------------------------
   * Called by XiaozhiEventsController on behalf of external producers
   * (desktop notifiers, email hooks, Claude Code hooks, ...). All of these
   * resolve a target device and hand the event to its ConversationSession,
   * which owns turn-taking (busy queueing, user preemption, tts bracketing).
   */

  /** Connected devices with their live conversation state. */
  listDevices() {
    return [...this.devices.values()].map((d) => ({
      deviceId: d.deviceId,
      sessionId: d.sessionId,
      remote: d.remote,
      connectedAt: new Date(d.connectedAt).toISOString(),
      speaking: d.session.isSpeaking,
      userTalking: d.session.isUserTalking,
      queuedEvents: d.session.queuedEventCount,
    }));
  }

  /** Speak `text` on the device (TTS), with an optional facial emotion. */
  say(
    text: string,
    opts: { emotion?: string; deviceId?: string } = {},
  ): DevicePushResult {
    const device = this.resolveDevice(opts.deviceId);
    if (!device) return { result: 'no-device' };
    const result = device.session.postEvent({
      kind: 'say',
      text,
      emotion: opts.emotion,
    });
    return { result, deviceId: device.deviceId };
  }

  /** Play a decoded sound (PCM16 mono 24k) on the device. */
  playSound(
    pcm: Buffer,
    label: string,
    opts: { deviceId?: string } = {},
  ): DevicePushResult {
    const device = this.resolveDevice(opts.deviceId);
    if (!device) return { result: 'no-device' };
    const result = device.session.postEvent({ kind: 'sound', pcm, label });
    return { result, deviceId: device.deviceId };
  }

  /** Change the device's facial expression immediately (no queueing). */
  setEmotion(
    emotion: string,
    opts: { deviceId?: string } = {},
  ): DevicePushResult {
    const device = this.resolveDevice(opts.deviceId);
    if (!device) return { result: 'no-device' };
    device.session.sendEmotion(emotion);
    return { result: 'sent', deviceId: device.deviceId };
  }

  /**
   * Exact Device-Id match when given; otherwise the newest connection — the
   * common deployment is a single robot, and on firmware reconnect races the
   * newest socket is the one the device is actually reading.
   */
  private resolveDevice(deviceId?: string): DeviceEntry | undefined {
    if (deviceId) return this.devices.get(deviceId);
    let newest: DeviceEntry | undefined;
    for (const entry of this.devices.values()) {
      if (!newest || entry.connectedAt > newest.connectedAt) newest = entry;
    }
    return newest;
  }
}

/** First value of a possibly-repeated HTTP header, trimmed and non-empty. */
function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

/** Normalize the `ws` RawData union into a single Buffer. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
