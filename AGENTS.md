<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project conventions (industry-intel)

Runtime: Node 20.20.0 (npm). Do not use an API or a package version that needs Node 22.

- **Two processes, one SQLite file.** The web process (Next.js) and the worker process (`src/worker/main.ts`, run with tsx) share the file at `DATABASE_PATH` (default `./data/app.db`).
- **Database access.** Import `getDb()` (drizzle) or `getSqlite()` (raw better-sqlite3, for FTS5) from `@/lib/db/client`. Call them in a function, not at module top level: an import must not open the database (`next build` imports each route).
- **Transactions.** For a transaction that reads and then writes, use `db.transaction(fn, { behavior: "immediate" })`. A default (deferred) transaction can fail with "database is locked" when the other process writes.
- **Errors.** To read the SQLite error code, use `sqliteErrorCode(error)` from `@/lib/db/errors` (for example `SQLITE_CONSTRAINT_UNIQUE`). A query-builder call throws the raw SQLite error; `db.run(sql)` wraps it. The helper handles the two cases.
- **Migrations.** Change `src/lib/db/schema.ts`, then run `npm run db:generate -- --name=<name>`. For hand-written SQL (FTS5, triggers) run `npm run db:generate -- --custom --name=<name>`, then put the line `--> statement-breakpoint` between two statements. Do not edit an applied migration. Do not use `drizzle-kit push`. Each process applies the pending migrations at its first `getDb()` call, behind a lock.
- **Tests.** vitest, node environment, files `src/**/*.test.ts`. Call `installTestDb()` from `@/test/helpers` in the test file: it points `getDb()` and `getSqlite()` at a temporary database with all migrations and no seed data. Call the `cleanup()` that it returns after the test. Domain functions call `getDb()` inside; they take no database argument. `@/test/helpers` also has `FakeHttp`, `FakeLlm`, `FakeUsageMeter`, `loadFixture`, `setNowForTests`, and factories (`makeFeed`, `makeSource`, `makeItem`, `makeStory`, `makeJudgement`, `addVote`). No test uses the network or a real key.
- **Rendering.** `cacheComponents` is off. The root layout sets `export const dynamic = "force-dynamic"`, so each page renders at request time. A route handler (`route.ts`) is not below a layout: add `export const dynamic = "force-dynamic"` to each route handler that reads the database.
- **Request data.** `params` and `searchParams` are promises: `await` them. `cookies()` and `headers()` are async.
- **Access.** `src/proxy.ts` gates every path that is not in the public list of `src/app/_lib/access-gate.ts`. Each page also calls `requireUser()`. Each Server Action runs inside `withActor()` or `withAdmin()`: the proxy does not protect an action by itself. `src/app/auth-coverage.test.ts` fails when one is missing.
- **Mutations.** Use Server Actions (`"use server"` files). Validate the input with zod, write, then call `revalidatePath()`.
- **Environment.** Next.js loads `.env` for the web process. The worker imports `@/lib/load-env` as its first import. Read `process.env` in functions. Do not print a value. `PORT` comes from the shell only.
- **Shared code.** Code in `src/lib` runs in the two processes. Do not import `server-only`, `next/*`, or React there if the worker uses the module.
- **Native packages.** Add each native or Node-only server package to `serverExternalPackages` in `next.config.ts`.
- **Alias.** `@/*` is `src/*` (tsconfig.json for Next.js, tsc, and tsx; `vitest.config.mts` for vitest).
- **Styles.** Tailwind CSS 4 with no config file. The tokens are CSS variables in `src/app/globals.css` (light and dark values). Use the token utilities (`bg-surface`, `text-muted`, `border-border`, `bg-accent`), not fixed colors.
- **Specification.** `docs/specification.md` describes the behavior of the product (pipeline, ranking, sources, settings). The contract files in `src/lib` (`types.ts`, `connectors/types.ts`, `connectors/configs.ts`, `services/types.ts`) are the source of truth for exact names.
