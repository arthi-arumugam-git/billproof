import type { Turn, Usage } from "./types.js";

/** A raw transcript line, loosely typed. Only the fields we read are named. */
export interface RawLine {
  type?: string;
  uuid?: string;
  requestId?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  effort?: string;
  entrypoint?: string;
  isSidechain?: boolean;
  agentId?: string;
  isApiErrorMessage?: boolean;
  attributionSkill?: string;
  attributionMcpServer?: string;
  attributionMcpTool?: string;
  attributionPlugin?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: Partial<Usage>;
    content?: Array<{ type?: string }> | string;
  };
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Turn one transcript line into a Turn, or null when the line carries nothing billable.
 * Skips: non-assistant lines, lines without usage, synthetic error messages.
 */
export function parseLine(raw: RawLine, file: string): Turn | null {
  if (raw.type !== "assistant") return null;
  const m = raw.message;
  if (!m || !m.usage) return null;
  if (raw.isApiErrorMessage) return null;
  const model = m.model ?? "";
  if (!model || model === "<synthetic>") return null;
  const ts = raw.timestamp ? Date.parse(raw.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;

  const u = m.usage;
  const usage: Usage = {
    input_tokens: n(u.input_tokens),
    output_tokens: n(u.output_tokens),
    cache_creation_input_tokens: n(u.cache_creation_input_tokens),
    cache_read_input_tokens: n(u.cache_read_input_tokens),
  };
  if (u.cache_creation) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: n(u.cache_creation.ephemeral_5m_input_tokens),
      ephemeral_1h_input_tokens: n(u.cache_creation.ephemeral_1h_input_tokens),
    };
  }
  if (u.service_tier) usage.service_tier = u.service_tier;
  if (u.speed) usage.speed = u.speed;
  if (u.inference_geo) usage.inference_geo = u.inference_geo;
  if (u.server_tool_use) usage.server_tool_use = u.server_tool_use;
  if (Array.isArray(u.iterations) && u.iterations.length > 0) usage.iterations = u.iterations;

  const content = Array.isArray(m.content)
    ? m.content.map((c) => c?.type ?? "unknown")
    : typeof m.content === "string"
      ? ["text"]
      : [];

  return {
    id: m.id ?? raw.requestId ?? raw.uuid ?? `${file}:${ts}`,
    provider: "anthropic",
    source: "claude-code",
    requestId: raw.requestId,
    sessionId: raw.sessionId ?? "unknown",
    ts,
    model,
    usage,
    cwd: raw.cwd,
    gitBranch: raw.gitBranch,
    version: raw.version,
    effort: raw.effort,
    entrypoint: raw.entrypoint,
    sidechain: Boolean(raw.isSidechain),
    agentId: raw.agentId,
    skill: raw.attributionSkill,
    mcpServer: raw.attributionMcpServer,
    mcpTool: raw.attributionMcpTool,
    plugin: raw.attributionPlugin,
    file,
    content,
    lines: 1,
  };
}
