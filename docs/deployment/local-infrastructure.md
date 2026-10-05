# Local Development Infrastructure Guide

This guide describes how to manage and run the local development infrastructure for **DevPulse** using Docker Compose.

---

## 🛠 Infrastructure Services

The Docker Compose configuration (`docker-compose.yml`) provisions the following services:

1. **PostgreSQL 16** (`postgres:16-alpine`)
   - **Default Port**: `5433` (configurable via `POSTGRES_PORT`)
   - **Health Check**: `pg_isready`
   - **Persistent Volume**: `postgres_data`

2. **Redis 7** (`redis:7-alpine`)
   - **Default Port**: `6379`
   - **Health Check**: `redis-cli ping`
   - **Persistent Volume**: `redis_data`

---

## 🚀 Environment Setup

1. Copy `.env.example` to create your local `.env` file:
   ```bash
   cp .env.example .env
   ```

2. Review or update variables in `.env` if necessary:
   ```env
   POSTGRES_USER=postgres
   POSTGRES_PASSWORD=postgres
   POSTGRES_DB=devpulse
   POSTGRES_PORT=5433

   REDIS_HOST=localhost
   REDIS_PORT=6379
   ```

---

## 📋 Docker Compose Commands

### Start Infrastructure
Start services in detached mode (background):
```bash
docker compose up -d
```

### Stop Infrastructure
Stop running containers without removing data:
```bash
docker compose stop
```

### Bring Down Infrastructure
Stop and remove containers and networks:
```bash
docker compose down
```

To also delete persistent data volumes:
```bash
docker compose down -v
```

### View Logs
View output logs from all services:
```bash
docker compose logs -f
```

View logs for a specific service:
```bash
docker compose logs -f postgres
# or
docker compose logs -f redis
```

### Check Container Status & Health
Check container statuses and health check statuses:
```bash
docker compose ps
```
