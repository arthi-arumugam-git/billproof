/** Shapes read from Claude Code transcript lines. Only usage, ids, timestamps and attribution are kept; never content text. */

export interface CacheCreation {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation?: CacheCreation;
  service_tier?: string;
  speed?: string;
  inference_geo?: string;
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
  iterations?: Iteration[];
}

/** One billed pass of a request. With server-side fallbacks a request can carry several, each at its own model. */
export interface Iteration {
  type: string; // "message" | "fallback_message"
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: CacheCreation;
}

export interface Turn {
  /** message.id when present, else requestId, else the line uuid */
  id: string;
  requestId?: string;
  sessionId: string;
  /** epoch milliseconds */
  ts: number;
  model: string;
  usage: Usage;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  effort?: string;
  entrypoint?: string;
  sidechain: boolean;
  agentId?: string;
  skill?: string;
  mcpServer?: string;
  mcpTool?: string;
  plugin?: string;
  file: string;
  /** content block types seen across the lines that made up this message */
  content: string[];
  /** how many transcript lines carried this message (documents the over-count defect) */
  lines: number;
}

export interface CostBreakdown {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
  total: number;
}

export interface TurnCost extends CostBreakdown {
  turnId: string;
  model: string;
  /** multipliers applied on top of list rates */
  fast: number;
  geo: number;
  /** per-iteration costs when a fallback occurred */
  iterations?: Array<{ model: string; type: string; cost: CostBreakdown }>;
  flags: string[];
}
