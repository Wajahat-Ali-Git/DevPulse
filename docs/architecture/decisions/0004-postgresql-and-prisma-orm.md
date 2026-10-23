# ADR 0004: PostgreSQL Database with Prisma ORM

## Status
Accepted

## Date
2026-10-05

## Context
DevPulse requires a robust relational data store to persist:
- Multi-tenant workspaces and user accounts.
- Linked GitHub accounts and OAuth tokens.
- Hierarchical git entities: repositories, commits, pull requests, reviews, and activity events.
- Audit logs and event streams with structured JSON payloads (`jsonb`).

We evaluated relational and document stores:
- MongoDB: Flexible for raw payloads, but weak relational integrity and join capabilities for complex metrics across commits, PRs, and reviews.
- PostgreSQL with TypeORM: Good relational support, but verbose migration system and loose type safety with raw queries.
- PostgreSQL with Prisma ORM: Strong relational integrity, native `jsonb` support, fully type-safe generated TypeScript client, and automated migration management.

## Decision
We adopted **PostgreSQL 16** as the core relational database and **Prisma ORM** (`@devpulse/database`) as the schema management and database access layer.

Key design points:
- Schema defined in `packages/database/prisma/schema.prisma`.
- Fully typed client generated via `prisma generate` and shared across packages.
- Migrations managed via `prisma migrate dev` (development) and `prisma migrate deploy` (production/CI).
- Foreign key constraints with explicit referential actions (e.g. `ON DELETE CASCADE` for repository items, `ON DELETE SET NULL` for author references).
- Idempotent seeding mechanism implemented in `prisma/seed.ts`.

## Consequences
- **Positive**:
  - Full TypeScript type safety across queries and relations.
  - Predictable schema evolution through reproducible SQL migration files.
  - Native JSONB support allows storing unstructured GitHub webhook payloads alongside structured metadata.
- **Negative**:
  - Schema modifications require generating new migrations and rebuilding `@devpulse/database`.
  - Large-scale analytics aggregations may eventually require specialized SQL views or timescale extensions as data volume grows into tens of millions of records.
