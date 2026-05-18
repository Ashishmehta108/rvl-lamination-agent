# Repository Guidelines

## Project Structure & Module Organization

This Node 20+ npm workspace supports an industrial lamination monitoring stack.

- `apps/backend`: Fastify API, ingestion routes, workers, queues, MCP, RAG, and scripts under `src/`.
- `apps/web`: Next.js UI on port `3000`, source in `src/`, and Tailwind/PostCSS config at the app root.
- `apps/desktop`: Electron wrapper for the web UI, with source in `src/`.
- `packages/shared`: shared TypeScript types and schemas.
- `packages/db-mongo`: Prisma MongoDB client and schema in `prisma/`.
- `packages/db-postgres`: Drizzle/Postgres schema, migrations, and config.
- `packages/rag`: local LanceDB/RAG utilities.
- `packages/ml`: Python ML launcher used by `npm run dev:ml`.
- `arduino/`, `raspberry_pi/`, `send/`: hardware and ingestion support assets.

## Build, Test, and Development Commands

- `npm install`: install workspace dependencies.
- `docker compose up -d`: start local MongoDB/Postgres services.
- `npm run db:mongo:generate`: generate the Prisma Mongo client.
- `npm run db:pg:migrate`: apply Drizzle migrations.
- `npm run dev`: run backend, web, and Electron together.
- `npm run dev:all`: run backend, web, Electron, and Python ML service.
- `npm run build`: build packages first, then apps.
- `npm run lint`: run ESLint across workspaces.
- `npm run typecheck`: run TypeScript checks across workspaces.
- `npm run sim`: run the backend simulator.

## Coding Style & Naming Conventions

Use TypeScript ESM (`"type": "module"`) in apps and packages. Keep source under `src/` and build output in `dist/`. Use camelCase for variables/functions and PascalCase for React components/classes. Preserve existing filename patterns. Run `npm run lint` and `npm run typecheck` before handoff.

## Testing Guidelines

No formal test runner or `*.test.*` files are currently present. Validate changes with `npm run typecheck`, `npm run lint`, targeted builds such as `npm run build -w apps/backend`, and scripts like `npm run sim` or `npm run verify:chat -w apps/backend`. When adding tests, place them beside code as `*.test.ts` or `*.spec.ts` and document the command in `package.json`.

## Commit & Pull Request Guidelines

Recent commits use short imperative messages such as `add code` and `add prompts v2`. Keep commits concise but descriptive, for example `add backend ingestion validation`. Pull requests should include a summary, affected workspaces, setup or migration notes, validation commands, and screenshots for UI changes.

## Security & Configuration Tips

Copy `.env.example` to `.env` for local setup. Do not commit `.env`, generated local data, or secrets such as API tokens. Ingestion endpoints expect `Authorization: Bearer <API_AUTH_TOKEN>`.
