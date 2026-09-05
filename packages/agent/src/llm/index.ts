import { AnthropicProvider } from './anthropic.js'
import { GeminiProvider } from './gemini.js'
import type { LlmProvider } from './provider.js'

export * from './provider.js'
export { AnthropicProvider, GeminiProvider }

/**
 * Pick a provider from the environment.
 *
 * Gemini first when a key is present: its free tier means the investigation —
 * the differentiating feature here — does not depend on a paid account. Setting
 * AGENT_PROVIDER forces one either way, and returning null is a normal outcome
 * that puts the loop on its deterministic path.
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider | null {
  // A declared-but-empty variable is the normal state of a fresh .env, and it
  // must count as absent — otherwise an empty key reaches the SDK and comes back
  // as an authentication failure that looks like a broken integration.
  const key = (v: string | undefined): string | undefined => {
    const t = v?.trim()
    return t ? t : undefined
  }

  const forced = key(env.AGENT_PROVIDER)?.toLowerCase()
  const gemini = key(env.GEMINI_API_KEY) ?? key(env.GOOGLE_API_KEY)
  const anthropic = key(env.ANTHROPIC_API_KEY)

  if (forced === 'gemini') return gemini ? new GeminiProvider(gemini) : null
  if (forced === 'anthropic') return anthropic ? new AnthropicProvider(anthropic) : null
  if (forced === 'none') return null

  if (gemini) return new GeminiProvider(gemini)
  if (anthropic) return new AnthropicProvider(anthropic)
  return null
}
