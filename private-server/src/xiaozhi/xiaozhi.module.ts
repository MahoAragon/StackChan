/**
 * The xiaozhi AI-conversation backend: OTA bootstrap endpoint + realtime WS
 * gateway + camera-photo vision endpoint + server-push events API. Import
 * this into AppModule and route the `/xiaozhi/v1/` HTTP upgrade to
 * XiaozhiWsService.handleUpgrade (see main.ts).
 */
import { Module } from '@nestjs/common';
import { EventsAuthGuard, XiaozhiEventsController } from './events.controller';
import { XiaozhiOtaController } from './ota.controller';
import { XiaozhiVisionController } from './vision.controller';
import { XiaozhiWsService } from './xiaozhi-ws.service';

@Module({
  controllers: [
    XiaozhiOtaController,
    XiaozhiVisionController,
    XiaozhiEventsController,
  ],
  providers: [XiaozhiWsService, EventsAuthGuard],
  exports: [XiaozhiWsService],
})
export class XiaozhiModule {}
