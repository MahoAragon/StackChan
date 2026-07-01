/**
 * Wrap raw 16-bit little-endian PCM samples in a minimal canonical WAV container.
 * Used to hand decoded upstream audio to the OpenAI-compatible STT endpoint, which
 * wants a real audio file rather than headerless PCM.
 */
export function pcm16ToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample; // bytes per sample frame (all channels)
  const byteRate = sampleRate * blockAlign; // bytes per second
  const dataSize = pcm.length;

  // 44-byte canonical PCM header (RIFF + fmt + data chunks) followed by the samples.
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4); // RIFF chunk size = header remainder + data
  header.write('WAVE', 8, 'ascii');

  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
