# Database Schema & Entity Relationships

This document outlines the relational database architecture designed for DevPulse's GitHub integration and developer activity tracking.

## Overview

The database is built on **PostgreSQL** and managed using **Prisma ORM** (`packages/database`). It captures multi-tenant workspace structures alongside GitHub accounts, repositories, commits, pull requests, code reviews, and raw webhook/activity events.

---

## Entity Relationship Diagram (ERD)

```mermaid
erDiagram
    users ||--o{ workspace_members : "belongs to"
    workspaces ||--o{ workspace_members : "contains"
    users ||--o{ github_accounts : "links"
    workspaces ||--o{ repositories : "manages"
    
    repositories ||--o{ commits : "tracks"
    users ||--o{ commits : "authored (optional)"
    
    repositories ||--o{ pull_requests : "tracks"
    users ||--o{ pull_requests : "authored (optional)"
    
    pull_requests ||--o{ reviews : "has"
    users ||--o{ reviews : "authored (optional)"
    
    repositories ||--o{ activity_events : "logged under"
    users ||--o{ activity_events : "triggered by (optional)"

    users {
        string id PK
        string email UK
        string name
        enum role
        string avatar_url
        datetime created_at
        datetime updated_at
    }

    workspaces {
        string id PK
        string name
        string slug UK
        datetime created_at
        datetime updated_at
    }

    workspace_members {
        string id PK
        string workspace_id FK
        string user_id FK
        enum role
        datetime created_at
    }

    github_accounts {
        string id PK
        string user_id FK
        bigint github_user_id UK
        string username
        string display_name
        string email
        string avatar_url
        string profile_url
        string access_token
        string refresh_token
        datetime token_expires_at
        string_array scopes
        datetime created_at
        datetime updated_at
    }

    repositories {
        string id PK
        string workspace_id FK
        string name
        string full_name
        bigint github_id UK
        string description
        string url
        string default_branch
        boolean is_private
        boolean is_fork
        enum status
        datetime pushed_at
        datetime created_at
        datetime updated_at
    }

    commits {
        string id PK
        string repository_id FK
        string sha
        string message
        string author_name
        string author_email
        datetime author_date
        string committer_name
        string committer_email
        datetime committer_date
        string author_user_id FK
        string url
        int additions
        int deletions
        int total_changes
        datetime created_at
        datetime updated_at
    }

    pull_requests {
        string id PK
        string repository_id FK
        bigint github_id UK
        int number
        string title
        string body
        enum state
        string author_username
        string author_user_id FK
        string source_branch
        string target_branch
        boolean is_draft
        boolean is_merged
        string url
        int additions
        int deletions
        int changed_files
        datetime merged_at
        datetime closed_at
        datetime github_created_at
        datetime github_updated_at
        datetime created_at
        datetime updated_at
    }

    reviews {
        string id PK
        string pull_request_id FK
        bigint github_id UK
        string author_username
        string author_user_id FK
        enum state
        string body
        string commit_sha
        string url
        datetime submitted_at
        datetime created_at
        datetime updated_at
    }

    activity_events {
        string id PK
        string repository_id FK
        string user_id FK
        string github_delivery UK
        enum event_type
        string action
        string actor_username
        jsonb payload
        datetime occurred_at
        datetime created_at
    }
```

---

## Detailed Table Specifications

### 1. `users`
Represents application users (developers, team leads, administrators).
- **Primary Key**: `id` (UUID)
- **Unique Constraints**: `email`
- **Enums**: `UserRole` (`ADMIN`, `MEMBER`, `VIEWER`)
- **Relations**:
  - `memberships`: One-to-many with `workspace_members` (on delete cascade)
  - `githubAccounts`: One-to-many with `github_accounts` (on delete cascade)
  - `authoredCommits`: One-to-many with `commits` (on delete set null)
  - `pullRequests`: One-to-many with `pull_requests` (on delete set null)
  - `reviews`: One-to-many with `reviews` (on delete set null)
  - `activityEvents`: One-to-many with `activity_events` (on delete set null)

### 2. `github_accounts`
OAuth-linked GitHub user profiles for authentication and API tokens.
- **Primary Key**: `id` (UUID)
- **Unique Constraints**: `github_user_id` (BigInt)
- **Foreign Keys**: `user_id` -> `users(id)` (ON DELETE CASCADE)
- **Indexes**:
  - `github_accounts_user_id_idx` (`user_id`)
  - `github_accounts_username_idx` (`username`)

### 3. `repositories`
GitHub repositories tracked under a workspace.
- **Primary Key**: `id` (UUID)
- **Unique Constraints**: `github_id` (BigInt)
- **Foreign Keys**: `workspace_id` -> `workspaces(id)` (ON DELETE CASCADE)
- **Enums**: `RepositoryStatus` (`ACTIVE`, `INACTIVE`, `ARCHIVED`)
- **Indexes**:
  - `repositories_workspace_id_idx` (`workspace_id`)
  - `repositories_full_name_idx` (`full_name`)
  - `repositories_status_idx` (`status`)

### 4. `commits`
Git commits synced from tracked repositories.
- **Primary Key**: `id` (UUID)
- **Unique Constraints**: `[repository_id, sha]`
- **Foreign Keys**:
  - `repository_id` -> `repositories(id)` (ON DELETE CASCADE)
  - `author_user_id` -> `users(id)` (ON DELETE SET NULL)
- **Indexes**:
  - `commits_repository_id_idx` (`repository_id`)
  - `commits_author_user_id_idx` (`author_user_id`)
  - `commits_author_email_idx` (`author_email`)
  - `commits_author_date_idx` (`author_date`)
  - `commits_sha_idx` (`sha`)

