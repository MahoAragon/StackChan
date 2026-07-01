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
import { loadXiaozhiConfig } from './config';
import { ConversationSession } from './conversation';
import {
  buildServerHello,
  encodeServerMessage,
  parseDeviceMessage,
} from './protocol/messages';

/** Path the firmware connects to for realtime conversation. */
export const XIAOZHI_WS_PATH = '/xiaozhi/v1/';
/** The device aborts if it doesn't get our hello in 10s; drop silent clients. */
const HELLO_TIMEOUT_MS = 10_000;

@Injectable()
export class XiaozhiWsService implements OnModuleDestroy {
  private readonly logger = new Logger('XiaozhiWS');
  private readonly wss = new WebSocketServer({ noServer: true });
  /** LLM/STT/TTS providers are stateless-per-turn, so build them once. */
  private readonly providers: Providers = createProviders(loadXiaozhiConfig());

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
    const remote =
      (req.socket.remoteAddress ?? '?') + ':' + (req.socket.remotePort ?? '?');
    const codec = new AudioCodec();
    const session = new ConversationSession(
      socket,
      codec,
      this.providers,
      sessionId,
    );

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
          helloReceived = true;
          clearTimeout(helloTimer);
          socket.send(encodeServerMessage(buildServerHello(sessionId)));
          this.logger.log(`Handshake complete (session=${sessionId})`);
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
          // MCP passthrough is not implemented yet; ignore rather than error.
          this.logger.log(`mcp frame ignored (session=${sessionId})`);
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
      session.dispose();
      this.logger.log(`Device disconnected (session=${sessionId}, code=${code})`);
    });

    socket.on('error', (err) => {
      this.logger.warn(`Socket error (session=${sessionId}): ${err.message}`);
    });
  }
}

/** Normalize the `ws` RawData union into a single Buffer. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
