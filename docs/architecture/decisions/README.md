# Architecture Decision Records (ADRs)

Architecture Decision Records (ADRs) capture important architectural and design decisions made throughout the lifecycle of DevPulse, including their context, rationale, and consequences.

## Index of Decisions

| ADR | Title | Status | Date |
|:---|:---|:---|:---|
| [ADR-0001](0001-record-architecture-decisions.md) | Record Architecture Decisions | Accepted | 2026-09-28 |
| [ADR-0002](0002-monorepo-pnpm-turborepo.md) | Monorepo Orchestration with pnpm Workspaces & Turborepo | Accepted | 2026-09-28 |
| [ADR-0003](0003-modular-nestjs-backend-and-worker.md) | Decoupled NestJS REST API and Standalone Background Worker with BullMQ | Accepted | 2026-10-05 |
| [ADR-0004](0004-postgresql-and-prisma-orm.md) | PostgreSQL Database with Prisma ORM | Accepted | 2026-10-05 |
| [ADR-0005](0005-isolated-github-integration-package.md) | Isolated GitHub Integration Package (`@devpulse/github`) | Accepted | 2026-10-13 |
| [ADR-0006](0006-centralized-zod-environment-configuration.md) | Centralized Configuration with Zod Validation (`@devpulse/config`) | Accepted | 2026-10-13 |

---

## ADR Structure

Each ADR follows the standard format:
- **Title**: Sequential number and concise description (`XXXX-decision-title.md`)
- **Status**: `Proposed`, `Accepted`, `Superceded`, or `Deprecated`
- **Context**: The problem statement, technical requirements, and constraints
- **Decision**: The selected architectural approach and implementation details
- **Consequences**: Positive tradeoffs, limitations, and operational implications
