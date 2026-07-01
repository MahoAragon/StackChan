/**
 * Xiaozhi OTA / provisioning bootstrap.
 *
 * The firmware POSTs to this endpoint on boot to learn how to reach the
 * realtime backend. By returning ONLY a `websocket` object (and deliberately no
 * `mqtt`, `firmware`, or `activation` blocks) the device selects the WebSocket
 * transport and skips both the firmware-upgrade and cloud-activation flows,
 * keeping it fully isolated on our private-server.
 *
 * Auth is intentionally not enforced — we accept whatever headers/body the
 * device sends.
 */
import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { loadXiaozhiConfig } from './config';
import { XIAOZHI_WS_PATH } from './xiaozhi-ws.service';

@Controller()
export class XiaozhiOtaController {
  private readonly logger = new Logger('XiaozhiOTA');
  private readonly token = loadXiaozhiConfig().token;

  // The firmware's OTA parser (ota.cc:107) rejects any status != 200, so we must
  // NOT return Nest's default 201 for a POST.
  @Post('xiaozhi/ota')
  @HttpCode(200)
  bootstrap(@Req() req: Request) {
    // Point the device back at whichever host it reached us on so the same
    // config works across LAN IPs; PUBLIC_WS_HOST is an explicit override.
    const host =
      process.env.PUBLIC_WS_HOST ?? req.headers.host ?? '10.0.0.200:12800';
    const url = `ws://${host}${XIAOZHI_WS_PATH}`;
    this.logger.log(`OTA bootstrap -> ${url}`);
    return {
      websocket: {
        url,
        token: this.token,
        version: 1,
      },
    };
  }
}
