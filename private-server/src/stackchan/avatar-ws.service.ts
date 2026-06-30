import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import {
  DataType,
  DataTypeName,
  decodePacket,
  encodePacket,
} from '../protocol/data-type';

/** The single weak/hardcoded token every StackChan device sends today. */
const EXPECTED_AUTH_TOKEN = 'hi-stack-chan';
/** Path the firmware connects to (hal_ws_avatar.cpp:66). */
export const WS_PATH = '/stackChan/ws';
/** How often the server pings the device. Firmware watchdog fires at 10s. */
const HEARTBEAT_INTERVAL_MS = 4000;

interface DeviceState {
  id: number;
  socket: WebSocket;
  remote: string;
  deviceType: string;
  connectedAt: number;
  lastPongAt: number;
  /** Latest JPEG camera frame received from the device, if any. */
  lastFrame?: Buffer;
  lastFrameAt?: number;
  frameCount: number;
}

@Injectable()
export class AvatarWsService implements OnModuleDestroy {
  private readonly logger = new Logger('AvatarWS');
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly devices = new Map<number, DeviceState>();
  private heartbeatTimer?: NodeJS.Timeout;
  private nextId = 1;

  constructor() {
    this.wss.on('connection', (socket, req, deviceType: string) =>
      this.onConnection(socket, req, deviceType),
    );
    this.heartbeatTimer = setInterval(
      () => this.sendHeartbeats(),
      HEARTBEAT_INTERVAL_MS,
    );
  }

  onModuleDestroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.wss.close();
  }

  /**
   * Route an HTTP upgrade to the avatar WS. Called from main.ts for the
   * `/stackChan/ws` path. Auth is checked leniently: a mismatched token is
   * logged but still accepted so the stock firmware (which always sends the
   * hardcoded token) connects without friction in this dev server.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '', 'http://localhost');
    const deviceType = url.searchParams.get('deviceType') ?? 'unknown';
    const token = req.headers['authorization'];
    if (token !== EXPECTED_AUTH_TOKEN) {
      this.logger.warn(
        `Upgrade with unexpected Authorization header: ${token ?? '(none)'} (accepting anyway)`,
      );
    }
    this.wss.handleUpgrade(req, socket, head, (ws) =>
      this.wss.emit('connection', ws, req, deviceType),
    );
  }

  private onConnection(
    socket: WebSocket,
    req: IncomingMessage,
    deviceType: string,
  ) {
    const id = this.nextId++;
    const remote =
      (req.socket.remoteAddress ?? '?') + ':' + (req.socket.remotePort ?? '?');
    const now = Date.now();
    const state: DeviceState = {
      id,
      socket,
      remote,
      deviceType,
      connectedAt: now,
      lastPongAt: now,
      frameCount: 0,
    };
    this.devices.set(id, state);
    this.logger.log(
      `Device #${id} connected from ${remote} (deviceType=${deviceType}). Total: ${this.devices.size}`,
    );

    socket.on('message', (data, isBinary) =>
      this.onMessage(state, data, isBinary),
    );
    socket.on('close', (code) => {
      this.devices.delete(id);
      this.logger.log(
        `Device #${id} disconnected (code=${code}). Total: ${this.devices.size}`,
      );
    });
    socket.on('error', (err) =>
      this.logger.warn(`Device #${id} socket error: ${err.message}`),
    );

    // Probe the current device name so the dashboard can show it.
    this.send(state, DataType.GetDeviceName);
  }

  private onMessage(state: DeviceState, data: RawData, isBinary: boolean) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

    if (!isBinary) {
      const text = buf.toString('utf8');
      this.logger.log(`Device #${state.id} text: ${text}`);
      return; // hello / "camera stream started" / "camera stream stopped"
    }

    const packet = decodePacket(buf);
    if (!packet) {
      this.logger.warn(`Device #${state.id} sent short binary frame`);
      return;
    }
    const { type, payload } = packet;

    switch (type) {
      case DataType.HeartbeatPong:
        state.lastPongAt = Date.now();
        break;

      case DataType.Jpeg:
        state.lastFrame = Buffer.from(payload);
        state.lastFrameAt = Date.now();
        state.frameCount++;
        if (state.frameCount % 30 === 1) {
          this.logger.log(
            `Device #${state.id} camera frame #${state.frameCount} (${payload.length} bytes)`,
          );
        }
        break;

      case DataType.GetDeviceName:
        state.deviceType = payload.toString('utf8') || state.deviceType;
        this.logger.log(
          `Device #${state.id} reported device name: "${payload.toString('utf8')}"`,
        );
        break;

      case DataType.AcceptCall:
        this.logger.log(`Device #${state.id} ACCEPTED call`);
        break;
      case DataType.DeclineCall:
        this.logger.log(`Device #${state.id} DECLINED call`);
        break;
      case DataType.EndCall:
        this.logger.log(`Device #${state.id} ENDED call`);
        break;

      case DataType.Opus:
        // Upstream microphone audio; ignored by this dummy server.
        break;

      default:
        this.logger.log(
          `Device #${state.id} sent ${DataTypeName[type] ?? type} (${payload.length} bytes)`,
        );
    }
  }

  private sendHeartbeats() {
    const now = Date.now();
    for (const state of this.devices.values()) {
      this.send(state, DataType.HeartbeatPing);
      if (now - state.lastPongAt > 3 * HEARTBEAT_INTERVAL_MS) {
        this.logger.warn(
          `Device #${state.id} has not ponged in ${now - state.lastPongAt}ms`,
        );
      }
    }
  }

  private send(state: DeviceState, type: DataType, payload?: Buffer | string) {
    if (state.socket.readyState !== WebSocket.OPEN) return;
    state.socket.send(encodePacket(type, payload), { binary: true });
  }

  /* ----------------------------- Public push API ---------------------------- */

  /** Number of currently-connected devices. */
  get deviceCount(): number {
    return this.devices.size;
  }

  listDevices() {
    return [...this.devices.values()].map((d) => ({
      id: d.id,
      remote: d.remote,
      deviceType: d.deviceType,
      connectedAt: new Date(d.connectedAt).toISOString(),
      frameCount: d.frameCount,
      hasFrame: !!d.lastFrame,
    }));
  }

  getLatestFrame(id?: number): Buffer | undefined {
    if (id !== undefined) return this.devices.get(id)?.lastFrame;
    for (const d of this.devices.values()) if (d.lastFrame) return d.lastFrame;
    return undefined;
  }

  /**
   * Broadcast a framed packet to every connected device (or a single one when
   * `deviceId` is given). Returns how many devices it was sent to.
   */
  broadcast(
    type: DataType,
    payload?: Buffer | string,
    deviceId?: number,
  ): number {
    let count = 0;
    for (const state of this.devices.values()) {
      if (deviceId !== undefined && state.id !== deviceId) continue;
      this.send(state, type, payload);
      count++;
    }
    return count;
  }
}
