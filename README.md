# S3B

Lightweight S3-compatible browser and control panel with saved profiles and built-in `mc` execution.

## Run

```bash
docker compose up --build
```

Create a local `.env` from the committed template before changing runtime settings:

```bash
cp .env.example .env
```

Docker Compose reads `.env` automatically. Keep `.env` local; commit changes to
`.env.example` when defaults should be shared.

Set `CURRENT_USER` and `CURRENT_GROUP` in `.env` to your host numeric UID/GID so
files under `./data` stay editable from both the host and the container.

After startup:

```text
http://localhost:8088
```

Profiles and `mc` settings are stored in `./data`. Secret keys are stored as plain text in that directory, so do not commit it.

If the default Docker registry is unavailable, override the base image:

```bash
PYTHON_IMAGE=your-registry/python:3.12-alpine docker compose up --build
```

## Features

- Create and select profiles with provider, `endpoint`, `access key`, and `secret key`
- SeaweedFS profile preset with path-style S3 lookup
- Persist profiles for later sessions
- Browse buckets and objects
- Upload, download, and delete objects
- Create and delete buckets
- Configure MinIO anonymous bucket policies when using a MinIO profile
- Run direct `mc` commands with the `{alias}` placeholder

## SeaweedFS

For a SeaweedFS S3 endpoint, create a profile with:

- Provider: `SeaweedFS`
- Endpoint: `http://SERVER_IP:8333`
- Access Key: the `AWS_ACCESS_KEY_ID` configured for SeaweedFS
- Secret Key: the `AWS_SECRET_ACCESS_KEY` configured for SeaweedFS; use at
  least 8 characters because `mc` rejects shorter secrets
- S3 Path Lookup: `Path-style`

Object browsing, bucket creation/deletion, upload, download, and object deletion
use standard S3-compatible `mc` commands. The Policies tab is intentionally
disabled for SeaweedFS profiles because it wraps MinIO-specific anonymous policy
commands.
