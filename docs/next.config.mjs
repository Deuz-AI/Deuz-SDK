import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The repository and docs app both own lockfiles; keep Turbopack scoped to
  // this Next.js project so CI resolution is deterministic and warning-free.
  turbopack: { root: import.meta.dirname },
};

export default withMDX(config);
