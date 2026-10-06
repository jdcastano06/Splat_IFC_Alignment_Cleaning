/** @type {import('next').NextConfig} */
const nextConfig = {
  // The engine owns long-lived WebGL viewports; StrictMode's dev double-mount would build every
  // one twice. Effects are idempotent anyway, but there is no reason to pay for it.
  reactStrictMode: false,
  // The dev badge sits on top of the Select footer; the tool has its own status pill.
  devIndicators: false,
  // The FastAPI service stays private behind this proxy, exactly as the old Vite one did.
  async rewrites() {
    return [{ source: "/api/:path*", destination: "http://127.0.0.1:8777/api/:path*" }];
  },
  experimental: {
    // Big SOG bodies, a first auto-room detection (~1 min) and full-PLY exports stream through
    // the proxy; don't let it cut them off.
    proxyTimeout: 10 * 60 * 1000,
  },
};

export default nextConfig;
