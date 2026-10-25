# AGENTS.md

Map of this repo for someone changing it cold. The product name is Frame Flow. The GitHub repo slug stays `hackday-elah`. Package paths such as `@elah/editor` stay as they are. The product brief is [plan.md](plan.md). Behavior below matches the code on `main`.

## Architecture

```
Browser (Vite + React + @elah/editor)     :43123
        │  /api  →  Vite proxy strips the prefix
        ▼
sense (FastAPI, sense/app.py)             :8765
        │
        ├─► DigitalOcean  gemma-4-31B-it         first (when DO_MODEL_KEY is set)
        ├─► Gemini API    gemma-4-26b-a4b-it     next
        ├─► Vertex AI     gemma-4-26b-a4b-it-maas fallback
        └─► local E4B     MLX HTTP               last resort
                │
                ▼
        MLX worker (not this repo)             :8787
          Gemma E4B, EmbeddingGemma, Parakeet

Vault: ~/HackDayVault   (SENSE_VAULT)
```

| Path | Role |
| --- | --- |
| `src/App.tsx`, `src/CommandBar.tsx`, `src/MediaPanel.tsx` | Host UI |
| `src/host/applyOps.ts` | Applies `ops` on `TimelineEngine` as one undo step |
| `src/host/exportMp4.ts`, `src/host/statusLine.ts` | MP4 export and status-line text |
| `src/host/place.ts`, `rotate.ts`, `orient.ts` | Place, free-angle rotate, no auto upright flip |
| `src/sense/client.ts` | `POST /api/v1/command` and `/api/similar`. The host does not call `GET /api/library` on boot. |
| `sense/planner.py` | Tool loop and planner fallbacks |
| `sense/catalog.py`, `sense/retrieve.py` | Vault index, search, similar |
| `public/samples/` | Flower, Bunny, Bed for the worker when the vault catalog is empty. The panel does not show them on boot. |

`npm run dev` is `vite --host 0.0.0.0 --port 43123 --strictPort`. `npm run sense` is uvicorn on `127.0.0.1:8765`. The proxy is in `vite.config.ts`: `/api` rewrites to the sense origin.

MLX lives in `~/code/hackday-mlx`. This repo only calls it over HTTP.

## Planner order

Do not reorder this and do not short-circuit it to local-only.

`_choose_planner` in `sense/planner.py`:

1. **DigitalOcean Inference** when `SENSE_DO` is not `0` and `DO_MODEL_KEY` is set. Model `SENSE_DO_MODEL`, default `gemma-4-31B-it`. OpenAI chat completions at `SENSE_DO_URL`, default `https://inference.do-ai.run/v1/chat/completions`. Planner id: `do`. HTTP **401 / 402 / 403 / 429 / 503** fall through.
2. **Gemini API** when `SENSE_GEMINI` is not `0` and a key is set (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, or `SENSE_GEMINI_API_KEY`). Model `GEMINI_MODEL`, default `gemma-4-26b-a4b-it`. Endpoint `generativelanguage.googleapis.com` `generateContent`. The key is a header, not a query param. Planner id: `gemini`.
3. **Vertex MaaS** when Gemini is skipped, or Gemini returns **402 / 429 / 503**. Needs Application Default Credentials and `SENSE_VERTEX` not `0`. Model `VERTEX_MODEL`, default `gemma-4-26b-a4b-it-maas`. Project `GOOGLE_CLOUD_PROJECT` (default `hackathon1-512618`), location `VERTEX_LOCATION` (default `global`). Planner id: `vertex`.
4. **Local E4B** when Vertex returns **429 / 503**, or earlier hops are skipped, and `GET {SENSE_MLX_URL}/health` answers. Chat URL `SENSE_E4B_URL`, default `http://127.0.0.1:8787/v1/chat/completions`. Planner id: `e4b`.
5. Otherwise `planner` is `"offline"` and `ops` is `[]`. The host does not invent edits. The command status line says the planner is not loaded.

Without `DO_MODEL_KEY`, the order stays Gemini → Vertex → E4B.

Busy handoff notes are already in the worker (`DigitalOcean busy; trying Gemini.`, `Gemini API busy; trying Vertex.`, `Vertex busy; using local E4B.`). Leave that copy in place.

`GET /health` reports `do_configured`, `do_model`, `gemini_configured`, `gemini_model`, `vertex_credentials`, `vertex_project`, `vertex_model`, `mlx_url`, `e4b_url`, `vault`, `vault_present`, `embeddings` (`index` / `mismatch` / `offline`), `npz_keys`, `npz_error`. It does not return API keys.

## Ops contract

`POST /v1/command` body: `command`, `timeline`, `library`, and `selected_clip_ids` when clips are selected.

Sense tools run in the worker: `search_vault`, `similar`, `get_frame`, `transcribe`, `get_timeline`, `apply_ops`.

`apply_ops` is not executed in Python. The JSON response carries `ops`, `ops_label`, `hits`, `note`, and `planner`. `src/sense/client.ts` parses that. `applyOps` (`src/host/applyOps.ts`) writes the timeline as one undo step. Times are seconds. The host converts with `Math.round(seconds * fps)` (`FPS` is 30 in `src/host/types.ts`).

