# ADR 0002: Monorepo Orchestration with pnpm Workspaces & Turborepo

## Status
Accepted

## Date
2026-09-28

## Context
DevPulse comprises multiple deployable applications (`apps/api`, `apps/worker`, `apps/web`) and several domain libraries (`packages/config`, `packages/database`, `packages/github`, `packages/logger`, `packages/redis`, `packages/types`). 

We required a tooling solution that:
1. Prevents code duplication across frontend and backend services (especially types and configurations).
2. Enables atomic commits and synchronized releases across applications and packages.
3. Provides fast dependency installation, disk-space efficiency, and strict phantom-dependency prevention.
4. Offers intelligent build caching and task pipelining for local development and CI/CD.

We evaluated:
- Multi-repo setup (separate Git repositories per service/library)
- npm / yarn workspaces with Lerna
- pnpm workspaces with Turborepo

## Decision
We chose **pnpm workspaces** combined with **Turborepo** (`turbo.json`) as our monorepo architecture.

Key aspects:
- `pnpm-workspace.yaml` declares `apps/*` and `packages/*`.
- pnpm uses a content-addressable store and strict symlinking, preventing phantom dependencies.
- Turborepo coordinates build pipelines (`build`, `dev`, `lint`), caching artifact outputs and executing dependency tasks in topological order.
- Applications reference packages using `"workspace:*"` protocol.

## Consequences
- **Positive**:
  - High-performance, reproducible local and CI builds with Turbo caching.
  - Shared domain models and TypeScript contracts in `@devpulse/types` without publishing to an external npm registry.
  - Strict dependency boundaries eliminate accidental circular dependencies.
- **Negative**:
  - Developers must use `pnpm` (version >= 9.x) instead of npm or yarn.
  - Root lockfile (`pnpm-lock.yaml`) must be kept clean when adding dependencies via `pnpm --filter <target> add <pkg>`.
