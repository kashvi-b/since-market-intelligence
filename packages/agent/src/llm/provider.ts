/**
 * A provider-neutral view of one turn of a tool-using conversation.
 *
 * The investigation loop owns the interesting logic — hypothesis elimination,
 * the caps, the guards, the branch attribution — and none of that is specific to
 * a vendor. This interface is the smallest surface that lets the loop stay
 * unchanged while the model behind it swaps out.
 *
 * Deliberately narrow: no streaming, no partial content, no vendor types
 * leaking. Anything a provider needs beyond this belongs inside that provider.
 */

export interface LlmToolCall {
  /** Correlates a call with its result. Synthesised when a vendor omits one. */
  id: string
  name: string
  input: Record<string, unknown>
  /**
   * Opaque, provider-owned data that must survive a round trip.
   *
   * Gemini 3 attaches a thought signature to every function call and rejects the
   * next request if it is not echoed back. The loop must carry this without
   * understanding it, so it stays untyped and no other provider looks at it.
   */
  providerMeta?: Record<string, unknown>
}

export interface LlmToolResult {
  id: string
  name: string
  /** JSON-encoded tool output. */
  content: string
  isError?: boolean
}

export type LlmMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: LlmToolCall[] }
  | { role: 'tool'; results: LlmToolResult[] }

export interface LlmToolDef {
  name: string
  description: string
  /** JSON Schema for the arguments. */
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] }
}

export interface LlmTurn {
  text: string
  toolCalls: LlmToolCall[]
  /** `refusal` is distinct from `end`: the model declined rather than finished. */
  stop: 'tool_use' | 'end' | 'refusal'
}

export interface LlmProvider {
  readonly name: string
  readonly model: string
  turn(params: { system: string; history: LlmMessage[]; tools: LlmToolDef[] }): Promise<LlmTurn>
}

/** Raised for a provider failure the loop should treat as "agent unavailable". */
export class LlmUnavailable extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}
