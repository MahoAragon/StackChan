/**
 * Valid sample payloads for the control messages the server pushes to the
 * device. Shapes are taken from the firmware JSON parsers in
 *   firmware/main/stackchan/json/json_helper.cpp
 */

/** ControlAvatar (0x03) — stackchan::avatar::update_from_json. */
export const DEMO_AVATAR = {
  leftEye: { x: -6, y: -4, rotation: 0, weight: 4, size: 32 },
  rightEye: { x: 6, y: -4, rotation: 0, weight: 4, size: 32 },
  mouth: { x: 0, y: 24, rotation: 0, weight: 4, size: 28 },
};

/** ControlMotion (0x04) — stackchan::motion::update_from_json. */
export const DEMO_MOTION = {
  yawServo: { angle: 110, speed: 60 },
  pitchServo: { angle: 80, speed: 60 },
};

/**
 * DanceSequence (0x14) — stackchan::animation::parse_sequence_from_json.
 * Must be a JSON ARRAY of keyframes; each keyframe optionally carries
 * leftEye/rightEye/mouth, yawServo/pitchServo {angle,speed},
 * leftRgbColor/rightRgbColor (hex strings), and durationMs.
 */
export const DEMO_DANCE = [
  {
    yawServo: { angle: 70, speed: 120 },
    pitchServo: { angle: 70, speed: 120 },
    leftRgbColor: '#ff0066',
    rightRgbColor: '#ff0066',
    durationMs: 400,
  },
  {
    yawServo: { angle: 110, speed: 120 },
    pitchServo: { angle: 95, speed: 120 },
    leftRgbColor: '#00ccff',
    rightRgbColor: '#00ccff',
    durationMs: 400,
  },
  {
    yawServo: { angle: 90, speed: 90 },
    pitchServo: { angle: 80, speed: 90 },
    leftRgbColor: '#ffffff',
    rightRgbColor: '#ffffff',
    durationMs: 400,
  },
];

/** TextMessage (0x07) — parsed into {name, content}. */
export const DEMO_TEXT = { name: 'private-server', content: 'hello from localhost!' };
