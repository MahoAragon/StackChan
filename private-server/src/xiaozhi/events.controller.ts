/**
 * Server-push device events API — the integration surface for external
 * producers (desktop notifiers, email hooks, Claude Code hooks, ...) to make
 * an idle StackChan speak, emote, or play a sound over its already-open
 * conversation WebSocket. No firmware changes are involved: speech/sounds
 * ride the normal tts bracket (an unsolicited `tts start` legally moves the
 * device Idle->Speaking, application.cc / device_state_machine.cc), and
 * expression rides an `llm` frame, which the firmware applies in any state.
 *
 *   GET  /xiaozhi/events/devices          connected devices + live state
 *   GET  /xiaozhi/events/sounds           named sounds available to play
 *   POST /xiaozhi/events/say              {text, emotion?, deviceId?}
 *   POST /xiaozhi/events/emotion          {emotion, deviceId?}
 *   POST /xiaozhi/events/sound            {name, deviceId?} or multipart
 *                                         file=<wav> (+ deviceId field)
 *
 * All routes require `Authorization: Bearer $XIAOZHI_EVENTS_TOKEN`. Unlike
 * the advisory device-facing tokens elsewhere in this server, this one is
 * ENFORCED (401/503): anything that can reach this port could otherwise make
 * a robot in someone's home say arbitrary text.
 *
 * Delivery semantics live in ConversationSession.postEvent: quiet device →
 * plays immediately; busy (speaking, or the user is mid-utterance) → bounded
 * FIFO, delivered when the turn ends; user speech always preempts an event
 * mid-delivery. Responses reflect the ACCEPTANCE of the event ('playing' /
 * 'queued'), not its completion — producers fire and forget.
 */
