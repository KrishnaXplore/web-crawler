# Website Intelligence Platform

A high-scale, headless-capable web crawler and extraction engine. Built for massive concurrency, polite crawling, and autonomous self-healing data extraction.

## Architecture Sketch

The platform is split into independent services communicating via Redis and MongoDB.

- **API (`services/api`)**: The control plane. Submits crawl jobs, returns paginated results, handles webhooks.
- **Worker (`services/worker`)**: The raw HTTP engine. Pulls URLs from BullMQ, fetches HTML rapidly via Undici, runs analyzers, extracts data, and saves to MongoDB/MinIO.
- **Renderer (`services/renderer`)**: The headless browser engine (Playwright). Only runs when Javascript execution is required (SPA support, screenshots).
- **Web (`services/web`)**: The React-based operational dashboard. Submit jobs and view structured extraction results in real-time.

## The Extraction Engine

Unlike typical scrapers, this platform uses a multi-tier extraction strategy:
1. **Tier 1 (Structured)**: Extracts embedded JSON-LD, Microdata, and OpenGraph silently.
2. **Tier 2 (Rule Library)**: Executes configured CSS/XPath rules for a domain.
3. **Tier 3 (Discovery)**: Dynamically skips pagination and lists to save cost.
4. **Tier 4 (Intent Layer)**: If rules fail or don't exist, the crawler uses an LLM to generate them on the fly based on a natural language intent, and saves them back to the database.

## Quickstart

### 1. Start Infrastructure
Start the required databases (MongoDB, Redis, MinIO) via Docker Compose:
```bash
docker compose up -d
```

### 2. Install Dependencies
This is a `pnpm` workspace. Install and build the monorepo:
```bash
pnpm install
pnpm build
```

### 3. Start the Platform
You need to run the API, Worker(s), and the Dashboard. Open separate terminals:

```bash
# Terminal 1: API
cd services/api
pnpm dev

# Terminal 2: Worker (HTTP engine)
cd services/worker
pnpm dev

# Terminal 3: Renderer (Headless browser - optional but recommended)
cd services/renderer
pnpm dev

# Terminal 4: Web Dashboard
cd services/web
pnpm dev
```

### 4. Submit a Crawl
Visit `http://localhost:5173` to view the dashboard, or use curl:

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "seedUrl": "https://quotes.toscrape.com",
    "maxDepth": 2,
    "maxPages": 10,
    "intent": "extract the quote text and author"
  }'
```

## Documentation

- `docs/architecture.md`: Original HLD and structural decisions.
- `docs/architecture-v3.md`: The complete roadmap and multi-tier extraction design.
- `docs/api-spec.yaml`: OpenAPI specification for the REST API.
- `docs/runbook.md`: Operations and troubleshooting guide.
