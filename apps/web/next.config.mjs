import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the trace root to the monorepo. Left to infer, Next walks up until it finds a
  // lockfile and can land outside the repository entirely on a developer machine, which
  // makes the standalone bundle non-reproducible.
  outputFileTracingRoot: resolve(here, '../..'),
  // Standalone output ships a self-contained server with only the files actually imported,
  // which takes the production image from ~1.2GB to well under 200MB.
  output: 'standalone',
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_GATEWAY_URL: process.env.GATEWAY_URL ?? 'http://localhost:8080',
  },
};

export default nextConfig;