import {
  BadRequestException,
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { promises as fs } from 'fs';
import * as path from 'path';
import { SAMPLE_RATE_OUT } from './protocol/messages';
import { wavToPcm16Mono } from './audio/wav';
import { loadXiaozhiConfig } from './config';
import { XiaozhiWsService, type DevicePushResult } from './xiaozhi-ws.service';

/**
 * Enforces the events bearer token. A GUARD rather than a handler-level
 * check so it runs before the multipart FileInterceptor — otherwise multer
 * would buffer up to MAX_SOUND_BYTES in memory for unauthenticated callers.
 * 503 (not 401) when unconfigured, so a producer with the right token can
 * tell "server not set up" apart from "my token is wrong".
 */
@Injectable()
export class EventsAuthGuard implements CanActivate {
  private readonly token = loadXiaozhiConfig().events.token;

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: { authorization?: string } }>();
    if (!this.token) {
      throw new ServiceUnavailableException(
        'events API disabled: set XIAOZHI_EVENTS_TOKEN on the server',
      );
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

/**
 * Emotions the StackChan display maps (stackchan_display.cc SetEmotion);
 * anything else falls back to neutral on the device, so reject it here where
 * the producer can see the error. Note 'sleepy' has side effects: it slumps
 * the head, stops idle motion, and marks the face asleep.
 */
const KNOWN_EMOTIONS = [
  'neutral',
  'happy',
  'laughing',
  'angry',
  'sad',
  'crying',
  'sleepy',
  'doubtful',
] as const;

/** Keep one push from monologuing for minutes (~1-2 min of speech). */
const MAX_SAY_CHARS = 1000;
/** Uploaded notification sounds are seconds long; 10 MB is already generous. */
const MAX_SOUND_BYTES = 10 * 1024 * 1024;
/** Library sound names: no separators, no traversal, optional .wav suffix. */
const SOUND_NAME_RE = /^[A-Za-z0-9_-]+(\.wav)?$/;

/** The slice of Express.Multer.File we use (no @types/multer dependency). */
interface UploadedWav {
  buffer: Buffer;
  size: number;
  originalname?: string;
}

@Controller('xiaozhi/events')
@UseGuards(EventsAuthGuard)
export class XiaozhiEventsController {
  private readonly logger = new Logger('XiaozhiEvents');
  private readonly config = loadXiaozhiConfig();

  constructor(private readonly ws: XiaozhiWsService) {}

  @Get('devices')
  devices() {
    return { devices: this.ws.listDevices() };
  }

  @Get('sounds')
  async sounds() {
    let names: string[] = [];
    try {
      const entries = await fs.readdir(this.soundsDir());
      names = entries
        .filter((f) => f.toLowerCase().endsWith('.wav'))
        .map((f) => f.replace(/\.wav$/i, ''))
        .sort();
    } catch {
      // Missing directory = empty library; the response shows where to put files.
    }
    return { sounds: names, soundsDir: this.soundsDir() };
  }

  @Post('say')
  @HttpCode(200)
  say(@Body() body: { text?: unknown; emotion?: unknown; deviceId?: unknown }) {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new BadRequestException('text (non-empty string) is required');
    if (text.length > MAX_SAY_CHARS) {
      throw new BadRequestException(`text too long (max ${MAX_SAY_CHARS} chars)`);
    }
    const emotion = this.optionalEmotion(body.emotion);
    const deviceId = optionalString(body.deviceId, 'deviceId');
    this.logger.log(`say (${text.length} chars${emotion ? `, ${emotion}` : ''})`);
    return this.toResponse(this.ws.say(text, { emotion, deviceId }));
  }

  @Post('emotion')
  @HttpCode(200)
  emotion(@Body() body: { emotion?: unknown; deviceId?: unknown }) {
    const emotion = this.optionalEmotion(body.emotion);
    if (!emotion) throw new BadRequestException('emotion is required');
    const deviceId = optionalString(body.deviceId, 'deviceId');
    this.logger.log(`emotion ${emotion}`);
    return this.toResponse(this.ws.setEmotion(emotion, { deviceId }));
  }

  /**
   * Play a sound: JSON {name} for a WAV from the sounds directory, or a
   * multipart upload (field `file`) for a one-off WAV. Multer only engages on
   * multipart requests, so both content types share this route. The WAV is
   * decoded/resampled here to the device's downstream format; the device's
   * talking animation runs while it plays (firmware ties audio to Speaking).
   */
  @Post('sound')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_SOUND_BYTES } }),
  )
  async sound(
    @Body() body: { name?: unknown; deviceId?: unknown },
    @UploadedFile() file: UploadedWav | undefined,
  ) {
    const deviceId = optionalString(body.deviceId, 'deviceId');

    let wav: Buffer;
    let label: string;
    if (file?.buffer?.length) {
      wav = file.buffer;
      label = file.originalname ?? 'upload';
    } else {
      const name = optionalString(body.name, 'name');
      if (!name) {
        throw new BadRequestException(
          'provide a sound: JSON {"name": "<library sound>"} or a multipart WAV upload (field "file")',
        );
      }
      if (!SOUND_NAME_RE.test(name)) {
        throw new BadRequestException('invalid sound name');
      }
      label = name.replace(/\.wav$/i, '');
      const soundPath = path.join(this.soundsDir(), `${label}.wav`);
      try {
        wav = await fs.readFile(soundPath);
      } catch {
        throw new NotFoundException(
          `unknown sound "${label}" (looked for ${soundPath}; GET /xiaozhi/events/sounds lists the library)`,
        );
      }
    }

    let pcm: Buffer;
    try {
      pcm = wavToPcm16Mono(wav, SAMPLE_RATE_OUT);
    } catch (err) {
      throw new BadRequestException(
        `could not decode WAV: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (pcm.length === 0) throw new BadRequestException('WAV contains no audio');

    const durationSecs = pcm.length / 2 / SAMPLE_RATE_OUT;
    this.logger.log(`sound "${label}" (${durationSecs.toFixed(1)}s)`);
    return {
      ...this.toResponse(this.ws.playSound(pcm, label, { deviceId })),
      durationSecs: Number(durationSecs.toFixed(2)),
    };
  }

  /* ------------------------------ Helpers ------------------------------- */

  private optionalEmotion(value: unknown): string | undefined {
    const emotion = optionalString(value, 'emotion');
    if (emotion && !(KNOWN_EMOTIONS as readonly string[]).includes(emotion)) {
      throw new BadRequestException(
        `unknown emotion "${emotion}" (known: ${KNOWN_EMOTIONS.join(', ')})`,
      );
    }
    return emotion;
  }

  private soundsDir(): string {
    return path.resolve(process.cwd(), this.config.events.soundsDir);
  }

  private toResponse(pushed: DevicePushResult) {
    switch (pushed.result) {
      case 'no-device':
        throw new NotFoundException('no device connected');
      case 'queue-full':
        throw new HttpException(
          'device event queue is full',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      default:
        return { status: pushed.result, deviceId: pushed.deviceId };
    }
  }
}

/** A trimmed non-empty string, undefined when absent, 400 on wrong type. */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
