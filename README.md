# Editor

A monochrome browser video editor. The media library sits on the left. Preview and the elah timeline sit on the right, with one command field under the timeline. There is no chat transcript.

Search, similar, frame grabs, and transcripts run in the sense worker. The planner tries Gemini API Gemma, then Vertex MaaS, then local Gemma E4B. Timeline edits come back as `ops`. The host applies them with `applyOps` into `TimelineEngine`. See [AGENTS.md](AGENTS.md) for the contract.

## Run

Three processes. Ports are fixed.

1. **MLX** on `:8787`, from `~/code/hackday-mlx` (not this repo). It serves Gemma E4B, EmbeddingGemma, and Parakeet, one model at a time. Smoke: `scripts/smoke_models.py` in that repo. The UI still opens if this process is down. Search then matches names, and the planner skips E4B.

2. **sense** on `:8765`, from this repo:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r sense/requirements.txt

# Optional Gemini primary. .gemini.env is gitignored.
set -a && source .gemini.env && set +a

export SENSE_VAULT="$HOME/HackDayVault"
export SENSE_MLX_URL="http://127.0.0.1:8787"
export GOOGLE_CLOUD_PROJECT="hackathon1-512618"
export VERTEX_LOCATION="global"
export VERTEX_MODEL="gemma-4-26b-a4b-it-maas"

python -m uvicorn sense.app:app --host 127.0.0.1 --port 8765
```

`npm run sense` starts the same worker when `python3` already has the requirements installed.

3. **Vite** on `:43123`:

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:43123](http://127.0.0.1:43123). Vite proxies `/api` to `127.0.0.1:8765`.

Health check, once sense is up:

```bash
curl -s http://127.0.0.1:8765/health
```

Read `gemini_configured` (the key is not returned), `vertex_credentials`, `mlx_url`, `e4b_url`, `vault`, `vault_present`, `embeddings`, `npz_keys`, and `npz_error`.

Vertex needs Application Default Credentials on the machine that runs the worker:

```bash
gcloud auth application-default login
```

That writes `~/.config/gcloud/application_default_credentials.json`. Point `GOOGLE_APPLICATION_CREDENTIALS` at the file if it lives somewhere else. Restart the worker after login.

DigitalOcean Inference is the first planner when `DO_MODEL_KEY` is set. It calls serverless Gemma 4 (`gemma-4-31B-it` by default) with OpenAI-compatible chat completions at `SENSE_DO_URL` (default `https://inference.do-ai.run/v1/chat/completions`). Keep the key in gitignored `.do.env`. `SENSE_DO=0` skips it. HTTP 401, 402, 403, 429, and 503 fall through to Gemini, then Vertex, then local E4B. `GET /health` reports `do_configured` and `do_model` and does not echo the key. The command result names this planner `do`.

`SENSE_GEMINI=0` skips the Gemini API. `SENSE_VERTEX=0` skips Vertex. Local E4B is `SENSE_E4B_URL` (default `http://127.0.0.1:8787/v1/chat/completions`). Tool schemas match the Gemini and Vertex declarations. See [sense/README.md](sense/README.md) for the MLX routes, vault index files, and phase-swap notes. Variable names are in [.env.example](.env.example).

## Verify

```bash
npm install
npm run build
python -m unittest sense/test_local_plan.py
```

`npm run build` is `tsc -b && vite build`.

## What a command does

The field sends the text, the current timeline, and the visible library to `POST /v1/command`. The worker may call `search_vault`, `similar`, `get_frame`, `transcribe`, `get_timeline`, and `apply_ops`.

Sense tools run in the worker. `apply_ops` comes back to the browser and is applied as one undo step. The media panel refills with classified hits. A status line reports search or edit, then clears when the line is "Done". Planner-offline, timeout, and export failures stay on that line.

Right-click a clip and choose Find similar. That calls `POST /similar` with the clip's library id. Clips that were not placed from the library have no id.

Drag a hit onto a compatible track, or click it to place it at the playhead. Video tries V1, then V2. Audio goes to A1. Images use elah's media drop on a picture track.

Export writes `edit.mp4` (AVC + AAC, short edge 720) through `lazyExportVideo`. Chromium 108 or newer is required. Firefox can preview. The Export button stays enabled. A missing encoder, an empty timeline, an empty file, or an encoder rejection (including headless Chromium refusing AAC at 128 kbps, 44.1 kHz, stereo) shows on the status line as a short `Export failed: …` message, or the browser requirement when WebCodecs is missing. That line is not cleared.

