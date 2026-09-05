import { GoogleGenAI, Type, type FunctionDeclaration, type Schema } from '@google/genai'
import {
  LlmUnavailable,
  type LlmProvider, type LlmMessage, type LlmToolDef, type LlmTurn, type LlmToolCall,
} from './provider.js'

/**
 * Gemini, via the Google GenAI SDK.
 *
 * Chosen for the free tier — the investigation is the differentiating feature of
 * this product and it should not be gated behind a paid key.
 *
 * Three mismatches with the neutral interface, all handled here so the loop
 * never learns about them:
 *
 *   1. Gemini's function calls carry no correlation id, so results are matched
 *      positionally. Ids are synthesised on the way out and stripped on the way
 *      back in.
 *   2. Its schema dialect rejects `additionalProperties`, and a parameterless
 *      function must omit `parameters` entirely rather than send an empty object.
 *   3. Tool results are `functionResponse` parts on a *user* turn, not a
 *      dedicated role.
 */
/**
 * Free-tier daily quota is per model — measured at 20 requests/day/model on the
 * 3.x flash family. One investigation costs several requests, so a single model
 * runs dry after a handful of runs. Rotating across models multiplies the
 * allowance and, more importantly, means a demo does not die because someone
 * exercised the feature earlier the same day.
 */
export const DEFAULT_MODELS = ['gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.1-flash-lite']

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini'
  private readonly ai: GoogleGenAI
  private readonly models: string[]
  /** Advances only when a model's DAILY quota is gone; per-minute limits wait. */
  private cursor = 0

  constructor(apiKey: string, models?: string | string[]) {
    this.ai = new GoogleGenAI({ apiKey })
    const configured = models ?? process.env.AGENT_MODEL
    const list = Array.isArray(configured)
      ? configured
      : (configured ?? '').split(',').map((m) => m.trim()).filter(Boolean)
    this.models = list.length ? list : DEFAULT_MODELS
  }

  /** The model currently in use. Reported in logs and by agent:check. */
  get model(): string { return this.models[this.cursor] ?? this.models[0]! }

  async turn(params: {
    system: string; history: LlmMessage[]; tools: LlmToolDef[]
  }): Promise<LlmTurn> {
    // The free tier returns 503 under load and 429 at the rate cap, both often
    // transient. Retrying a few times is the difference between a demo that
    // works and one that dies on someone else's traffic spike.
    let lastErr: unknown
    const maxAttempts = this.models.length + 2

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.attempt(params)
      } catch (err) {
        lastErr = err
        const msg = (err as Error).message ?? ''
        const daily = /PerDay|RequestsPerDay/i.test(msg)
        const rateLimited = /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(msg)
        const overloaded = /\b503\b|UNAVAILABLE|high demand/i.test(msg)

        // A day's quota does not come back by waiting, so move to the next
        // model instead of sleeping through a limit that will not lift.
        if (daily && this.cursor < this.models.length - 1) {
          this.cursor++
          continue
        }
        if ((!rateLimited && !overloaded) || attempt === maxAttempts - 1) break

        // A per-minute window needs a real pause; overload clears faster.
        const wait = rateLimited ? 12_000 : 2_500 * (attempt + 1)
        await new Promise((r) => setTimeout(r, wait))
      }
    }
    const message = (lastErr as Error)?.message ?? 'Gemini request failed'
    const status = /\b(4\d\d|5\d\d)\b/.exec(message)?.[1]
    throw new LlmUnavailable(message, status ? Number(status) : undefined)
  }

  private async attempt({ system, history, tools }: {
    system: string; history: LlmMessage[]; tools: LlmToolDef[]
  }): Promise<LlmTurn> {
    {
      const res = await this.ai.models.generateContent({
        model: this.model,
        contents: toGemini(history),
        config: {
          systemInstruction: system,
          temperature: 0,
          tools: [{ functionDeclarations: tools.map(toDeclaration) }],
        },
      })

      // Read the parts directly rather than res.functionCalls: the convenience
      // accessor drops the thought signature, and Gemini 3 rejects the next
      // request if that signature is not echoed back with the call.
      const parts = (res.candidates?.[0]?.content?.parts ?? []) as GeminiPart[]

      const toolCalls: LlmToolCall[] = []
      let text = ''
      parts.forEach((part, i) => {
        if (part.text) text += part.text
        if (!part.functionCall) return
        toolCalls.push({
          // Positional id: Gemini does not supply one, and the loop needs to
          // pair each result with its call.
          id: `gemini_${i}_${part.functionCall.name ?? 'unknown'}`,
          name: part.functionCall.name ?? 'unknown',
          input: (part.functionCall.args ?? {}) as Record<string, unknown>,
          ...(part.thoughtSignature ? { providerMeta: { thoughtSignature: part.thoughtSignature } } : {}),
        })
      })
      // A safety block returns no candidates and no calls; treat it as a refusal
      // rather than as a finished turn with nothing to say.
      const blocked = toolCalls.length === 0 && text.trim() === '' && (res.candidates?.length ?? 0) === 0
      if (blocked) return { text: '', toolCalls: [], stop: 'refusal' }

      return { text, toolCalls, stop: toolCalls.length > 0 ? 'tool_use' : 'end' }
    }
  }
}

