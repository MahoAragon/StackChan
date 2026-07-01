// Load .env into process.env before anything reads config (ports, API keys, models).
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { AppModule } from './app.module';
import { AvatarWsService, WS_PATH } from './stackchan/avatar-ws.service';
import {
  XiaozhiWsService,
  XIAOZHI_WS_PATH,
} from './xiaozhi/xiaozhi-ws.service';

/** Matches the production GoFrame server (cmd.go:86 -> SetPort(12800)). */
const PORT = Number(process.env.PORT ?? 12800);
const HOST = process.env.HOST ?? '0.0.0.0';

// A single conversation turn (a provider/network stream erroring after the fact)
// must never take down the whole server. Log and keep serving other devices.
process.on('unhandledRejection', (reason) => {
  new Logger('Process').error(
    `Unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`,
  );
});
process.on('uncaughtException', (err) => {
  new Logger('Process').error(`Uncaught exception: ${err.stack ?? String(err)}`);
});

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // The device serializes responses itself; keep our logs readable.
    logger: ['log', 'warn', 'error'],
  });

  app.enableCors();

  // Attach the raw `ws` servers to the same HTTP server, routing each firmware
  // WebSocket path to its owner. Unknown paths get their upgrade dropped.
  //   /stackChan/ws  -> avatar/app backend (camera, motion, dance, ...)
  //   /xiaozhi/v1/   -> xiaozhi AI realtime conversation backend
  const avatarWs = app.get(AvatarWsService);
  const xiaozhiWs = app.get(XiaozhiWsService);
  const server = app.getHttpServer();
  server.on(
    'upgrade',
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '').split('?')[0];
      if (path === WS_PATH) {
        avatarWs.handleUpgrade(req, socket, head);
      } else if (path === XIAOZHI_WS_PATH) {
        xiaozhiWs.handleUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    },
  );

  await app.listen(PORT, HOST);
  logger.log(`StackChan private-server listening on http://${HOST}:${PORT}`);
  logger.log(`  Avatar WS : ws://<host>:${PORT}${WS_PATH}?deviceType=StackChan`);
  logger.log(`  Device API: GET /stackChan/device/user|info, POST /stackChan/device/unbind, GET /stackChan/apps`);
  logger.log(`  Dev push  : POST /control/{avatar,motion,dance,text,call/request,...}`);
  logger.log(`  Xiaozhi   : POST /xiaozhi/ota (bootstrap), WS ws://<host>:${PORT}${XIAOZHI_WS_PATH} (AI conversation)`);
}

bootstrap();
