/**
 * Verify the investigation agent against the live model.
 *
 * The Gemini adapter has never been exercised against the real API — schema
 * dialects and tool-call shapes are exactly the sort of thing that works in
 * theory and fails on first contact. This makes one real round trip and reports
 * precisely what broke, so the discovery happens now rather than in a demo.
 *
 *   npm run agent:check
 */
import { resolveProvider, type LlmToolDef } from '@since/agent'

const provider = resolveProvider()
if (!provider) {
  console.log('  No provider configured. Add GEMINI_API_KEY to .env')
  console.log('  Get a free key: https://aistudio.google.com/apikey')
  process.exit(1)
}

console.log(`  provider: ${provider.name}`)
console.log(`  model:    ${provider.model}\n`)

// Two tools: one parameterless, one with arguments. Both shapes exist in the
// real tool set and Gemini treats them differently, so both are worth proving.
const tools: LlmToolDef[] = [
  {
    name: 'get_move_decomposition',
    description: 'Split a stock move into the part the market explains and the residual it does not.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_market_events',
    description: 'Find company events published inside a time range.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO 8601 start' },
        to: { type: 'string', description: 'ISO 8601 end' },
      },
      required: ['from', 'to'],
    },
  },
]

async function main(): Promise<void> {
  // 1. Can it call a tool at all?
  const first = await provider!.turn({
    system: 'You investigate market anomalies by calling tools. Always start by decomposing the move.',
    history: [{
      role: 'user',
      text: 'HDFCBANK fell 7.8% between 10:14 and 15:30 IST. Begin the investigation.',
    }],
    tools,
  })

  console.log(`  turn 1: stop=${first.stop} toolCalls=${first.toolCalls.length}`)
  for (const c of first.toolCalls) console.log(`    -> ${c.name}(${JSON.stringify(c.input)})`)
  if (first.toolCalls.length === 0) {
    console.log(`    text: ${first.text.slice(0, 160)}`)
    console.log('\n  FAILED: the model did not call a tool. Function calling is not working.')
    process.exit(1)
  }

  // 2. Can it accept a tool result and continue? This is where correlation ids
  //    and response shapes usually break.
  const call = first.toolCalls[0]!
  const second = await provider!.turn({
    system: 'You investigate market anomalies by calling tools. Be brief.',
    history: [
      { role: 'user', text: 'HDFCBANK fell 7.8% between 10:14 and 15:30 IST. Begin the investigation.' },
      { role: 'assistant', text: first.text, toolCalls: first.toolCalls },
      {
        role: 'tool',
        results: [{
          id: call.id, name: call.name,
          content: JSON.stringify({
            stock_return_pct: -7.8, index_return_pct: -2.4, beta: 1.37,
            residual_pct: -4.5, residual_sigmas: -3.7,
          }),
        }],
      },
    ],
    tools,
  })

  console.log(`  turn 2: stop=${second.stop} toolCalls=${second.toolCalls.length}`)
  if (second.toolCalls.length > 0) {
    for (const c of second.toolCalls) console.log(`    -> ${c.name}(${JSON.stringify(c.input)})`)
  }
  if (second.text) console.log(`    text: ${second.text.slice(0, 200)}`)

  console.log('\n  Round trip works: the model called a tool, read the result, and continued.')
  console.log('  The agent is ready. Click Investigate on any change.')
}

main().catch((err) => {
  console.error(`\n  FAILED: ${(err as Error).message}`)
  console.error('  If this mentions a model name, try another in .env (AGENT_MODEL).')
  process.exit(1)
})
