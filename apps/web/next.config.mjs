const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000'

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The API is proxied rather than called cross-origin.
  //
  // Calling 127.0.0.1:4000 directly from localhost:3000 is a cross-SITE request,
  // so the session cookie is dropped under SameSite=Lax. Weakening the cookie to
  // SameSite=None would be the wrong fix. Proxying makes the API first-party:
  // no CORS, no cookie exceptions, and one origin to open.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` },
      { source: '/debug/:path*', destination: `${API_ORIGIN}/debug/:path*` },
    ]
  },
}
