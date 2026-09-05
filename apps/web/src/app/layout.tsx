import type { Metadata } from 'next'
import './globals.css'
import { Nav } from '@/components/Nav'

export const metadata: Metadata = {
  title: 'Since — what changed while you were away',
  description:
    'A personalised market diff engine. Not what your stocks are doing — what meaningfully changed since you last looked.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-paper-raised focus:px-3 focus:py-2">
          Skip to content
        </a>
        <Nav />
        <main id="main" className="mx-auto w-full max-w-3xl px-5 pb-24 sm:px-8">{children}</main>
      </body>
    </html>
  )
}
