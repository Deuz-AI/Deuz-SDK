import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    anthropic: 'src/anthropic.ts',
    openai: 'src/openai.ts',
    xai: 'src/xai.ts',
    google: 'src/google.ts',
    'mcp/index': 'src/mcp/index.ts',
    'mcp/stdio': 'src/mcp/stdio.ts',
    edge: 'src/edge.ts',
    react: 'src/react.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  splitting: true,
  target: 'es2022',
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
