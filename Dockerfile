ARG PYTHON_IMAGE=python:3.12-alpine
FROM ${PYTHON_IMAGE}

ARG TARGETARCH

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
    curl -fsSL "https://dl.min.io/client/mc/release/linux-${mc_arch}/mc" -o /usr/local/bin/mc; \
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
