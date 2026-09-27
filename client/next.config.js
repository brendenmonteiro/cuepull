/** @type {import('next').NextConfig} */
// BUILD_TARGET=desktop produces a static export for the Electron app (served
// over http by the Express server). The default "standalone" output is what the
// Docker image needs, so it stays the default.
const isDesktop = process.env.BUILD_TARGET === "desktop";

const nextConfig = {
  output: isDesktop ? "export" : "standalone",
  // Emits out/dashboard/index.html, which express.static resolves natively.
  trailingSlash: isDesktop,
  env: {
    // Desktop serves the page from the same origin as the API, so an empty
    // string makes socket.io and download links relative. Every consumer
    // string-concatenates this, so "" needs no call-site changes.
    NEXT_PUBLIC_SERVER_URL: isDesktop
      ? ""
      : process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3001",
  },
};

module.exports = nextConfig;
