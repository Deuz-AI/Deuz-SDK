/** Structured-output tasks: a typed result, and a candidate that fails validation once. */
import { runAgent } from '../../../src/agent-run';
import type { EvalTaskManifest } from '../../../src/testing';
import { completes, mockPrices, offline, runWith, scripted, type TaskModel } from '../support';

const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };

interface Invoice {
  currency: string;
  lines: Array<{ item: string; amount: number }>;
  total: number;
}

const invoiceSchema = {
  type: 'object',
  properties: {
    currency: { type: 'string' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { item: { type: 'string' }, amount: { type: 'number' } },
        required: ['item', 'amount'],
      },
    },
    total: { type: 'number' },
  },
  required: ['currency', 'lines', 'total'],
};

function validateInvoice(value: unknown): Invoice {
  const invoice = value as Partial<Invoice> | null;
  if (!invoice || typeof invoice.currency !== 'string') throw new Error('currency is required');
  if (!Array.isArray(invoice.lines)) throw new Error('lines must be an array');
  for (const line of invoice.lines)
    if (typeof line?.amount !== 'number') throw new Error('every line amount must be a number');
  if (typeof invoice.total !== 'number') throw new Error('total must be a number');
  return invoice as Invoice;
}

const invoiceOutput = { schema: invoiceSchema, mode: 'json' as const, validate: validateInvoice };

const RECEIPT =
  'Coffee beans 12.50 EUR, Filter papers 3.20 EUR, Grinder cleaning 4.30 EUR. Extract the invoice.';

const sumsUp = {
  name: 'total is the sum of the lines',
  check: (outcome: { output?: unknown }) => {
    const invoice = outcome.output as Invoice | undefined;
    if (!invoice) return false;
    const sum = invoice.lines.reduce((total, line) => total + line.amount, 0);
    return Math.abs(sum - invoice.total) < 1e-9 && invoice.lines.length === 3;
  },
};

const VALID: Invoice = {
  currency: 'EUR',
  lines: [
    { item: 'Coffee beans', amount: 12.5 },
    { item: 'Filter papers', amount: 3.2 },
    { item: 'Grinder cleaning', amount: 4.3 },
  ],
  total: 20,
};

export const invoiceExtraction: EvalTaskManifest = {
  id: 'structured-output/invoice',
  version: 1,
  title: 'Extract a typed invoice',
  tags: ['structured-output'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: RECEIPT }] },
  tools: { allowed: [] },
  budget: { usd: 0.01 },
  acceptance: [
    completes,
    sumsUp,
    {
      name: 'currency is EUR',
      check: (outcome) => (outcome.output as Invoice | undefined)?.currency === 'EUR',
    },
  ],
  run: extractInvoice(offline([{ text: JSON.stringify(VALID) }])),
};

/** Run the extraction on `on`'s model. */
export function extractInvoice(on: TaskModel): NonNullable<EvalTaskManifest['run']> {
  return (context) =>
    runAgent<Invoice>({
      ...runWith(on, context),
      messages: context.messages,
      output: invoiceOutput,
    });
}

export const invoiceRepair: EvalTaskManifest = {
  id: 'structured-output/repair',
  version: 1,
  title: 'Repair a candidate that fails validation',
  tags: ['structured-output'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: RECEIPT }] },
  tools: { allowed: [] },
  budget: { usd: 0.01 },
  acceptance: [
    completes,
    sumsUp,
    {
      name: 'the model saw the validation error before repairing',
      check: (_outcome, context) => context.store.secondRequestSawError === true,
    },
  ],
  async run(context) {
    const invalid = { ...VALID, total: '20.00' };
    const { model, calls } = scripted([
      { text: JSON.stringify(invalid) },
      { text: JSON.stringify(VALID) },
    ]);
    const result = await runAgent<Invoice>({
      model,
      messages: context.messages,
      output: invoiceOutput,
      signal: context.signal,
      deps: { observer: context.observer, priceProvider: mockPrices },
    });
    const transcript = JSON.stringify(result.messages);
    context.store.secondRequestSawError =
      calls() === 2 && transcript.includes('total must be a number');
    return result;
  },
};
