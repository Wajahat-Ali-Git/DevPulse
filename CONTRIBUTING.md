# Contributing to DevPulse

Thank you for contributing to DevPulse!

## Getting Started

1. Read the [System Architecture Overview](docs/architecture/overview.md) to understand the platform design and monorepo structure.
2. Follow the [Local Development Setup Guide](docs/development/setup.md) to install dependencies, boot up Docker services, run database migrations, and launch applications.
3. Review our [Architecture Decision Records (ADRs)](docs/architecture/decisions/README.md) before proposing significant architectural modifications.

## Development Workflow

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feature/my-feature-name
   ```
2. Verify code standards and formatting:
   ```bash
   pnpm lint
   pnpm format
   ```
3. Run tests across affected packages:
   ```bash
   pnpm --filter @devpulse/api test
   pnpm --filter @devpulse/github test
   ```
4. Commit your changes following conventional commits format (e.g., `feat(api): add new metric endpoint`, `docs: update setup guide`).
5. Open a Pull Request targeting `main`.
