import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { DataType } from '../protocol/data-type';
import { ok } from './api-response';
import { AvatarWsService } from './avatar-ws.service';
import {
  DEMO_AVATAR,
  DEMO_DANCE,
  DEMO_MOTION,
  DEMO_TEXT,
} from './demo-payloads';

/**
 * Developer-facing control surface (NOT part of the firmware protocol).
 *
 * These HTTP endpoints let you push messages to connected devices over the
 * WebSocket from curl/Postman/a browser, so you can exercise the avatar,
 * motion, dance, text-chat and call-signaling paths against a real device.
 *
 * Everything lives under /control to keep it clearly separate from the
 * firmware's /stackChan/* endpoints.
 */
@Controller('control')
export class ControlController {
  constructor(private readonly ws: AvatarWsService) {}

  /** Connected-device summary. */
  @Get('devices')
  devices() {
    return ok({ count: this.ws.deviceCount, devices: this.ws.listDevices() });
  }

  /** Push avatar expression. Body is a full avatar JSON, or empty for the demo. */
  @Post('avatar')
  avatar(@Body() body: unknown) {
    const json = hasKeys(body) ? body : DEMO_AVATAR;
    const sent = this.ws.broadcast(DataType.ControlAvatar, JSON.stringify(json));
    return ok({ sent, payload: json });
  }

  /** Push servo motion. Body is a full motion JSON, or empty for the demo. */
  @Post('motion')
  motion(@Body() body: unknown) {
    const json = hasKeys(body) ? body : DEMO_MOTION;
    const sent = this.ws.broadcast(DataType.ControlMotion, JSON.stringify(json));
    return ok({ sent, payload: json });
  }

  /** Push a dance sequence (JSON array). Empty body => built-in demo dance. */
  @Post('dance')
  dance(@Body() body: unknown) {
    const json = Array.isArray(body) && body.length ? body : DEMO_DANCE;
    const sent = this.ws.broadcast(DataType.DanceSequence, JSON.stringify(json));
    return ok({ sent, frames: json.length });
  }

  /** Push a chat bubble. Body {name, content} or empty for the demo. */
  @Post('text')
  text(@Body() body: { name?: string; content?: string }) {
    const json = body?.content ? body : DEMO_TEXT;
    const sent = this.ws.broadcast(DataType.TextMessage, JSON.stringify(json));
    return ok({ sent, payload: json });
  }

  /** Set the device display name (persisted to device NVS). */
  @Post('device-name')
  setName(@Body() body: { name?: string }) {
    const name = body?.name ?? 'StackChan';
    const sent = this.ws.broadcast(DataType.SetDeviceName, name);
    return ok({ sent, name });
  }

  /* ------------------------------ Call signaling ----------------------------- */

  /** Ring the device. Body {caller} sets the displayed caller name. */
  @Post('call/request')
  callRequest(@Body() body: { caller?: string }) {
    const caller = body?.caller ?? 'Maho';
    const sent = this.ws.broadcast(DataType.RequestCall, caller);
    return ok({ sent, caller });
  }

  /** Remotely end the current call. */
  @Post('call/end')
  callEnd() {
    const sent = this.ws.broadcast(DataType.EndCall);
    return ok({ sent });
  }

  /* ------------------------------ Camera / video ----------------------------- */

  @Post('camera/start')
  cameraStart() {
    return ok({ sent: this.ws.broadcast(DataType.StartCameraStream) });
  }

  @Post('camera/stop')
  cameraStop() {
    return ok({ sent: this.ws.broadcast(DataType.StopCameraStream) });
  }

  @Post('video-mode/:on')
  videoMode(@Param('on') on: string) {
    const type =
      on === 'on' || on === '1' || on === 'true'
        ? DataType.VideoModeOn
        : DataType.VideoModeOff;
    return ok({ sent: this.ws.broadcast(type) });
  }

  /** Latest JPEG camera frame received from a device (start the camera first). */
  @Get('camera/frame.jpg')
  frame(@Res() res: Response) {
    const frame = this.ws.getLatestFrame();
    if (!frame) {
      res.status(404).send('No camera frame received yet. POST /control/camera/start first.');
      return;
    }
    res.set('Content-Type', 'image/jpeg').send(frame);
  }
}

function hasKeys(body: unknown): body is Record<string, unknown> {
  return !!body && typeof body === 'object' && Object.keys(body).length > 0;
}