### 5. `pull_requests`
Pull requests synced from tracked repositories.
- **Primary Key**: `id` (UUID)
- **Unique Constraints**: `github_id` (BigInt), `[repository_id, number]`
- **Foreign Keys**:
  - `repository_id` -> `repositories(id)` (ON DELETE CASCADE)
  - `author_user_id` -> `users(id)` (ON DELETE SET NULL)
- **Enums**: `PullRequestState` (`OPEN`, `CLOSED`, `MERGED`)
- **Indexes**:
  - `pull_requests_repository_id_idx` (`repository_id`)
  - `pull_requests_author_user_id_idx` (`author_user_id`)
  - `pull_requests_state_idx` (`state`)
  - `pull_requests_author_username_idx` (`author_username`)
  - `pull_requests_created_at_idx` (`created_at`)

### 6. `reviews`
Code reviews submitted on pull requests.
- **Primary Key**: `id` (UUID)
- **Unique Constraints**: `github_id` (BigInt)
- **Foreign Keys**:
  - `pull_request_id` -> `pull_requests(id)` (ON DELETE CASCADE)
  - `author_user_id` -> `users(id)` (ON DELETE SET NULL)
- **Enums**: `ReviewState` (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`)
- **Indexes**:
  - `reviews_pull_request_id_idx` (`pull_request_id`)
  - `reviews_author_user_id_idx` (`author_user_id`)
  - `reviews_state_idx` (`state`)
  - `reviews_author_username_idx` (`author_username`)
  - `reviews_submitted_at_idx` (`submitted_at`)

### 7. `activity_events`
Audit log and event stream of GitHub webhooks and developer activities.
- **Primary Key**: `id` (UUID)
- **Unique Constraints**: `github_delivery` (unique webhook delivery GUID for idempotency)
- **Foreign Keys**:
  - `repository_id` -> `repositories(id)` (ON DELETE CASCADE, nullable)
  - `user_id` -> `users(id)` (ON DELETE SET NULL, nullable)
- **Enums**: `ActivityEventType` (`PUSH`, `PULL_REQUEST_OPENED`, `PULL_REQUEST_CLOSED`, `PULL_REQUEST_MERGED`, `PULL_REQUEST_REOPENED`, `PULL_REQUEST_REVIEW`, `ISSUE_OPENED`, `ISSUE_CLOSED`, `RELEASE_PUBLISHED`, `OTHER`)
- **Indexes**:
  - `activity_events_repository_id_idx` (`repository_id`)
  - `activity_events_user_id_idx` (`user_id`)
  - `activity_events_event_type_idx` (`event_type`)
  - `activity_events_actor_username_idx` (`actor_username`)
  - `activity_events_occurred_at_idx` (`occurred_at`)

---

## Database Setup & Workflow

### 1. Connection Configuration
In local development, the PostgreSQL container maps container port `5432` to host port `5433` (as defined in `docker-compose.yml` and `.env.example`).

The connection string format:
```env
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=devpulse
POSTGRES_PORT=5433
DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}
```

### 2. Migrations
The initial schema migration is located at:
`packages/database/prisma/migrations/20261020115431_init_github_activity_schema/migration.sql`

To apply pending migrations in development:
```bash
# Using root command
pnpm db:migrate:dev

# Or package filter
pnpm --filter @devpulse/database db:migrate:dev
```

To apply migrations in production or CI/CD pipelines:
```bash
# Using root command
pnpm db:migrate:deploy

# Or package filter
pnpm --filter @devpulse/database db:migrate:deploy
```

### 3. Database Seeding
An initial idempotent seed script is provided at `packages/database/prisma/seed.ts`. It provisions:
- **Default Admin User**: `admin@devpulse.local` (`UserRole.ADMIN`)
- **Default Workspace**: `DevPulse Organization` (`slug: devpulse-org`)
- **Default Tracked Repository**: `DevPulse/DevPulse` (`status: ACTIVE`)

Run the seeder with:
```bash
# Using root command
pnpm db:seed

# Or package filter
pnpm --filter @devpulse/database db:seed
```

### 4. Prisma Studio (Visual GUI)
To launch Prisma's visual data browser and inspect database records in your web browser:
```bash
# Using root command
pnpm db:studio

# Or package filter
pnpm --filter @devpulse/database db:studio
```
Prisma Studio opens by default at `http://localhost:5555`.

---

## Database Command Reference

All database commands can be executed either from the monorepo root or directly targeted at `@devpulse/database`:

| Action | Root Command | Filter Command | Description |
|---|---|---|---|
| **Generate Client** | `pnpm db:generate` | `pnpm --filter @devpulse/database prisma:generate` | Generates the `@prisma/client` types from `schema.prisma`. |
| **Apply Dev Migrations** | `pnpm db:migrate:dev` | `pnpm --filter @devpulse/database db:migrate:dev` | Creates and applies new migrations in dev mode. |
| **Deploy Migrations** | `pnpm db:migrate:deploy` | `pnpm --filter @devpulse/database db:migrate:deploy` | Applies unapplied migrations in CI/CD or production. |
| **Push Schema** | `pnpm db:push` | `pnpm --filter @devpulse/database db:push` | Pushes the schema state directly to DB without creating a migration file. |
| **Seed Database** | `pnpm db:seed` | `pnpm --filter @devpulse/database db:seed` | Executes `prisma/seed.ts` with demo/seed records. |
| **Prisma Studio** | `pnpm db:studio` | `pnpm --filter @devpulse/database db:studio` | Starts the Prisma Studio web interface on port 5555. |

