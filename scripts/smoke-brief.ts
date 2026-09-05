/** Dev smoke check: evaluate a brief at an arbitrary instant and print it. */
import { evaluateBrief } from '../apps/api/src/services/brief.js'
import { sql } from '@since/db'

const at = new Date(process.argv[2] ?? '2026-09-04T10:00:00.000Z')
const b = await evaluateBrief({ userId: 'user_demo', at })

console.log('provider          :', b.provider, '| simulated:', b.simulated)
console.log('window            :', b.window.windowStart.toISOString(), '->', b.at)
console.log('away              :', b.window.awayLabel, '| sessions:', b.window.sessions)
console.log('watched/changed   :', b.totalWatched, '/', b.changedCount)
console.log('attention/filtered:', b.attentionCount, '/', b.filteredCount)
console.log('suppressed        :', b.suppressedCount, b.suppressed.map((s) => `${s.symbolId}:${s.quality}`).join(' '))
console.log('regime            :', b.regime ? b.regime.headline : 'none')
console.log('--- cards ---')
for (const c of b.cards) {
  const s = c.score
  console.log(` ${b.symbolNames[c.symbolId] ?? c.symbolId}  ${s.returnPct?.toFixed(2)}%  p${s.pctl.toFixed(1)}  ${s.tier}  raw=${s.raw.toFixed(2)}`)
  console.log(`   ${c.frequency}${c.group ? `  [GROUP ${c.group.sectorName}: ${c.group.members.join(', ')}]` : ''}`)
  for (const k of s.contributions) console.log(`     ${k.label.padEnd(22)} ${k.points.toFixed(2)}  ${k.detail}`)
}
await sql.end()
