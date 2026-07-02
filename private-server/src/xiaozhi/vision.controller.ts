/**
 * Camera photo "explain" endpoint.
 *
 * When the LLM calls the device's self.camera.take_photo MCP tool, the
 * firmware captures a frame, shows it on the LCD, and POSTs it here as
 * chunked multipart/form-data (StackChanCamera::Explain,
 * firmware/main/hal/board/stackchan_camera.cc:1027):
 *   - field `question`: what the LLM wants to know about the photo
 *   - field `file`: camera.jpg (image/jpeg)
 *   - headers: Device-Id, Client-Id, Authorization: Bearer <token>
 * The URL + token were handed to the device in our MCP initialize
 * (capabilities.vision — see xiaozhi-ws.service.ts).
 *
 * The response body is returned VERBATIM to the LLM as the tool result, so
 * failures are reported in-body with success:false (still HTTP 200 — the
 * firmware throws away the body on any other status) and become something the
 * model can apologize about, not a broken turn.
 */
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OpenAiCompatVisionProvider } from './ai/vision.openai';
import { loadXiaozhiConfig } from './config';

/** Path segment only — the device gets the absolute URL via MCP initialize. */
export const VISION_EXPLAIN_PATH = '/xiaozhi/vision/explain';

/** QVGA/VGA JPEGs are tens of KB; leave generous headroom for larger sensors. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** The slice of Express.Multer.File we use (no @types/multer dependency). */
interface UploadedJpeg {
  buffer: Buffer;
  size: number;
  mimetype?: string;
}

@Controller()
export class XiaozhiVisionController {
  private readonly logger = new Logger('XiaozhiVision');
  private readonly config = loadXiaozhiConfig();
  private readonly vision = new OpenAiCompatVisionProvider(this.config);

  @Post(VISION_EXPLAIN_PATH)
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES } }),
  )
  async explain(
    @UploadedFile() file: UploadedJpeg | undefined,
    @Body() body: { question?: string },
    @Headers('authorization') authorization?: string,
    @Headers('device-id') deviceId?: string,
  ) {
    // Same advisory-auth stance as the OTA/WS endpoints: this is a LAN-only
    // server, so a wrong token is logged, not rejected.
    const expected = `Bearer ${this.config.token}`;
    if (authorization !== expected) {
      this.logger.warn(
        `Vision request with unexpected Authorization (device=${deviceId ?? '?'})`,
      );
    }

    if (!file?.buffer?.length) {
      this.logger.warn('Vision request without a photo');
      return { success: false, message: 'No photo received' };
    }
    const question = body.question?.trim() || 'Describe what you see.';
    this.logger.log(
      `Explain photo (${file.size} bytes, device=${deviceId ?? '?'}): "${question}"`,
    );

    try {
      const result = await this.vision.describe(question, file.buffer);
      if (!result) {
        return { success: false, message: 'Vision model returned no text' };
      }
      this.logger.log(`Vision result: ${result}`);
      return { success: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Vision model failed: ${message}`);
      return { success: false, message: `Vision model failed: ${message}` };
    }
  }
}
