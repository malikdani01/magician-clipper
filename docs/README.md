# Magician Clipper — Documentation

Start here: [../README.md](../README.md) (project overview, run commands,
honest Phase 1 status table).

## Docs in this folder

| Doc | What it covers | Status |
|---|---|---|
| [architecture.md](architecture.md) | Monorepo layout, service responsibilities, data flow Import → Style → Process → Review → Ship, auth/roles, queue, storage | Phase 1 — intended design from the spec; implementation in progress |
| [installation-windows.md](installation-windows.md) | Windows 10 setup: Node, Python, FFmpeg, PHP + Composer, clone, per-service install, run commands, troubleshooting | **Windows steps not yet verified on a Windows machine** — verified Linux equivalents only |
| [environment.md](environment.md) | Every environment variable (root / frontend / backend / engine) with defaults and required-ness | Phase 1 |
| [api.md](api.md) | Endpoint reference summarising `shared/api-contracts/api-v1.yaml` + auth, pagination, error format, job polling | Phase 1 contract — endpoints not yet verified live |

## Docs required by the spec (§17) but not yet written

These must be written from **implemented behaviour**, not speculation, so they
are deliberately pending until the phases that produce them land:

| Doc | Belongs to |
|---|---|
| `processing-pipeline.md` | Phase 3 — real pipeline (probe → transcribe → detect → render → validate) |
| `security.md` | Phase 1–2 — as auth/policies land |
| `testing.md` | Phase 3–5 — test suites and how to run them |
| `performance.md` | Phase 5 — measured benchmarks only, never estimates |
| `admin-guide.md` | Phase 2 — admin panel |
| `user-guide.md` | Phase 2 — user panel |
| `CHANGELOG.md` | Ongoing — one entry per released change |

## Source of truth

- Master spec: `~/workspace/user/files/Magician_Clipper_Complete_Master_Prompt_3_40up.md`
- API contract: `../shared/api-contracts/api-v1.yaml`
- Design tokens: `../shared/design-tokens/tokens.json`
