import Anthropic from '@anthropic-ai/sdk'
import {
  LlmUnavailable,
  type LlmProvider, type LlmMessage, type LlmToolDef, type LlmTurn, type LlmToolCall,
} from './provider.js'

/** Claude. Native tool-use, so the mapping is close to one-to-one. */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic'
  private readonly client: Anthropic

  constructor(apiKey: string, readonly model = process.env.AGENT_MODEL ?? 'claude-opus-5',
              private readonly timeoutMs = 45_000) {
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 })
  }

  async turn({ system, history, tools }: {
    system: string; history: LlmMessage[]; tools: LlmToolDef[]
  }): Promise<LlmTurn> {
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool.InputSchema,
        })),
        messages: toAnthropic(history),
      })

      if (res.stop_reason === 'refusal') return { text: '', toolCalls: [], stop: 'refusal' }

      const toolCalls: LlmToolCall[] = res.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }))
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text).join('')

      return { text, toolCalls, stop: toolCalls.length > 0 ? 'tool_use' : 'end' }
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw new LlmUnavailable(err.message, err.status)
      throw new LlmUnavailable((err as Error).message)
    }
  }
}

function toAnthropic(history: readonly LlmMessage[]): Anthropic.MessageParam[] {
  return history.map((m): Anthropic.MessageParam => {
    if (m.role === 'user') return { role: 'user', content: m.text }
    if (m.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = []
      if (m.text) content.push({ type: 'text', text: m.text })
      for (const c of m.toolCalls) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
      }
      return { role: 'assistant', content }
    }
    return {
      role: 'user',
      content: m.results.map((r): Anthropic.ToolResultBlockParam => ({
        type: 'tool_result', tool_use_id: r.id, content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    }
  })
}