/** Gemini's schema dialect is OpenAPI-flavoured and rejects some JSON Schema keys. */
function toDeclaration(t: LlmToolDef): FunctionDeclaration {
  const props = t.parameters.properties ?? {}
  const hasParams = Object.keys(props).length > 0

  const decl: FunctionDeclaration = { name: t.name, description: t.description }
  // A parameterless function must omit `parameters`; an empty object is rejected.
  if (hasParams) {
    decl.parameters = {
      type: Type.OBJECT,
      properties: Object.fromEntries(
        Object.entries(props).map(([k, v]) => [k, toSchema(v)]),
      ),
      required: t.parameters.required ?? [],
    }
  }
  return decl
}

const TYPE_MAP: Record<string, Type> = {
  string: Type.STRING, number: Type.NUMBER, integer: Type.INTEGER,
  boolean: Type.BOOLEAN, array: Type.ARRAY, object: Type.OBJECT,
}

/** Translate a JSON Schema fragment, dropping keys Gemini's validator rejects. */
function toSchema(node: unknown): Schema {
  if (typeof node !== 'object' || node === null) return { type: Type.STRING }
  const src = node as Record<string, unknown>
  const out: Schema = {}

  if (typeof src.type === 'string') out.type = TYPE_MAP[src.type] ?? Type.STRING
  if (typeof src.description === 'string') out.description = src.description
  if (Array.isArray(src.enum)) out.enum = src.enum.map(String)
  if (src.items) out.items = toSchema(src.items)
  if (src.properties && typeof src.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(src.properties as Record<string, unknown>).map(([k, v]) => [k, toSchema(v)]),
    )
  }
  if (Array.isArray(src.required)) out.required = src.required.map(String)
  // `additionalProperties` and `$schema` are deliberately not carried over.
  return out
}

interface GeminiPart {
  text?: string
  functionCall?: { name?: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
  /** Gemini 3: must be replayed verbatim alongside the call it belongs to. */
  thoughtSignature?: string
}

function toGemini(history: readonly LlmMessage[]): { role: string; parts: GeminiPart[] }[] {
  const out: { role: string; parts: GeminiPart[] }[] = []
  for (const m of history) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.text }] })
    } else if (m.role === 'assistant') {
      const parts: GeminiPart[] = []
      if (m.text) parts.push({ text: m.text })
      for (const c of m.toolCalls) {
        const sig = c.providerMeta?.['thoughtSignature']
        parts.push({
          functionCall: { name: c.name, args: c.input },
          ...(typeof sig === 'string' ? { thoughtSignature: sig } : {}),
        })
      }
      // A turn with nothing in it is rejected outright.
      out.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] })
    } else {
      out.push({
        role: 'user',
        parts: m.results.map((r) => ({
          functionResponse: {
            name: r.name,
            // The response must be an object; tool output is JSON text.
            response: safeParse(r.content),
          },
        })),
      })
    }
  }
  return out
}

function safeParse(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { result: v }
  } catch {
    return { result: text }
  }
}
