# AI Daily News Digest

## Source of truth

- `docs/product-spec-v1.1.md` defines product behavior.
- `docs/technical-spec-v1.1.md` defines architecture and technical behavior.
- The current UI is a visual and interaction reference, not business-rule authority.

## Monorepo

- `apps/web`: React, TypeScript, Vite, Tailwind CSS.
- `apps/server`: Node.js, TypeScript, Fastify API and workers.
- `packages/contracts`: framework-agnostic shared API contracts.
- `packages/domain`: framework-independent domain types and rules.

Use pnpm workspaces. Keep TypeScript strict and respect package boundaries:

```text
apps/web -> packages/contracts
apps/server -> packages/contracts -> packages/domain
```

Do not couple the domain package to React, Fastify, PostgreSQL, or vendor SDKs.
Do not introduce a frontend redesign or implement later phases unless requested.

## Frontend styling

The web app uses Tailwind CSS v4 through `@tailwindcss/vite`. Global font and
base styling belong in `apps/web/src/index.css`. Keep CSS `@import` statements
first. Put global element styles inside `@layer base` so utility classes remain
effective. Tailwind Preflight already applies box sizing, resets margins, and
sets form-control fonts.
