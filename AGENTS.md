# S3B Project Notes

This file is the first place future agents should read before changing the repo.

## Project

S3B is a lightweight S3-compatible browser and control panel. It runs as a
Dockerized single-container app, stores connection profiles in the user's
browser, and uses the MinIO `mc` CLI inside the container for S3-compatible
operations.

The application language is English. Keep README text, UI labels, API errors,
and inline user-facing notes in English.

## Runtime Shape

- Backend: `app/server.py`, Python standard library HTTP server.
- Frontend: static HTML/CSS/JS in `app/static/`, no build step.
- Docker entrypoint: `python3 /app/server.py`.
- Default host port: `8088`, mapped to container port `8080`.
- Runtime settings template: `.env.example`.
- Local runtime settings file: `.env`, ignored by git.
- Runtime data: `./data` mounted to `/data` for compatibility, but profile
  credentials are not stored there.
- Profile storage: browser IndexedDB, per browser and per origin.
- `mc` config storage: temporary per request via `MC_CONFIG_DIR`; do not persist
  aliases or credentials on the server.
- Docker Compose runs the container as `${CURRENT_USER}:${CURRENT_GROUP}` from
  `.env`/`.env.example` to avoid host/container permission drift.

Secrets are stored in the browser profile database. Each API request sends the
active profile credentials to the backend so `mc` can run with a temporary alias.
Do not add server-side profile storage back without an explicit product decision.
Do not commit runtime data; keep `data/.gitkeep`.

## Core Behavior

- First screen shows browser-saved profiles and a form to create a profile.
- Profiles contain `name`, `provider`, `endpoint`, `access_key`, `secret_key`,
  `path_style`, and `insecure`.
- Selecting a profile validates it with the backend. S3 operations configure a
  temporary `mc` alias derived from the profile id for that request only.
- SeaweedFS profiles must default to `path_style=on` so endpoint-style URLs like
  `http://host:8333` work without wildcard bucket DNS.
- `mc` rejects secret keys shorter than 8 characters; keep this validation in
  place even though some SeaweedFS examples use shorter demo secrets.
- The sidebar exposes Object Browser, Buckets, Policies, MC, and Settings.
- Object Browser supports bucket selection, prefix navigation, folder creation,
  single-file and multi-file upload, download, and delete.
- Buckets view supports create, delete, and force delete.
- Policies view wraps `mc anonymous` commands for common anonymous policies and
  should stay disabled for non-MinIO providers such as SeaweedFS.
- MC view allows direct `mc` command execution. Use `{alias}` as the profile
  alias placeholder in examples and user-entered commands.

## Development Rules

- Keep the app dependency-light unless there is a clear reason to add a package.
- Prefer Python standard library and plain JS for this repo.
- Keep user-facing strings English-only.
- Keep profile persistence client-side unless the user explicitly asks for a
  shared server database.
- Keep standard S3 operations provider-neutral. Do not make object browsing,
  uploads, downloads, deletes, or bucket CRUD depend on MinIO admin behavior.
- Do not add secrets, profile files, `mc` config, or generated cache files to git.
- Do not commit `.env`; update `.env.example` for shared defaults.
- Preserve the Docker `PYTHON_IMAGE` build arg; it is useful when Docker Hub is
  unavailable or a mirror is required.
- Keep host port and container app port separate. Use `S3B_HOST_PORT` for the
  host mapping and `S3B_APP_PORT` for the container/server port.
- Preserve `CURRENT_USER` and `CURRENT_GROUP` in Compose and `.env.example`; do
  not hardcode a local machine-specific user directly in `docker-compose.yml`.
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
