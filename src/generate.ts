import { NotImplementedError } from './errors';
import type {
  StreamChat,
  GenerateText,
  GenerateObject,
  GenerateObjectOptions,
  GenerateObjectResult,
} from './types/methods';

/**
 * Canonical free functions. Faz 0 ships honest stubs: the public surface is
 * locked, but calling any of them throws NotImplementedError until the
 * inference pipeline lands in Faz 1.
 */
export const streamChat: StreamChat = () => {
  throw new NotImplementedError('streamChat');
};

export const generateText: GenerateText = () => {
  throw new NotImplementedError('generateText');
};

export const generateObject: GenerateObject = <T = unknown>(
  _options: GenerateObjectOptions<T>,
): Promise<GenerateObjectResult<T>> => {
  throw new NotImplementedError('generateObject');
};