`?debug=1` prints the timeline JSON. It is off unless you ask.

## Library ids

The worker does not invent ids.

- A `vault_index_*.json` under `~/HackDayVault` supplies ids, or a scan uses the file path relative to the vault.
- `vault_index_*.npz` is used only when it has an id array and an embedding matrix that line up. `GET /health` reports `npz_keys` and `npz_error`.
- Query embeddings and Parakeet come from the MLX worker. If that worker is down, search matches names and the status line says embeddings are offline. Cosine scores are not faked.
- If DigitalOcean, Gemini, Vertex, and local E4B are all unavailable, `planner` is `offline`, `ops` stays empty, and the status line says the planner is not loaded. No edit ops are synthesized.
- If the vault is missing or empty, the panel shows three files from `public/samples` as ordinary library items: Flower (`flower.mp4`), Bunny (`bunny.mp4`), Bed (`bed.m4a`). They are not added when the vault has its own catalog.

Sample sources:

| File | Source |
| --- | --- |
| `public/samples/flower.mp4` | [MDN CC0 flower](https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4), center-cropped to 9:16 |
| `public/samples/bunny.mp4` | [Big Buck Bunny trailer](https://www.w3schools.com/html/mov_bbb.mp4), Blender Foundation, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| `public/samples/bed.m4a` | Audio from `bunny.mp4` |

## Ops

Seconds in, frames at the edge: `Math.round(seconds * fps)`. Track names are V1, V2, A1, and T1.

| Op | Engine call |
| --- | --- |
| `set_stage` | `setStage(width, height)` |
| `add_clip` | `importUrl`, then `addClip` for video or audio |
| `add_text` | `addClip({ type: 'text' })` on T1 |
| `trim` | `trimClip` |
| `split` | `splitClip` (`at_s` is a timeline time) |
| `move` | `moveClip` |
| `remove` | `removeClip` |
| `set_volume` | `updateClip({ volume })`, clip gain 0 to 1 |
| `update_text` | flat `content`, `fontSize`, `color` |

`clip_id` is a host alias so later ops can name a clip created in the same batch. `vault_id` must already be on the timeline or returned by search or similar. The planner may also emit `set_transform` with `rotation` in degrees. The host rejects that op, and the status line says to rotate from the clip menu. Elah stores `transform.rotation` in radians.

## Elah notes

`@elah/editor` 0.6.0, Apache-2.0. This repo does not fork it.

- `addClip` has no source in-point. The host sets `sourceStartFrame` and `sourceDurationFrames` with `updateClip` inside the same batch.
- `trimClip`, `splitClip`, `moveClip`, and `removeClip` can return without throwing. The host checks the project and throws, which rolls the batch back.
- Text style is nested only when creating a clip. Stored clips and `updateClip` use flat fields.
- `lazyExportVideo` has no `fps` and no `demuxerFactory`. Progress is `{ frame, totalFrames }`.
- Vite needs `worker.format: 'es'` and `optimizeDeps.exclude` for the export worker. Stylesheets load in `src/main.tsx`. The shell uses `.elah-root`.

## Mac model loads

This tree can run the UI and the worker without the models. These still have to be started on the Mac, and this environment cannot load them:

- `~/code/hackday-mlx` must serve EmbeddingGemma, Parakeet, and Gemma E4B, phase-swapping one model at a time. Confirm the HTTP paths or set `SENSE_MLX_EMBED_URL`, `SENSE_MLX_MEDIA_EMBED_URL`, `SENSE_MLX_TRANSCRIBE_URL`, and `SENSE_E4B_URL`.
- `~/HackDayVault` must contain the real media and, if you built one, `vault_index_*.json` and `vault_index_*.npz`. If `/health` shows `embeddings: mismatch`, the npz keys are not the ones listed in `sense/README.md`.
- `.gemini.env` (gitignored) may set `GEMINI_API_KEY` for the primary planner. `GET /health` reports `gemini_configured` and does not echo the key.
- `gcloud auth application-default login` for project `hackathon1-512618` before Vertex `gemma-4-26b-a4b-it-maas` will answer. Location is `global`.
- MP4 export needs desktop Chromium. A headless encoder may reject AAC.
