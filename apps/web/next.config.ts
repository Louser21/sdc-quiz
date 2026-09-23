import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@quiz/shared"],
};

const apiTarget = process.env.API_PROXY_TARGET;
if (apiTarget) {
  // Local dev without nginx: proxy REST calls to the Fastify backend.
  config.rewrites = async () => [
    { source: "/api/:path*", destination: `${apiTarget}/api/:path*` },
  ];
}

export default config;