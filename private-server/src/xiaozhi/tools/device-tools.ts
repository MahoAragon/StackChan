/**
 * Bridges the device's MCP tool catalog into ExecutableTools the LLM can call.
 *
 * MCP tool names are dotted ("self.camera.take_photo") but OpenAI-compatible
 * function names must match [a-zA-Z0-9_-], so each tool is exposed to the
 * model under a sanitized alias and calls are routed back to the original MCP
 * name. The device's inputSchema is already OpenAI-shaped JSON Schema
 * ({type:'object', properties, required} — mcp_server.h McpTool::to_json).
 */
import type { McpSession, McpToolDescriptor } from '../mcp/mcp-session';
import type { ExecutableTool } from './tool-registry';

/** "self.camera.take_photo" -> "self_camera_take_photo". */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Server-side adjustments applied to specific device tools. */
interface ToolTweak {
  /** Properties removed from the schema the model sees. */
  hideParams?: string[];
  /** Arguments injected on every call, overriding whatever the model sent. */
  injectArgs?: () => Record<string, unknown>;
  /** Rewrite the device's description before the model sees it. */
  fixDescription?: (description: string) => string;
  /** Mark the tool "silent": calling it ends the turn with no spoken reply. */
  silent?: boolean;
}

/**
 * Head movement is tuned server-side; the model only picks the target:
 *
 * - `speed` is owned by the server, not the model: the firmware's default
 *   (150, and its description saying "150 is natural") makes large commanded
 *   turns crawl — the servo maps speed to spring stiffness, so a 45° turn at
 *   150 drags visibly. The idle-motion routine the head should match
 *   (firmware/main/stackchan/modifiers/idle_motion.h:74-112) moves at random
 *   speeds 100–400, using 250–400 for its deliberate glances; commanded turns
 *   get that deliberate band. Hidden from the model entirely — otherwise it
 *   echoes the "150 is natural" hint from the tool description.
 * - The description is REPLACED, not patched: with the firmware's original
 *   text the model walks a turn in several small calls (move, see success,
 *   move again), pausing a full LLM round-trip between steps. The rewrite
 *   demands the final absolute angles in one call.
 */
const TOOL_TWEAKS: Record<string, ToolTweak> = {
  'self.robot.set_head_angles': {
    hideParams: ['speed'],
    injectArgs: () => ({ speed: 250 + Math.floor(Math.random() * 151) }),
    fixDescription: () =>
      'Move the head to an absolute position in ONE single motion. Always ' +
      'send the FINAL target angles in one call; never split a turn into ' +
      'multiple smaller steps and never move relative to the current ' +
      'position. Ranges: yaw -128 (your full left) to 128 (your full ' +
      'right), pitch 0 (level) to 90 (straight up), {yaw:0, pitch:0} is ' +
      'neutral. A natural glance stays within +/-45 yaw; use larger values ' +
      'only when asked to turn far or look behind.',
  },
  // Dismissal is silent: when the user tells the robot to go away, it just goes
  // quiet and returns to standby — no goodbye, no acknowledgement. The provider
  // ends the turn the moment this is called (see LangChainLlmProvider.reply),
  // and the firmware's description tells the model not to speak either.
  'self.robot.go_to_sleep': { silent: true },
};

export function buildDeviceTools(
  descriptors: McpToolDescriptor[],
  mcp: McpSession,
): ExecutableTool[] {
  const tools: ExecutableTool[] = [];
  const taken = new Set<string>();
  for (const desc of descriptors) {
    let alias = sanitizeToolName(desc.name);
    // Distinct MCP names could collapse to the same alias; disambiguate.
    for (let n = 2; taken.has(alias); n++) {
      alias = `${sanitizeToolName(desc.name)}_${n}`;
    }
    taken.add(alias);
    const tweak = TOOL_TWEAKS[desc.name];
    const schema = desc.inputSchema ?? { type: 'object', properties: {} };
    tools.push({
      name: alias,
      description: tweak?.fixDescription
        ? tweak.fixDescription(desc.description)
        : desc.description,
      parameters: tweak?.hideParams
        ? hideProperties(schema, tweak.hideParams)
        : schema,
      ...(tweak?.silent ? { silent: true } : {}),
      execute: (args) =>
        mcp.callTool(desc.name, {
          ...coerceArgs(args, desc.inputSchema),
          ...tweak?.injectArgs?.(),
        }),
    });
  }
  return tools;
}

/** Copy of `schema` without the given properties (and their required flags). */
function hideProperties(
  schema: Record<string, unknown>,
  names: string[],
): Record<string, unknown> {
  const properties = { ...(schema.properties as Record<string, unknown>) };
  for (const name of names) delete properties[name];
  const required = Array.isArray(schema.required)
    ? (schema.required as string[]).filter((r) => !names.includes(r))
    : undefined;
  return {
    ...schema,
    properties,
    ...(required !== undefined ? { required } : {}),
  };
}

/**
 * Coerce argument values to the schema's declared scalar types. The firmware
 * binds arguments strictly by JSON type (mcp_server.cc DoToolCall:529-538) and
 * treats a mismatch as "argument absent" — so a model emitting {"yaw":"-45"}
 * (string, as small local models often do) would either silently fall back to
 * the property's default (head doesn't move, tool still reports success) or
 * fail a required argument. Lossless conversions only; anything else is passed
 * through for the device to complain about.
 */
function coerceArgs(
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const properties = inputSchema?.properties as
    | Record<string, { type?: string }>
    | undefined;
  if (!properties) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(out)) {
    const declared = properties[key]?.type;
    if (declared === 'integer' || declared === 'number') {
      if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
        out[key] = Number(value);
      } else if (typeof value === 'boolean') {
        out[key] = value ? 1 : 0;
      }
    } else if (declared === 'boolean') {
      if (value === 'true' || value === 1) out[key] = true;
      else if (value === 'false' || value === 0) out[key] = false;
    } else if (declared === 'string') {
      if (typeof value === 'number' || typeof value === 'boolean') {
        out[key] = String(value);
      }
    }
  }
  return out;
}
