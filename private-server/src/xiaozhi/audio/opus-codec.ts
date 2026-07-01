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

  /** Carry-over PCM (< one frame) between downstream chunks. */
  private downstreamResidual = Buffer.alloc(0);

  /** Decode one upstream Opus packet -> PCM16 mono 16k for that 60 ms frame. */
  decodeUpstreamPacket(opus: Buffer): Buffer {
    return this.decoder.decode(opus);
  }

  /**
   * Encode a chunk of the *continuous* downstream 24k PCM16 stream into whole
   * 60 ms (1440-sample / 2880-byte) Opus frames. TTS delivers arbitrary chunk
   * sizes whose boundaries may split a sample or a frame, so we accumulate a
   * residual and only emit complete, sample-aligned frames — carrying the tail
   * to the next call. Encoding per-chunk with padding instead would misalign
   * samples and inject silence, producing static/garbled playback.
   *
   * Call flushDownstream() at end-of-stream to emit the final partial frame.
   */
  encodeDownstreamPcm(pcm24k: Buffer): Buffer[] {
    const buf =
      this.downstreamResidual.length > 0
        ? Buffer.concat([this.downstreamResidual, pcm24k])
        : pcm24k;

    const packets: Buffer[] = [];
    let offset = 0;
    for (; offset + FRAME_BYTES_OUT <= buf.length; offset += FRAME_BYTES_OUT) {
      packets.push(
        this.encoder.encode(
          buf.subarray(offset, offset + FRAME_BYTES_OUT),
          FRAME_SAMPLES_OUT,
        ),
      );
    }
    // Copy the tail (buf may be reused/GC'd) to prepend next time.
    this.downstreamResidual =
      offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
    return packets;
  }

  /** Emit any buffered remainder as a final zero-padded frame (end of stream). */
  flushDownstream(): Buffer[] {
    if (this.downstreamResidual.length === 0) return [];
    const frame = Buffer.alloc(FRAME_BYTES_OUT); // zero-filled = silence
    this.downstreamResidual.copy(frame);
    this.downstreamResidual = Buffer.alloc(0);
    return [this.encoder.encode(frame, FRAME_SAMPLES_OUT)];
  }

  /** Drop any buffered downstream remainder (e.g. when a turn is aborted). */
  resetDownstream(): void {
    this.downstreamResidual = Buffer.alloc(0);
  }
}
