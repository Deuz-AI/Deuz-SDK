import { describe, expect, it } from 'vitest';
import { NoObjectGeneratedError } from '../src/errors';

describe('NoObjectGeneratedError (2.3): the last attempt’s stop explanation', () => {
  it('carries the finish reason and stop details of the attempt that gave up', () => {
    const error = new NoObjectGeneratedError('refused', {
      text: '',
      finishReason: 'content_filter',
      stopDetails: { type: 'refusal', category: 'cyber', explanation: 'declined' },
    });
    expect(error.finishReason).toBe('content_filter');
    expect(error.stopDetails).toEqual({
      type: 'refusal',
      category: 'cyber',
      explanation: 'declined',
    });
    // The finish reason is safe to log; the explanation stays on the error only.
    expect(error.toJSON()).toEqual({
      name: 'NoObjectGeneratedError',
      code: 'no_object_generated',
      message: 'refused',
      details: { finishReason: 'content_filter' },
    });
  });

  it('keeps the 2.2 shape when the caller passes neither', () => {
    const error = new NoObjectGeneratedError('bad json', { text: '{' });
    expect(error.finishReason).toBeUndefined();
    expect(error.stopDetails).toBeUndefined();
    expect(error.toJSON()).toEqual({
      name: 'NoObjectGeneratedError',
      code: 'no_object_generated',
      message: 'bad json',
    });
  });
});
