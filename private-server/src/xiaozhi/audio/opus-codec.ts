import OpusScript from 'opusscript';

/*
 * Audio frame math (mono, 16-bit PCM, 60 ms frames):
 *   samples/frame = sampleRate * 0.060
 *   bytes/frame   = samples/frame * 2  (2 bytes per s16le sample)
 *
 * Upstream (device -> server): Opus @ 16000 Hz -> 960 samples/frame -> 1920 bytes/frame.
 * Downstream (server -> device): Opus @ 24000 Hz -> 1440 samples/frame -> 2880 bytes/frame.
 *
 * The device speaks raw Opus (one packet per binary frame, no header), so we just
 * decode/encode individual packets. We use opusscript (pure WASM, no native addon)
 * so there is no platform-specific .node to compile — avoids native-build breakage
 * on Apple Silicon / CI. An OpusScript instance does both encode and decode, but the
 * sample rate is fixed per instance, so we keep one per direction.
 */

const SAMPLE_RATE_IN = 16000;
const SAMPLE_RATE_OUT = 24000;
const CHANNELS = 1;
const FRAME_MS = 60;

const FRAME_SAMPLES_OUT = (SAMPLE_RATE_OUT * FRAME_MS) / 1000; // 1440
const FRAME_BYTES_OUT = FRAME_SAMPLES_OUT * 2; // 2880 (s16le mono)

export class AudioCodec {
  // Decoder fixed to the 16k upstream rate; encoder to the 24k downstream rate.
  private readonly decoder = new OpusScript(
    SAMPLE_RATE_IN,
    CHANNELS,
    OpusScript.Application.AUDIO,
  );
  private readonly encoder = new OpusScript(
    SAMPLE_RATE_OUT,
    CHANNELS,
    OpusScript.Application.AUDIO,
  );

  /** Decode one upstream Opus packet -> PCM16 mono 16k for that 60 ms frame. */
  decodeUpstreamPacket(opus: Buffer): Buffer {
    return this.decoder.decode(opus);
  }

  /**
   * Split 24k PCM16 mono audio into 1440-sample (2880-byte) frames and Opus-encode
   * each. The final short frame is zero-padded (silence) to a full frame so the
   * encoder always receives an exact frame size.
   */
  encodeDownstreamPcm(pcm24k: Buffer): Buffer[] {
    const packets: Buffer[] = [];
    for (let offset = 0; offset < pcm24k.length; offset += FRAME_BYTES_OUT) {
      let frame = pcm24k.subarray(offset, offset + FRAME_BYTES_OUT);
      if (frame.length < FRAME_BYTES_OUT) {
        const padded = Buffer.alloc(FRAME_BYTES_OUT); // zero-filled = silence
        frame.copy(padded);
        frame = padded;
      }
      packets.push(this.encoder.encode(frame, FRAME_SAMPLES_OUT));
    }
    return packets;
  }
}
