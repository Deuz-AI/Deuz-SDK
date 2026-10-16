import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'react',
          // Hooks/components run against the DOM; jsdom provides it.
          environment: 'jsdom',
          include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
          exclude: ['test/e2e-2-4/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e-2-4',
          // jsdom with Vite's server-side transform: the composite replay
          // imports the core harness, which reaches Node built-ins.
          environment: './test/e2e-2-4/jsdom-ssr-environment.ts',
          include: ['test/e2e-2-4/**/*.test.tsx'],
        },
      },
    ],
  },
});
