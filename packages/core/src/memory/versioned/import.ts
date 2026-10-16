/**
 * `importLegacyMemory` (2.4, spec §2.2): moves a legacy `MemoryStore` scope
 * into a versioned store. Explicit and re-runnable; the legacy writers are
 * stopped first, there is no dual write. Edge-safe.
 */
import { OperationConflictError } from '../../errors';
import { digestJson } from '../../internal/digest';
import { scopeWithin } from '../../internal/native-scope';
import { resolveDependencies } from '../../internal/resolve-deps';
import { DEUZ_ATTR, DEUZ_SPAN, observeSpan } from '../../internal/telemetry';
import type { MemoryRecord, MemoryScope } from '../../memory';
import { checkScope, invalid, isMemoryKind, isOrigin, textDigest, throwIfAborted } from './shared';
import type { ImportLegacyMemoryOptions, ImportLegacyMemoryResult } from './types';

/**
 * Imports a legacy `MemoryStore` scope into a versioned store (2.4): each
 * legacy record becomes revision 1 under operation `<prefix>:<legacy id>`, so
 * running it again replays instead of duplicating. Expired and invalidated
 * records are skipped; vectors are not carried over (re-embed instead).
 *
 * A record keeps its legacy id and its own legacy scope (a legacy `list`
 * matches sub-scopes too), gets one `'host'` source with the digest of its
 * text, and its legacy times under `metadata.legacyImport`. A record that
 * changed since an earlier import is skipped with a warning: revise it in the
 * versioned store instead.
 */
export async function importLegacyMemory(
  options: ImportLegacyMemoryOptions,
): Promise<ImportLegacyMemoryResult> {
  if (options === null || typeof options !== 'object')
    throw invalid('importLegacyMemory needs options.');
  const { from, to, signal } = options;
  if (from === null || typeof from !== 'object' || typeof from.list !== 'function')
    throw invalid('importLegacyMemory needs a legacy MemoryStore as `from`.');
  if (to === null || typeof to !== 'object' || typeof to.commit !== 'function')
    throw invalid('importLegacyMemory needs a VersionedMemoryStore as `to`.');
  const scope = checkScope(options.scope);
  const prefix = options.operationPrefix ?? 'import';
  if (typeof prefix !== 'string' || !prefix)
    throw invalid('operationPrefix must be a non-empty string.');
  const batchSize = options.batchSize ?? 64;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1)
    throw invalid('batchSize must be a positive integer.');
  const origin = options.origin ?? 'inferred';
  if (!isOrigin(origin)) throw invalid("origin must be 'asserted' or 'inferred'.");
  const deps = resolveDependencies(options.deps);

  return observeSpan(
    deps,
    DEUZ_SPAN.memoryOp,
    { [DEUZ_ATTR.memoryOperation]: 'import' },
    async (annotate): Promise<ImportLegacyMemoryResult> => {
      annotate({ [DEUZ_ATTR.memoryOperation]: 'import' });
      throwIfAborted(signal);
      const now = deps.clock.now();
      const records = await from.list(scope);
      let scanned = 0;
      let imported = 0;
      let skipped = 0;

      const importOne = async (record: MemoryRecord): Promise<boolean> => {
        if (
          record === null ||
          typeof record !== 'object' ||
          typeof record.id !== 'string' ||
          !record.id ||
          typeof record.text !== 'string'
        )
          return false;
        if (record.invalidAt != null) return false;
        if (record.expiresAt !== undefined && record.expiresAt <= now) return false;
        let recordScope: MemoryScope;
        try {
          recordScope = checkScope(record.scope);
        } catch {
          return false;
        }
        if (!scopeWithin(recordScope, scope)) return false;
        const kind = isMemoryKind(record.kind) ? record.kind : 'semantic';
        const importance =
          typeof record.importance === 'number' && Number.isFinite(record.importance)
            ? Math.min(1, Math.max(0, record.importance))
            : undefined;
        const expiresAt =
          typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
            ? record.expiresAt
            : undefined;
        const metadata = {
          ...(record.metadata ?? {}),
          legacyImport: { id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt },
        };
        const requestDigest = await digestJson({
          type: 'import',
          scope: recordScope,
          id: record.id,
          text: record.text,
          kind,
          origin,
          importance,
          expiresAt,
          metadata,
        });
        const operationId = `${prefix}:${record.id}`;
        try {
          const result = await to.commit({
            operationId,
            scope: recordScope,
            actor: 'import',
            requestDigest,
            mutations: [
              {
                type: 'create',
                record: {
                  id: record.id,
                  text: record.text,
                  kind,
                  origin,
                  sources: [{ kind: 'host', digest: await textDigest(record.text) }],
                  ...(importance !== undefined ? { importance } : {}),
                  ...(expiresAt !== undefined ? { expiresAt } : {}),
                  metadata,
                },
              },
            ],
          });
          // A replay was imported before; a conflict means the id is taken.
          return result.status === 'committed';
        } catch (error) {
          if (!(error instanceof OperationConflictError)) throw error;
          deps.logger.warn(
            'importLegacyMemory skipped a legacy record that changed since it was imported; revise it in the versioned store instead.',
            { operationId },
          );
          return false;
        }
      };

      for (let start = 0; start < records.length; start += batchSize) {
        throwIfAborted(signal);
        for (const record of records.slice(start, start + batchSize)) {
          scanned++;
          if (await importOne(record)) imported++;
          else skipped++;
        }
      }
      annotate({ [DEUZ_ATTR.memoryRecordCount]: imported });
      return { scanned, imported, skipped };
    },
  );
}
