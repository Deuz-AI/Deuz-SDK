/**
 * jsdom globals with Vite's server-side transform. The composite replay
 * imports the core end-to-end harness, which reaches Node built-ins
 * (`node:sqlite`, `node:child_process`); Vite's client transform, which the
 * plain jsdom environment uses, refuses to bundle those on Linux. The
 * server-side transform keeps them external, as in the core tests.
 */
import { builtinEnvironments, type Environment } from 'vitest/runtime';

const environment: Environment = {
  ...builtinEnvironments.jsdom,
  name: 'jsdom-ssr',
  viteEnvironment: 'ssr',
};

export default environment;
