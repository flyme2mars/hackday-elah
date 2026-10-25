# Sense

Local FastAPI worker for the editor. It searches the vault, pulls a frame, asks Parakeet for a transcript, and runs one tool loop. The planner tries the Gemini API, then Vertex MaaS, then local Gemma E4B. The browser never holds cloud credentials.

Default bind: `127.0.0.1:8765`. Vite proxies `/api` to that port.

## Mac

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

| Env | Default | Body |
| --- | --- | --- |
| `SENSE_MLX_EMBED_URL` | `$SENSE_MLX_URL/v1/embeddings` | `{"model":"embeddinggemma","input":"text"}` |
| `SENSE_MLX_MEDIA_EMBED_URL` | `$SENSE_MLX_URL/v1/media/embed` | `{"model":"embeddinggemma","path":"...","modality":"video"}` |
| `SENSE_MLX_TRANSCRIBE_URL` | `$SENSE_MLX_URL/v1/audio/transcriptions` | `{"model":"parakeet","path":"...","start_s":0,"end_s":1}` |
| `SENSE_E4B_URL` | `$SENSE_MLX_URL/v1/chat/completions` | OpenAI chat completions with the same tool list |

Embedding responses may be `{"data":[{"embedding":[...]}]}` or `{"embedding":[...]}`. Transcription responses may be `{"text":"..."}` or `{"transcript":"..."}`.

If those routes differ in the MLX repo, point the env vars at the real ones. A missing route is reported as the model not loaded. Search then matches names and says so. The planner does not invent timeline ops when Gemini, Vertex, and the local model are all down.

`GET /health` includes `npz_keys` and `npz_error` when a `vault_index_*.npz` file is present but the arrays are not `ids` plus `embeddings` (also accepted: `vault_ids`, `names`, `vectors`, `emb`, `X`).

## Vault

`SENSE_VAULT` defaults to `~/HackDayVault`.

- If `vault_index_*.json` exists, that file is the catalog. Each record needs an `id` or `vault_id` or `path`, and a kind or a known extension. Paths must stay inside the vault.
- Otherwise the worker scans media files and uses the path relative to the vault as the id.
- Embeddings, when the npz lines up with those ids, rank search and similar. The query vector still has to come from the MLX embed route.

When the vault folder is missing or empty, the editor shows `public/samples` (Flower, Bunny, Bed). Those ids are the filenames. They are not mixed into a non-empty vault.

## HTTP

- `GET /health`
- `GET /library`
- `POST /v1/command` with `command`, `timeline`, and `library`
- `POST /similar` with `vault_id`, `timeline`, and `library`
- `POST /search` with `query` and `library`
- `GET /media?id=` and `GET /thumb?id=` for vault files only

`apply_ops` is returned to the browser. This process has no TimelineEngine.
