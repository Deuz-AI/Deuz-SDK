# 2.3 compatibility gates

Recorded from the unmodified 2.3.0 code (v2.3.0 plus the test compose file) at
the start of 2.4. They protect 2.3 users for the rest of the 2.x line: a 2.4
change that trips one is a breaking change unless the integrator accepts it as
a stated behaviour change. Never re-record a 2.3.0 fixture from 2.4 code.

| File                                | Gate                                                                                                  | Run by                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `consumer-2.3.test-d.ts`            | The 2.3 call surface as a consumer uses it: option shapes, results, parts, events, every subpath      | `npm run test:types -w @deuz-sdk/core`   |
| `consumer-2.3-implement.test-d.ts`  | The interfaces a consumer implements (stores, seams, middleware, MCP client) and the clients it passes | `npm run test:types -w @deuz-sdk/core`   |
| `consumer-surface.test.ts`          | The API contract only grows from `fixtures/api-contract-2.3.0.json`; the fixtures use every 2.3 subpath and only public entry files | `npm run test -w @deuz-sdk/core` |
| `schema-pins.test.ts`               | Every persisted schema version and the 2.3 table layout (`fixtures/schema-layout-2.3.0.json`)          | `npm run test -w @deuz-sdk/core`         |
| `../../../react/test/compat/consumer-2.3.test-d.tsx` | The 2.3 `@deuz-sdk/react` hooks, components and types                              | `npm run typecheck -w @deuz-sdk/react`   |

The provider wire gate lives next door: `../golden-wire.test.ts` and
`../fixtures/golden-wire/`.

## Rules the type fixtures follow

- A union a consumer reads (stream parts, events, warning types, error codes,
  statuses) may widen in 2.x, so it is checked to still hold its 2.3 members
  (`toExtend`), never with an exhaustive switch.
- A result field is read into a variable of its 2.3 type, so a field that
  disappears, turns optional or changes type breaks the file.
- An implemented interface is implemented with its 2.3 members, required and
  optional, and the records it returns are built from the 2.3 fields, so a new
  required member or record field breaks the file.
- Imports point at the source file behind each public subpath (the tsup entry
  map); `consumer-surface.test.ts` enforces it.

The three type fixtures were also compiled against the published
`@deuz-sdk/core@2.3.0` and `@deuz-sdk/react@2.3.0` typings (imports rewritten to
the package subpaths, in a scratch project outside the repo): they use only
the published 2.3 surface.

## Schema pins

`schema-pins.test.ts` reads each store's version table after a fresh store
creates its schema: SQLite (`:memory:`), Postgres (PGlite always, and a live
server when `DEUZ_TEST_POSTGRES_URL` is set) and Redis (ioredis-mock always, and
a live server when `DEUZ_TEST_REDIS_URL` is set). It also rebuilds each SQLite
schema from the recorded 2.3 DDL, opens it with the current code and checks
the version stays. A 2.4 store adds its own tables with its own version table;
an addition to a 2.3 store is a `CREATE ... IF NOT EXISTS` that leaves the
version alone, and a column added to a 2.3 table must be nullable or have a
default. `DEUZ_SCHEMA_PIN_RECORD=1` writes a missing layout entry; it can only
be recorded from the 2.3.0 code.
