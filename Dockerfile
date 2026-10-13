ARG PYTHON_IMAGE=python:3.12-alpine
FROM ${PYTHON_IMAGE}

ARG TARGETARCH
ARG MC_VERSION=RELEASE.2025-08-13T08-35-41Z

USER root

RUN set -eux; \
    if ! command -v curl >/dev/null 2>&1; then \
      if command -v apk >/dev/null 2>&1; then \
        apk add --no-cache ca-certificates curl; \
      elif command -v apt-get >/dev/null 2>&1; then \
        apt-get update; \
        apt-get install -y --no-install-recommends ca-certificates curl; \
        rm -rf /var/lib/apt/lists/*; \
      else \
        echo "No supported package manager found for installing curl" >&2; \
        exit 1; \
      fi; \
    fi; \
    case "$TARGETARCH" in \
        amd64|"") mc_arch="amd64" ;; \
        arm64) mc_arch="arm64" ;; \
        *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    mc_url="https://github.com/minio/mc/releases/download/${MC_VERSION}/mc.linux-${mc_arch}.${MC_VERSION}"; \
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 "$mc_url" -o /usr/local/bin/mc; \
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 "${mc_url}.sha256sum" -o /tmp/mc.sha256sum; \
    read -r mc_sha256 mc_filename < /tmp/mc.sha256sum; \
    echo "$mc_sha256  /usr/local/bin/mc" | sha256sum -c -; \
    rm /tmp/mc.sha256sum; \
    chmod +x /usr/local/bin/mc

WORKDIR /app
COPY app/ /app/

ENV S3B_HOST=0.0.0.0 \
    S3B_PORT=8080 \
    S3B_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT []
CMD ["python3", "/app/server.py"]