Tracks: V1 and V2 video, A1 audio, T1 elements (text).

Host ops (`coerceOps` / `applyOps`): `set_stage`, `add_clip`, `add_text`, `trim`, `split`, `move`, `remove`, `set_volume`, `update_text`, `crossfade`, `set_transform`.

`clip_id` is a host alias for a clip created in the same batch. `vault_id` must already be in the library the browser sent or that search returned.

`set_transform` `rotation` is degrees clockwise. `applyOps` passes that number to `setClipRotation` in `src/host/rotate.ts`, which writes radians on `transform.rotation` inside the command's one undo step. ClipMenu uses the same helper. When the request includes `selected_clip_ids`, trim, rotate, remove, and split use those ids.

`needsUprightFlip` in `src/host/orient.ts` returns false. Do not auto-apply `scaleY = -1` on place.

Find similar is the timeline context menu, then `POST /similar` with `vault_id`. `upload/*` ids are browser blobs. The worker returns a note and does not invent cosine scores. The Media panel starts empty. Upload, search, and find-similar are how media shows up. `search_vault` still reads the disk vault. When that vault is missing or empty, the worker can still search `public/samples` (Flower `flower.mp4`, Bunny `bunny.mp4`, Bed `bed.m4a`). Those files are not copied into the panel on boot.

## Product UI

- Monochrome, minimal chrome.
- One command field under the timeline. No chat transcript.
- Media panel classified video / audio / image.
- No demo copy and no track legends.
- Status text is one short line under the field (`CommandBar`, `role="status"`). The line clears only when it is `Done`.

## Status line

- Export stays clickable when WebCodecs is missing. `exportMp4` throws, and the line shows `This browser cannot export MP4…` or `The timeline is empty.` Encoder rejections (including AAC) become `Export failed: …`, capped around 180 characters. An empty blob does not download.
- `planner: "offline"` with an empty note becomes `Planner not loaded. No edits were applied.` A note that does not already say that is prefixed the same way. Ops stay empty.
- A command that exceeds 120s says `Command timed out. The planner did not answer.` That is not reported as the worker being down.
- Fetch failures say `Sense worker is not running.`
- HTTP `detail` is shown when the body has no `note`.

## Secrets

`.do.env` and `.gemini.env` are gitignored (those files and `*.env`, with `!.env.example`). Never commit API keys, ADC JSON, vault media, or those env files. Names live in `.env.example`.

## Run

```bash
# 1. MLX on :8787, from ~/code/hackday-mlx (optional for UI-only)

# 2. sense on :8765, from this repo
python3 -m venv .venv && source .venv/bin/activate
pip install -r sense/requirements.txt
set -a && source .do.env && set +a       # DigitalOcean first
set -a && source .gemini.env && set +a   # optional Gemini
export SENSE_VAULT="$HOME/HackDayVault"
export SENSE_MLX_URL="http://127.0.0.1:8787"
export GOOGLE_CLOUD_PROJECT="hackathon1-512618"
export VERTEX_LOCATION="global"
export VERTEX_MODEL="gemma-4-26b-a4b-it-maas"
python -m uvicorn sense.app:app --host 127.0.0.1 --port 8765

# 3. Vite on :43123
npm install
npm run dev
```

Health: `curl -s http://127.0.0.1:8765/health`. Open `http://127.0.0.1:43123`.

Vertex ADC: `gcloud auth application-default login`. `SENSE_DO=0` skips DigitalOcean. `SENSE_GEMINI=0` skips Gemini. `SENSE_VERTEX=0` skips Vertex.

## Verify

```bash
npm install
npm run build
python -m unittest sense/test_local_plan.py
```

`npm run build` is `tsc -b && vite build`.

## Elsewhere

GitHub issues #1–#5 are separate slices: titles on T1, upload find-similar, a demo launcher, timeline shortcuts, and a crossfade. Leave them out of unrelated changes.

## Cursor Project + poteto

Hack Day cloud/local agents use this kit:

- Skills live under `.agents/skills/` (pstack + vercel react/design). Prefer `/poteto-mode` for rigorous edits.
- Model routing: `.cursor/rules/pstack-models.mdc` (medium budget). **Grok 4.7 non-fast only** (`grok-4.7-high`). Judgment/prose: `claude-opus-5-5-high`. Never append `-fast` to Grok.
- Custom agents: `.cursor/agents/{verifier,explorer,sense-debugger}.md`.
- User plugins (account-wide): pstack, Superpowers, React Doctor, Impeccable, Remotion, Vercel, GSAP.
- Secrets stay gitignored (`.do.env`, `.gemini.env`). Never commit Model Access Keys.
- Planner chain: DigitalOcean Gemma → Gemini API → Vertex → local E4B. Prefer edit ops over search for trim/move/rotate/cut.
- Friend Codex works from GitHub issues; wait for Akshai before filing new issues.
