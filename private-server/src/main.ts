import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { AppModule } from './app.module';
import { AvatarWsService, WS_PATH } from './stackchan/avatar-ws.service';

/** Matches the production GoFrame server (cmd.go:86 -> SetPort(12800)). */
const PORT = Number(process.env.PORT ?? 12800);
const HOST = process.env.HOST ?? '0.0.0.0';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // The device serializes responses itself; keep our logs readable.
    logger: ['log', 'warn', 'error'],
  });

  app.enableCors();

  // Attach the raw `ws` server to the same HTTP server, routing only the
  // firmware's /stackChan/ws path to it (everything else 404s the upgrade).
  const avatarWs = app.get(AvatarWsService);
  const server = app.getHttpServer();
  server.on(
    'upgrade',
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '').split('?')[0];
      if (path === WS_PATH) {
        avatarWs.handleUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    },
  );

  await app.listen(PORT, HOST);
  logger.log(`StackChan private-server listening on http://${HOST}:${PORT}`);
  logger.log(`  WebSocket : ws://<host>:${PORT}${WS_PATH}?deviceType=StackChan`);
  logger.log(`  Device API: GET /stackChan/device/user|info, POST /stackChan/device/unbind, GET /stackChan/apps`);
  logger.log(`  Dev push  : POST /control/{avatar,motion,dance,text,call/request,...}`);
}

bootstrap();
