/**
 * Node-only `ChatStore` reference implementation (1.7, P2): one JSON file per
 * chat under `dir`, written atomically enough for a dev server / CLI agent.
 * Binary message parts survive via the `$deuzBytes` codec. Ships as
 * `@deuz-sdk/core/chat/node`; Supabase/SQLite adapters live in the docs.
 */
import type { ChatRecord, ChatStore, MemoryScope } from '../chat';
import { serializeChatRecord, deserializeChatRecord } from '../chat';

export interface JsonlChatStoreOptions {
  /** Directory for the chat files (created on first save). */
  dir: string;
}

// Minimal node builtin shape; `as string` keeps tsup's dts builder from
// statically resolving node: specifiers (matches node/observe.ts).
interface NodeFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: string, encoding: string): Promise<void>;
  readFile(path: string, encoding: string): Promise<string>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

function fileNameFor(chatId: string): string {
  return `${encodeURIComponent(chatId)}.json`;
}

/** File-backed `ChatStore` — lazy `node:fs/promises`, zero deps. */
export function createJsonlChatStore(options: JsonlChatStoreOptions): Required<ChatStore> {
  const fsp = async (): Promise<NodeFs> =>
    (await import('node:fs/promises' as string)) as unknown as NodeFs;
  const path = (name: string): string => `${options.dir}/${name}`;

  return {
    async saveChat(record: ChatRecord): Promise<void> {
      const fs = await fsp();
      await fs.mkdir(options.dir, { recursive: true });
      await fs.writeFile(path(fileNameFor(record.chatId)), serializeChatRecord(record), 'utf8');
    },
    async loadChat(chatId: string): Promise<ChatRecord | undefined> {
      const fs = await fsp();
      try {
        return deserializeChatRecord(await fs.readFile(path(fileNameFor(chatId)), 'utf8'));
      } catch {
        return undefined;
      }
    },
    async deleteChat(chatId: string): Promise<void> {
      const fs = await fsp();
      try {
        await fs.unlink(path(fileNameFor(chatId)));
      } catch {
        /* already gone */
      }
    },
    async listChats(scope?: MemoryScope): Promise<string[]> {
      const fs = await fsp();
      let names: string[];
      try {
        names = await fs.readdir(options.dir);
      } catch {
        return [];
      }
      const ids = names
        .filter((n) => n.endsWith('.json'))
        .map((n) => decodeURIComponent(n.slice(0, -'.json'.length)));
      if (!scope) return ids;
      const entries = Object.entries(scope).filter(([, v]) => v !== undefined);
      const matched: string[] = [];
      for (const id of ids) {
        const record = await this.loadChat(id);
        if (record && entries.every(([k, v]) => record.scope[k as keyof MemoryScope] === v)) {
          matched.push(id);
        }
      }
      return matched;
    },
  };
}
