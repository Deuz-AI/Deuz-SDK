// A `deuz acp` module for the tests: a mock model, no tools.
import { createMockModel } from '@deuz-sdk/core/testing';

export default {
  info: { name: 'fixture-agent', version: '1.0.0' },
  run: { model: createMockModel({ responses: [{ text: 'hello from the fixture' }] }) },
};

/** A factory export: called with the arguments after `--`. */
export function factory({ argv }) {
  return {
    info: { name: `factory-${argv[0] ?? 'none'}`, version: '1.0.0' },
    run: { model: createMockModel({ responses: [{ text: 'factory reply' }] }) },
  };
}

/** Wrong shape: no `run`. */
export const broken = { info: { name: 'broken', version: '0' } };
