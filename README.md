# DevPulse

**DevPulse** is a developer engineering intelligence platform designed to connect to GitHub, synchronize repository activity, process GitHub events asynchronously via background workers, and present actionable engineering metrics & analytics through an interactive web dashboard.

---

## 🚀 Key Features

- **GitHub Synchronization**: Integrates directly with GitHub APIs and webhooks to track commits, pull requests, issues, and workflow runs in real time.
- **Asynchronous Background Processing**: Offloads heavy event processing, metric calculations, and periodic data synchronization to a standalone worker service (`@devpulse/worker`).
- **RESTful API**: Serves aggregated metrics, organization structures, repository metadata, and analytics via `@devpulse/api`.
- **Web Dashboard**: High-performance, intuitive UI built with Next.js (`@devpulse/web`) for visualizing engineering velocity, cycle times, PR reviews, and team insights.
- **Modular Monorepo Structure**: Scalable workspace architecture managed with **Turborepo** and **pnpm workspaces**.

---

## 📁 Repository Structure

```text
DevPulse/
├── apps/
│   ├── api/            # NestJS REST API application
│   ├── web/            # Next.js web application & analytics dashboard
│   └── worker/         # Standalone background worker application
├── packages/
│   ├── config/         # Shared configuration modules
│   ├── database/       # Database schemas & ORM entities
│   ├── eslint-config/  # Shared ESLint configurations
│   ├── github/         # GitHub API client & webhook helpers
│   ├── logger/         # Shared logging utility
│   └── types/          # Core domain TypeScript types & DTOs
├── infrastructure/
│   ├── docker/         # Docker Compose & container files
│   └── scripts/        # Setup & deployment scripts
└── docs/
    ├── api/            # API documentation
    ├── architecture/   # System architecture design docs
    ├── database/       # Database schemas & ERD specs
    ├── deployment/     # Deployment guides
    ├── github/         # GitHub integration guides
    └── security/       # Security & compliance policies
```

---

## 🛠 Tech Stack

- **Monorepo Management**: [Turborepo](https://turbo.build/) & [pnpm](https://pnpm.io/)
- **Backend API**: [NestJS](https://nestjs.com/) (Node.js & TypeScript)
- **Background Worker**: NestJS Standalone Application Context
- **Frontend Dashboard**: [Next.js](https://nextjs.org/) / React
- **Language**: TypeScript

---

## 🏁 Getting Started

### Prerequisites

- **Node.js**: `>= 20.x`
- **pnpm**: `>= 9.x`

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Wajahat-Ali-Git/DevPulse.git
   cd DevPulse
   ```

2. Install dependencies across all workspace packages:
   ```bash
   pnpm install
   ```

3. Environment Setup:
   Copy `.env.example` to `.env` and update the environment variables as required:
   ```bash
   cp .env.example .env
   ```

---

## 📜 Development & Build Commands

- **Run all applications in dev mode**:
  ```bash
  pnpm dev
  ```

- **Build all workspace applications**:
  ```bash
  pnpm build
  ```

- **Run specific workspace target**:
  ```bash
  # Start API in dev mode
  pnpm --filter @devpulse/api dev

  # Start Worker application
  pnpm --filter @devpulse/worker start:prod
  ```

- **Linting & Formatting**:
  ```bash
  pnpm lint
  pnpm format
  ```

---

## 🤝 Contributing

Please see [CONTRIBUTING.md](file:///d:/My%20projects/DevPulse/CONTRIBUTING.md) for details on our code of conduct and development workflows.

---

## 📄 License

UNLICENSED — All rights reserved.