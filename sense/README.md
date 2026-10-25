# Sense

Local FastAPI worker for the editor. It searches the vault, pulls a frame, asks Parakeet for a transcript, and runs one tool loop against DigitalOcean, Gemini, Vertex, or a local Gemma. The browser never holds cloud credentials.

Default bind: `127.0.0.1:8765`. Vite proxies `/api` to that port.

## Mac

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r sense/requirements.txt

# Optional DigitalOcean first, then Gemini. Both env files are gitignored.
set -a && source .do.env && set +a
set -a && source .gemini.env && set +a

export SENSE_VAULT="$HOME/HackDayVault"
export SENSE_MLX_URL="http://127.0.0.1:8787"
export GOOGLE_CLOUD_PROJECT="hackathon1-512618"
export VERTEX_LOCATION="global"
export VERTEX_MODEL="gemma-4-26b-a4b-it-maas"

python -m uvicorn sense.app:app --host 127.0.0.1 --port 8765
```

In a second terminal, from the same repo:

```bash
npm install
npm run dev
```

The editor is [http://127.0.0.1:43123](http://127.0.0.1:43123).

Vertex uses Application Default Credentials. On the Mac:

```bash
gcloud auth application-default login
```

The credential file is `~/.config/gcloud/application_default_credentials.json`. If you keep it somewhere else, set `GOOGLE_APPLICATION_CREDENTIALS` to that file. Restart the worker after login. `SENSE_GEMINI=0` skips the Gemini API. `SENSE_VERTEX=0` skips Vertex.

## Models

The worker does not load EmbeddingGemma, Parakeet, or Gemma E4B itself. It calls `~/code/hackday-mlx` over HTTP, one request at a time, so that worker can phase-swap a single model.

Planner order when each hop is configured: DigitalOcean Inference (`DO_MODEL_KEY`, model `SENSE_DO_MODEL`, default `gemma-4-31B-it`) → Gemini API → Vertex MaaS → local E4B. DigitalOcean uses OpenAI chat completions at `SENSE_DO_URL` (default `https://inference.do-ai.run/v1/chat/completions`) with the same tool list. `SENSE_DO=0` skips it. HTTP 401, 402, 403, 429, and 503 fall through. `GET /health` includes `do_configured` and `do_model` and never returns the key. Put `DO_MODEL_KEY` in gitignored `.do.env`.

| Env | Default | Body |
| --- | --- | --- |
| `SENSE_MLX_EMBED_URL` | `$SENSE_MLX_URL/v1/embeddings` | `{"model":"embeddinggemma","input":"text"}` |
| `SENSE_MLX_MEDIA_EMBED_URL` | `$SENSE_MLX_URL/v1/media/embed` | `{"model":"embeddinggemma","path":"...","modality":"video"}` |
| `SENSE_MLX_TRANSCRIBE_URL` | `$SENSE_MLX_URL/v1/audio/transcriptions` | `{"model":"parakeet","path":"...","start_s":0,"end_s":1}` |
| `SENSE_E4B_URL` | `$SENSE_MLX_URL/v1/chat/completions` | OpenAI chat completions with the same tool list |

Embedding responses may be `{"data":[{"embedding":[...]}]}` or `{"embedding":[...]}`. Transcription responses may be `{"text":"..."}` or `{"transcript":"..."}`.

If those routes differ in the MLX repo, point the env vars at the real ones. A missing route is reported as the model not loaded. Search then matches names and says so. The planner does not invent timeline ops when DigitalOcean, Gemini, Vertex, and the local model are all down.

`GET /health` includes `npz_keys` and `npz_error` when a `vault_index_*.npz` file is present but the arrays are not `ids` plus `embeddings` (also accepted: `vault_ids`, `names`, `vectors`, `emb`, `X`).

## Vault

`SENSE_VAULT` defaults to `~/HackDayVault`.

- If `vault_index_*.json` exists, that file is the catalog. Each record needs an `id` or `vault_id` or `path`, and a kind or a known extension. Paths must stay inside the vault.
- Otherwise the worker scans media files and uses the path relative to the vault as the id.
- Embeddings, when the npz lines up with those ids, rank search and similar. The query vector still has to come from the MLX embed route. Search also ranks npz ids that the JSON catalog left out. A `modality` array value of `still` is image. When the query does not name a kind, video, audio, and image each keep their own top hits. Hits below `SENSE_MIN_SCORE` (default 0.50) are omitted. `GET /library` still stops at 300 items.

When the vault folder is missing or empty, search can still return `public/samples` (Flower, Bunny, Bed). Those ids are the filenames. They are not mixed into a non-empty vault. The Media panel does not list them on boot.

## HTTP

- `GET /health`
- `GET /library`
- `POST /v1/command` with `command`, `timeline`, and `library`
- `POST /similar` with `vault_id`, `timeline`, and `library`
- `POST /search` with `query` and `library`
- `POST /v1/dictation` with the raw audio bytes (`audio/webm`, `audio/wav`, `audio/ogg`, or `audio/mp4`) and `Content-Type` set to that type. The response is `{"text":"..."}`. The worker writes a temp file, converts it to 16 kHz mono wav when ffmpeg is present, and posts `{"model":"parakeet","path":"..."}` to `SENSE_MLX_TRANSCRIBE_URL`. This is local Parakeet only. `503` means Parakeet is not loaded.
- `GET /media?id=` and `GET /thumb?id=` for vault files only

`apply_ops` is returned to the browser. This process has no TimelineEngine.
