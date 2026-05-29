# S3B Project Notes

This file is the first place future agents should read before changing the repo.

## Project

S3B is a lightweight S3/MinIO browser and control panel. It runs as a Dockerized
single-container app, stores connection profiles locally, and uses the MinIO
`mc` CLI inside the container for S3/MinIO operations.

The application language is English. Keep README text, UI labels, API errors,
and inline user-facing notes in English.

## Runtime Shape

- Backend: `app/server.py`, Python standard library HTTP server.
- Frontend: static HTML/CSS/JS in `app/static/`, no build step.
- Docker entrypoint: `python3 /app/server.py`.
- Default host port: `8088`, mapped to container port `8080`.
- Runtime data: `./data` mounted to `/data`.
- Profile storage: `/data/profiles.json`.
- `mc` config storage: `/data/mc`.

Secrets are stored in `./data/profiles.json` as plain text. Do not commit runtime
data. `data/profiles.json` is intentionally ignored; keep `data/.gitkeep`.

## Core Behavior

- First screen shows saved profiles and a form to create a profile.
- Profiles contain `name`, `endpoint`, `access_key`, `secret_key`, and
  `insecure`.
- Selecting a profile configures an `mc` alias derived from the profile id.
- The sidebar exposes Object Browser, Buckets, Policies, MC, and Settings.
- Object Browser supports bucket selection, prefix navigation, upload, download,
  and delete.
- Buckets view supports create, delete, and force delete.
- Policies view wraps `mc anonymous` commands for common anonymous policies.
- MC view allows direct `mc` command execution. Use `{alias}` as the profile
  alias placeholder in examples and user-entered commands.

## Development Rules

- Keep the app dependency-light unless there is a clear reason to add a package.
- Prefer Python standard library and plain JS for this repo.
- Keep user-facing strings English-only.
- Do not add secrets, profile files, `mc` config, or generated cache files to git.
- Preserve the Docker `PYTHON_IMAGE` build arg; it is useful when Docker Hub is
  unavailable or a mirror is required.
- Keep `.dockerignore` aligned with `.gitignore` so runtime data does not enter
  the image build context.

## Useful Commands

```bash
python3 -m py_compile app/server.py
node --check app/static/app.js
docker compose config
docker compose up --build
curl -fsS http://127.0.0.1:8088/api/health
```

When Docker Hub is unavailable, use a local or mirrored Python image:

```bash
PYTHON_IMAGE=your-registry/python:3.12-alpine docker compose up --build
```

Expected health response after startup:

```json
{"ok": true, "mc": true}
```
