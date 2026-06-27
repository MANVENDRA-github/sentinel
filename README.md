# Sentinel

A self-hostable **verifying LLM gateway** — a drop-in, OpenAI-compatible proxy that **routes** (cheapest capable model + fallback), **semantically caches**, and **verifies** (deterministic guardrails inline + a local Ollama judge) every LLM call, with full OpenTelemetry tracing. Unlike after-the-fact observability tools, it can flag or block a bad response _before it returns_.

> 🚧 **Early development.** Product spec in [`PRP_SPEC.md`](./PRP_SPEC.md), phased build in [`ROADMAP.md`](./ROADMAP.md), contributor/agent guidance in [`CLAUDE.md`](./CLAUDE.md). Currently at **Phase 0 — foundation**.

## Development

Requires **Node ≥ 22** and **pnpm**. Optional: **Docker** for the Redis/Ollama stack, or a native [Ollama](https://ollama.com) install.

```bash
pnpm install        # install dependencies
pnpm verify         # typecheck + lint + test with coverage (the pre-PR gate)
pnpm test:watch     # tests in watch mode

# Local infra (needs Docker; skip `ollama` here if you run it natively):
docker compose up -d
pnpm ollama:pull    # pull the judge + embedding models via Ollama
```

See [`CLAUDE.md`](./CLAUDE.md) for the full command list, coding standards, and workflow.
