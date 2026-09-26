# Deuz SDK 2.2 documentation

The documentation site for `@deuz-sdk/core` and `@deuz-sdk/react`, built with
Next.js and Fumadocs. Version 2.2 adds dynamic swarms, cross-process operations,
persistent budgets, evolve and schedules while keeping the existing APIs available.

- [What is new in 2.2](content/docs/reference/whats-new-2-2.mdx): release scope,
  upgrade guidance and operational limits.
- [Native agents](content/docs/modules/native-agents.mdx): validated results,
  strict checkpoints, approval/client-result resume and shared execution budgets.
- [Swarm](content/docs/modules/swarm.mdx): DAGs that grow at runtime, blackboards,
  rounds, memory/SQLite/Postgres stores, recovery and cursor events.
- [Installation](content/docs/installation.mdx) and
  [quickstart](content/docs/quickstart.mdx).

Without a lease provider, drive each swarm run from one process. External effects
require idempotency or reconciliation, cancellation is cooperative, and budget
admission uses estimates.
The feature guides document these boundaries alongside their examples.

## Develop and verify

Run these commands from the repository root. The docs application has its own
lockfile and is installed separately from the SDK workspaces:

```bash
npm ci
npm ci --prefix docs
npm --prefix docs run dev
```

Open http://localhost:3000 with your browser to see the result.

```bash
# Verify documentation links and SDK import names.
npm run verify:docs-refs

# Generate Fumadocs/Next.js types and check the docs application.
npm --prefix docs run types:check

# Build the documentation site.
npm --prefix docs run build

# Run the documentation reference, type and build gates together.
npm run verify:docs
```

## Explore

In the project, you can see:

- `lib/source.ts`: Code for content source adapter, [`loader()`](https://fumadocs.dev/docs/headless/source-api) provides the interface to access your content.
- `lib/layout.shared.tsx`: Shared options for layouts, optional but preferred to keep.

| Route                     | Description                                   |
| ------------------------- | --------------------------------------------- |
| `app/[lang]/(home)`       | The localized landing page and release links. |
| `app/[lang]/docs`         | The localized documentation layout and pages. |
| `app/api/search/route.ts` | The Route Handler for search.                 |

Release copy is in `lib/home-copy.ts`; document pages and navigation metadata are
under `content/docs`. The homepage and shared navigation link to the current
release page, while earlier release pages remain available in Reference.

### Fumadocs MDX

A `source.config.ts` config file has been included, you can customise different options like frontmatter schema.

Read the [Introduction](https://fumadocs.dev/docs/mdx) for further details.

## Learn More

To learn more about Next.js and Fumadocs, take a look at the following
resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js
  features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [Fumadocs](https://fumadocs.dev) - learn about Fumadocs

## Brand assets

- `app/icon.svg` and `Logo()` in `lib/layout.shared.tsx` are the ring-and-dot mark.
- The hero mascot is rendered in 3D from `public/mascot/deuz-mascot.glb`; run
  `npm run mascot:export -- path/to/mr.deuz.blend` to regenerate it from the Blender
  file, and see [`MASCOT-MODEL.md`](./MASCOT-MODEL.md) for the contract it meets. The
  PNG next to it is the server-rendered fallback.
- Provider marks on the home page come from `@lobehub/icons-static-svg`; run
  `npm run logos:sync` to regenerate `lib/provider-logos.generated.ts` after bumping it.
