import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      include: ['src/**/*.ts'],
    },
  },
  resolve: {
    // Allow .js extensions in imports (TypeScript ESM convention)
    extensions: ['.ts', '.js'],
  },
});
