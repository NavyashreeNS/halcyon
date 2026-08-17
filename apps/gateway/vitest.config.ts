import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // These tests bind real ports and dispatch real HTTP between the gateway and a fake
    // worker. Running files in parallel would have them compete for the event loop and make
    // latency-sensitive assertions flaky for reasons that have nothing to do with the code.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
