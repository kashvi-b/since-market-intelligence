'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: 'Brief' },
  { href: '/watchlist', label: 'Watchlist' },
  { href: '/health', label: 'Data' },
  { href: '/eval', label: 'Evaluation' },
]

export function Nav() {
  const path = usePathname()
  return (
    <header className="mx-auto w-full max-w-3xl px-5 sm:px-8">
      <div className="flex items-baseline justify-between gap-6 py-6">
        <Link href="/" className="font-serif text-[1.35rem] tracking-tightest text-ink">
          Since
        </Link>
        <nav className="flex items-baseline gap-5" aria-label="Primary">
          {LINKS.map((l) => {
            const active = l.href === '/' ? path === '/' : path.startsWith(l.href)
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={`tap text-[0.8rem] transition-colors ${
                  active ? 'text-ink' : 'text-ink-faint hover:text-ink-muted'
                }`}
              >
                {l.label}
              </Link>
            )
          })}
        </nav>
      </div>
      <div className="rule" />
    </header>
  )
}
