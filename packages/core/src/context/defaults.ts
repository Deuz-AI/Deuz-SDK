/** The context compiler's spec §2.3 defaults, in their own module so every part can read them. */

/** The added-context budget defaults of spec §2.3. */
export const DEFAULT_CONTEXT_BUDGET = {
  ratio: 0.2,
  maxTokens: 8192,
  workingMemoryTokens: 1024,
  shares: { memory: 2, rag: 2, skills: 1, transcript: 1 },
  candidatesPerSource: 20,
} as const;

/** The retrieval refresh defaults of spec §2.3. */
export const DEFAULT_CONTEXT_REFRESH = { minSteps: 2, maxPasses: 4 } as const;
