/**
 * Canonical free functions, now backed by the real inference pipeline (Faz 1).
 * Each lives in its own module under `inference/` but shares the SAME pipeline
 * in `core/inference.ts`.
 */
export { streamChat } from './inference/stream-chat';
export { generateText } from './inference/generate-text';
export { generateObject } from './inference/generate-object';
export { streamObject } from './inference/stream-object';
