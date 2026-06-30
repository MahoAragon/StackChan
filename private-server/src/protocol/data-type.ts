/**
 * StackChan avatar/app WebSocket binary protocol.
 *
 * Mirrors the firmware enum in
 *   firmware/main/hal/hal_ws_avatar.cpp  (DataType, :36-57)
 *
 * Wire framing (firmware `sendPacket`, :440-479):
 *   [ 1 byte: DataType ][ 4 bytes: payload length, big-endian ][ payload bytes ]
 * Packets with no payload are sent as [type][00 00 00 00].
 */
export enum DataType {
  Opus = 0x01,
  Jpeg = 0x02,
  ControlAvatar = 0x03,
  ControlMotion = 0x04,
  StartCameraStream = 0x05,
  StopCameraStream = 0x06,
  TextMessage = 0x07,
  RequestCall = 0x09,
  DeclineCall = 0x0a,
  AcceptCall = 0x0b,
  EndCall = 0x0c,
  SetDeviceName = 0x0d,
  GetDeviceName = 0x0e,
  HeartbeatPing = 0x10,
  HeartbeatPong = 0x11,
  VideoModeOn = 0x12,
  VideoModeOff = 0x13,
  DanceSequence = 0x14,
  StartAudioStream = 0x18,
  StopAudioStream = 0x19,
}

export const DataTypeName: Record<number, string> = Object.fromEntries(
  Object.entries(DataType)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => [v as number, k]),
);

/** Encode a framed packet: [type][len BE32][payload]. */
export function encodePacket(type: DataType, payload?: Buffer | string): Buffer {
  const body =
    payload === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export interface DecodedPacket {
  type: DataType;
  /** Raw payload bytes (offset 5..). */
  payload: Buffer;
}

/**
 * Decode an inbound binary frame. Returns null when the buffer is too short to
 * carry a header (the firmware guards on `size >= 5`).
 */
export function decodePacket(data: Buffer): DecodedPacket | null {
  if (data.length < 5) {
    return null;
  }
  const type = data.readUInt8(0) as DataType;
  // The firmware ignores the declared length on the inbound path and just takes
  // everything after offset 5, so we do the same to stay tolerant.
  const payload = data.subarray(5);
  return { type, payload };
}
