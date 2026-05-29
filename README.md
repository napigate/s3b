# S3B

Lightweight S3/MinIO browser and control panel with saved profiles and built-in `mc` execution.

## Run

```bash
docker compose up --build
```

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

- Create and select profiles with `endpoint`, `access key`, and `secret key`
- Persist profiles for later sessions
- Browse buckets and objects
- Upload, download, and delete objects
- Create and delete buckets
- Configure anonymous bucket policies
- Run direct `mc` commands with the `{alias}` placeholder
