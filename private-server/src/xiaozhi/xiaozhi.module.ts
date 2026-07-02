/**
 * The xiaozhi AI-conversation backend: OTA bootstrap endpoint + realtime WS
 * gateway + camera-photo vision endpoint. Import this into AppModule and route
 * the `/xiaozhi/v1/` HTTP upgrade to XiaozhiWsService.handleUpgrade (see
 * main.ts).
 */
import { Module } from '@nestjs/common';
import { XiaozhiOtaController } from './ota.controller';
import { XiaozhiVisionController } from './vision.controller';
import { XiaozhiWsService } from './xiaozhi-ws.service';

@Module({
  controllers: [XiaozhiOtaController, XiaozhiVisionController],
  providers: [XiaozhiWsService],
  exports: [XiaozhiWsService],
})
export class XiaozhiModule {}
