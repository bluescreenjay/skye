import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Home/ingest hit the API at 127.0.0.1; Next's default origin is localhost.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
