# Hack Day Kochi 2026 — Team Ares plan

**Repo:** [flyme2mars/hackday-elah](https://github.com/flyme2mars/hackday-elah) (MIT)  
**Local clone:** `~/code/projects/hackday-elah` on Mac (user `apple`)  
**Event:** Hack Day Kochi, Software Track, 25 Oct 2026, CITTIC CUSAT  
**Team:** Ares (Akshai Krishna S + Abhinand K)  
**Goal:** Win the overall hackathon with a Gemma 4–powered local AI video editor (not only the Gemma track).

---

## 1. What we are building

A monochrome browser video editor where a **single agent command field** (not a chat) drives vault search, find-similar, and timeline edits. Preview + elah timeline sit on the right. Media library (Video / Audio / Image) sits on the left.

Natural language like “trim this clip to 2 seconds” or “find clips like this beach shot” becomes tool calls. The planner prefers **DigitalOcean Gemma 4**, then Gemini, then Vertex, then **local Gemma E4B** on the Mac so the demo never dies on rate limits.

### Product rules (do not break)

- Monochrome, minimal chrome.
- One agent command field. No chat transcript.
- Separate media panel, classified by video / audio / image.
- Timeline right-click → Find similar.
- No demo copy, no track legends like “V1 and V2 picture · A1 sound · T1 titles”.
- No Malayalam / Kerala / personal-themed angles for the pitch. Aim for the coolest general product.
- Showcase Gemma (DigitalOcean / Gemini API / Vertex / local E4B). Do not short-circuit the planner to a hardcoded local-only path for demos.

---

## 2. Architecture

```
Browser (Vite + React + @elah/editor)     :43123
        │
        │  POST /v1/command, /similar, /search, /health
        ▼
sense (FastAPI worker)                   :8765
        │
        ├─► DigitalOcean gemma-4-31B-it         (primary when DO_MODEL_KEY is set)
        ├─► Gemini API   gemma-4-26b-a4b-it     (API key)
        ├─► Vertex AI    gemma-4-26b-a4b-it-maas (ADC)
        └─► local E4B    via MLX HTTP           (last resort)
                │
                ▼
        MLX worker (hackday-mlx)               :8787
          - Gemma E4B chat (planner tools)
          - EmbeddingGemma (search / similar)
          - Parakeet (transcription)

Vault: ~/HackDayVault  (indexed clips + embeddings on disk)
```

### Planner order

1. **DigitalOcean Inference** (`DO_MODEL_KEY`) → model `gemma-4-31B-it` at `SENSE_DO_URL` (default `https://inference.do-ai.run/v1/chat/completions`). OpenAI-compatible chat completions. Planner id: `do`. `SENSE_DO=0` skips it.
2. **Gemini API** when DigitalOcean is unset, or after DigitalOcean **401 / 402 / 403 / 429 / 503** (`GEMINI_API_KEY` / `GOOGLE_API_KEY` / `SENSE_GEMINI_API_KEY`) → model `gemma-4-26b-a4b-it`
3. On Gemini **402 / 429 / 503** → **Vertex** MaaS `gemma-4-26b-a4b-it-maas`
4. On Vertex **429 / 503** (or no ADC) → **local E4B** at `SENSE_E4B_URL` (default `http://127.0.0.1:8787/v1/chat/completions`)

Timeline edits return as `ops` and are applied in the browser via `applyOps` into elah’s `TimelineEngine` (one undo step).

### Important behaviors already in code

- Free-angle clip rotation in ClipMenu (−180…180°, slider, ±1 / ±5 / ±15). Elah `transform.rotation` is **radians**.
- Find-similar needs a vault library id. Browser-only `upload/*` blobs are not on disk; status should say so (do not fake cosine scores).
- No auto `scaleY = -1` upright flip on place (that path was wrong for real vault phone clips).
- Export: `lazyExportVideo` → `edit.mp4` (AVC + AAC, short edge 720). Needs Chromium ≥ 108.

---

## 3. Repo layout

| Path | Role |
| --- | --- |
| `src/App.tsx`, `CommandBar.tsx`, `MediaPanel.tsx` | Host UI |
| `src/host/*` | applyOps, place, rotate, orient, export, library, media |
| `src/sense/client.ts` | HTTP client to sense |
| `sense/app.py` | FastAPI routes |
| `sense/planner.py` | Gemma tool loop + fallbacks |
| `sense/catalog.py`, `retrieve.py` | Vault index + search |
| `public/samples/` | Fallback Flower / Bunny / Bed when vault empty |
| `.env.example` | Documented env vars (no secrets committed) |
| `.gemini.env` | **Local only, gitignored.** Never commit. |
| `.do.env` | **Local only, gitignored.** `DO_MODEL_KEY`. Never commit. |

Related Mac dirs **outside** this repo:

| Path | Role |
| --- | --- |
| `~/code/hackday-mlx` | MLX phase-swap server (E4B, EmbeddingGemma, Parakeet) |
| `~/HackDayVault` | Media vault + `vault_index_*.json` / `.npz` |
| `~/code/hackday-elah-editor` | Older working copy (seed source). Prefer `~/code/projects/hackday-elah` going forward. |

---

## 4. Tools and stack you need

### Runtime (MacBook Pro M2, 16 GB)

| Tool | Why |
| --- | --- |
| **Node.js + npm** | Vite frontend (`npm install`, `npm run dev` / `build`) |
| **Python 3.12+ + venv** | sense worker |
| **uvicorn + FastAPI** | sense HTTP (`pip install -r sense/requirements.txt`) |
| **uv** (optional) | Used under `~/code/hackday-mlx` for the MLX env |
| **MLX + models** | Local Gemma E4B, EmbeddingGemma, Parakeet (see mlx README / `scripts/smoke_models.py`) |
| **Chromium / Chrome** | Preview + export (Firefox can preview; export prefers Chromium) |
| **ffmpeg** (helpful) | Vault thumbs / offline checks; not required for every command path |
| **gcloud CLI** | Vertex Application Default Credentials (`gcloud auth application-default login`) |
| **gh** | GitHub CLI (repo, issues, PRs). Prefer HTTPS if SSH to github.com:22 times out |
| **Git** | This repo |

### Cloud / APIs

| Service | Use | Notes |
| --- | --- | --- |
| **DigitalOcean Inference** | First Gemma 4 planner when `DO_MODEL_KEY` is set | Serverless `gemma-4-31B-it`. Key in `.do.env`. **401 / 402 / 403 / 429 / 503** fall through. Do **not** spend real money without Akshai OK. |
| **Google AI Studio (Gemini API)** | Next Gemma 4 planner | Needs a key in `.gemini.env`. Project `hackathon1` / `hackathon1-512618`. **402 prepaid depleted** until “Set up prepay” is done. Do **not** spend real money without Akshai OK. |
| **Vertex AI MaaS** | Gemma 4 fallback | PayGo / shared capacity. **429 ≠ out of credits**; it is shared pool busy. ADC required. |
| **GCP credits** | Can cover Vertex / related cloud | Akshai has monthly GCP credits. Still ask before any new paid setup (AI Studio Prepay). |
| **GitHub** | Source of truth for Codex + cloud agent | `https://github.com/flyme2mars/hackday-elah` |

### Models (names that matter)

| Model | Where | Role |
| --- | --- | --- |
| `gemma-4-31B-it` | DigitalOcean Inference | First planner when `DO_MODEL_KEY` is set |
| `gemma-4-26b-a4b-it` | Gemini API | Next planner |
| `gemma-4-26b-a4b-it-maas` | Vertex | Planner fallback |
| `unsloth/gemma-4-E4B-it-UD-MLX-4bit` (local) | MLX :8787 | Last-resort planner |
| `mlx-community/embeddinggemma-2-8bit` | MLX | Search / similar embeddings |
| `mlx-community/parakeet-tdt-0.6b-v3` | MLX | Transcription |

### Editor dependency

- **`@elah/editor`** (^0.6) — timeline, preview, import, export primitives.
- Host owns media panel, command bar, ops mapping, rotation UI.

### Collaboration tools

| Who | Tool | How work is assigned |
| --- | --- | --- |
| **Akshai / Cutie** | Cursor **Cloud Agent** | PR on this GitHub repo for one outcome at a time |
| **Friend** | **Codex** (their account) | Picks up **GitHub Issues** on this repo |
| **Akshai Mac** | Local run + vault + MLX | Live demo machine; secrets stay here |

---

## 5. Environment variables

Copy `.env.example` patterns. Typical sense start:

```bash
cd ~/code/projects/hackday-elah
python3 -m venv .venv && source .venv/bin/activate
pip install -r sense/requirements.txt

# optional cloud planners (both files are gitignored)
set -a && source .do.env && set +a       # contains DO_MODEL_KEY
set -a && source .gemini.env && set +a   # contains GEMINI_API_KEY

export SENSE_VAULT="$HOME/HackDayVault"
export SENSE_MLX_URL="http://127.0.0.1:8787"
export GOOGLE_CLOUD_PROJECT="hackathon1-512618"
export VERTEX_LOCATION="global"
export VERTEX_MODEL="gemma-4-26b-a4b-it-maas"

python -m uvicorn sense.app:app --host 127.0.0.1 --port 8765
```

Frontend:

```bash
npm install
npm run dev    # http://127.0.0.1:43123
```

MLX (separate terminal, from `~/code/hackday-mlx`): start the phase-swap server so `:8787` answers chat, embed, and transcribe. Smoke: `scripts/smoke_models.py`.

Useful toggles:

- `SENSE_DO=0` — skip DigitalOcean Inference  
- `SENSE_GEMINI=0` — skip Gemini API  
- `SENSE_VERTEX=0` — skip Vertex  
- `GOOGLE_APPLICATION_CREDENTIALS` — if ADC is not in the default gcloud path  
- `SENSE_DO_URL` / `SENSE_DO_MODEL` — DigitalOcean chat completions endpoint and model id  

---

## 6. How to run a full local stack

1. Start **MLX** on `:8787` (`~/code/hackday-mlx`).
2. Start **sense** on `:8765` (this repo).
3. Start **Vite** on `:43123` (`npm run dev`).
4. Check `GET http://127.0.0.1:8765/health` (`do_configured`, `do_model`, `gemini_configured`, Vertex/ADC, mlx, vault, npz). The payload never includes API keys.
5. Open `http://127.0.0.1:43123`. Place vault clips, try a command, try Find similar, try Export.

---

## 7. Known constraints (day-of)

- **DigitalOcean 401 / 402 / 429 / 503:** Auth, billing, or capacity. Fall through to Gemini, then Vertex, then E4B. Ask Akshai before any new charge.
- **Gemini API 402:** AI Studio project still needs “Set up prepay”. Postpay alone does not fund `generateContent`. GCP credit ≠ AI Studio Prepay wallet until Prepay is set up. Ask Akshai before any charge.
- **Vertex 429:** Shared MaaS capacity, not empty billing. Fall through to E4B is expected.
- **Upload find-similar:** `upload/*` is blob-only; EmbeddingGemma path needs vault / disk ids.
- **SSH to GitHub:** port 22 may time out on this Mac; use HTTPS + `gh auth git-credential`.
- **Spend rule:** no new card charge, paid plan, wallet top-up, or Prepay without Akshai OK.

---

## 8. Work split: Cloud Agent vs Codex

Parallel tracks. Do not collide on the same files without coordinating on the issue / PR.

### A. Cursor Cloud Agent (our side)

Focus: judge-facing polish, architecture docs in-repo, export/command reliability, AGENTS.md for collaborators.

Suggested outcomes (one PR per launch):

1. Judge README + architecture section + clear runbook (keep monochrome product rules).
2. `AGENTS.md` describing sense planner order, ops contract, and “do not invent edits when no planner”.
3. Export / status-line hardening for live demo failures.
4. Any build or typecheck breaks after seed.

Launch with model **Grok 4.7**, `model_params: {"fast":"false"}`, repo `https://github.com/flyme2mars/hackday-elah`.

### B. Codex (friend, via GitHub Issues)

Focus: feature slices that wow in the live demo without rewriting the planner core.

Suggested issues (file as separate GitHub issues; friend claims one at a time):

1. **Title / caption ops on T1** — agent can add or edit text overlays from the command field.
2. **Find-similar for browser uploads** — grab a frame, embed via MLX, search vault (or clear UX when impossible).
3. **One-shot Mac demo launcher** — script that starts mlx + sense + vite and prints health.
4. **Keyboard shortcuts** for timeline speed (play, split-friendly navigation) during the live demo.
5. **Crossfade / simple transition** between two video clips (keep monochrome; no chrome clutter).

Issue template for Codex should include: GOAL, SCOPE (paths), ACCEPTANCE, FORBIDDEN (no secrets, no planner short-circuit, no demo legend copy), and VERIFY (`npm run build`, relevant sense tests).

---

## 9. Demo acceptance (win bar)

- [ ] Three processes up: MLX, sense, Vite.
- [ ] Health shows planner path (DigitalOcean and/or Gemini and/or Vertex and/or E4B) without inventing ops when all are down.
- [ ] Command field: search vault + apply at least trim / place / remove style edits.
- [ ] Find similar works on vault clips.
- [ ] Free-angle rotate works from ClipMenu.
- [ ] Export produces a playable `edit.mp4` (or a clear encoder error).
- [ ] Pitch: local-first Gemma 4 editor, cloud Gemma when available, local E4B always as safety net.
- [ ] UI stays monochrome and legend-free.

---

## 10. Day-of contacts and repos

- GitHub: https://github.com/flyme2mars/hackday-elah  
- GCP / AI Studio project id: `hackathon1-512618`  
- Older Origin experiment (reference only): `flyme2mars/hackday-elah-editor`  
- This file is the shared brief for Cloud Agent launches and Codex issues. Update it when the split or stack changes.

