#!/usr/bin/env python3
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)

import base64
import binascii
import cgi
import json
import mimetypes
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse


ROOT_DIR = Path(__file__).resolve().parent
STATIC_DIR = ROOT_DIR / "static"
HOST = os.environ.get("S3B_HOST", "0.0.0.0")
PORT = int(os.environ.get("S3B_PORT", "8080"))
MAX_MC_OUTPUT = 2 * 1024 * 1024
PROFILE_HEADER = "X-S3B-Profile"
BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
ALIAS_RE = re.compile(r"[^A-Za-z0-9]+")
PROVIDERS = {"generic", "minio", "seaweedfs"}
PATH_STYLES = {"auto", "on", "off"}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def public_profile(profile):
    provider = normalize_provider(profile.get("provider"), default="generic")
    return {
        "id": profile["id"],
        "name": profile.get("name", ""),
        "endpoint": profile.get("endpoint", ""),
        "access_key": profile.get("access_key", ""),
        "provider": provider,
        "path_style": normalize_path_style(profile.get("path_style"), provider),
        "insecure": bool(profile.get("insecure", False)),
        "created_at": profile.get("created_at"),
        "updated_at": profile.get("updated_at"),
        "alias": alias_for(profile),
        "capabilities": profile_capabilities(provider),
    }


def alias_for(profile):
    suffix = ALIAS_RE.sub("", str(profile.get("id", "")))[:48]
    return "p_" + (suffix or "browser")


def normalize_endpoint(endpoint):
    endpoint = (endpoint or "").strip()
    if not endpoint:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Endpoint is required.")
    if "://" not in endpoint:
        endpoint = "https://" + endpoint
    return endpoint.rstrip("/")


def normalize_provider(provider, default="generic"):
    provider = str(provider or default).strip().lower()
    if provider not in PROVIDERS:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Provider is invalid.")
    return provider


def normalize_path_style(path_style, provider):
    path_style = str(path_style or "").strip().lower()
    if not path_style:
        path_style = "on" if provider == "seaweedfs" else "auto"
    if path_style not in PATH_STYLES:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Path style is invalid.")
    return path_style


def profile_capabilities(provider):
    minio_admin = provider == "minio"
    return {
        "object_browser": True,
        "buckets": True,
        "minio_anonymous_policy": minio_admin,
        "minio_admin_commands": minio_admin,
    }


def requires_minio_policy(profile):
    provider = normalize_provider(profile.get("provider"), default="generic")
    if not profile_capabilities(provider)["minio_anonymous_policy"]:
        raise ApiError(
            HTTPStatus.NOT_IMPLEMENTED,
            "Bucket anonymous policies use MinIO-specific mc commands. This profile should use its S3-compatible credentials or provider-specific access controls.",
        )


def require_text(payload, key, label):
    value = str(payload.get(key, "")).strip()
    if not value:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{label} is required.")
    return value


def require_secret_key(payload):
    value = require_text(payload, "secret_key", "Secret Key")
    if len(value) < 8:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Secret Key must be at least 8 characters because mc requires it.")
    return value


def normalize_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def normalize_profile(payload):
    if not isinstance(payload, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Profile credentials are required.")
    provider = normalize_provider(payload.get("provider"), default="generic")
    created_at = str(payload.get("created_at") or now_iso())
    updated_at = str(payload.get("updated_at") or now_iso())
    return {
        "id": str(payload.get("id") or uuid.uuid4()),
        "name": require_text(payload, "name", "Profile name"),
        "endpoint": normalize_endpoint(payload.get("endpoint")),
        "access_key": require_text(payload, "access_key", "Access Key"),
        "secret_key": require_secret_key(payload),
        "provider": provider,
        "path_style": normalize_path_style(payload.get("path_style"), provider),
        "insecure": normalize_bool(payload.get("insecure", False)),
        "created_at": created_at,
        "updated_at": updated_at,
    }


def decode_profile_header(value):
    if not value:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Profile credentials are required.")
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True).decode("utf-8")
        return json.loads(raw)
    except (binascii.Error, ValueError, json.JSONDecodeError, UnicodeDecodeError):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Profile credentials are invalid.")


def validate_bucket(bucket):
    bucket = (bucket or "").strip()
    if not BUCKET_RE.match(bucket):
        raise ApiError(
            HTTPStatus.BAD_REQUEST,
            "Bucket name must be S3-compatible: lowercase letters, numbers, dots, and hyphens only.",
        )
    return bucket


def clean_key(key):
    key = unquote(key or "").lstrip("/")
    while "//" in key:
        key = key.replace("//", "/")
    return key


def s3_target(profile, bucket=None, key=None):
    target = alias_for(profile)
    if bucket:
        target += "/" + bucket
    if key:
        target += "/" + clean_key(key)
    return target


def mc_env(config_dir):
    env = os.environ.copy()
    env["MC_CONFIG_DIR"] = str(config_dir)
    return env


def mc_base(profile=None):
    cmd = ["mc"]
    if profile and profile.get("insecure"):
        cmd.append("--insecure")
    return cmd


def run_mc(profile, args, timeout=120, check=True):
    with tempfile.TemporaryDirectory(prefix="s3b-mc-") as config_dir:
        ensure_alias(profile, config_dir)
        return run_mc_raw(profile, args, config_dir, timeout=timeout, check=check)


def run_mc_raw(profile, args, config_dir, timeout=120, check=True):
    cmd = mc_base(profile) + list(args)
    try:
        result = subprocess.run(
            cmd,
            env=mc_env(config_dir),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        raise ApiError(
            HTTPStatus.SERVICE_UNAVAILABLE,
            "The mc tool was not found in the runtime environment.",
        )
    except subprocess.TimeoutExpired:
        raise ApiError(HTTPStatus.GATEWAY_TIMEOUT, "The mc command timed out.")

    stdout = trim_output(result.stdout)
    stderr = trim_output(result.stderr)
    if check and result.returncode != 0:
        message = stderr or stdout or "The mc command failed."
        raise ApiError(HTTPStatus.BAD_GATEWAY, message)
    return {
        "code": result.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "command": redact_command(cmd, profile),
    }


def ensure_alias(profile, config_dir):
    Path(config_dir).mkdir(parents=True, exist_ok=True)
    alias = alias_for(profile)
    provider = normalize_provider(profile.get("provider"), default="generic")
    cmd = mc_base(profile) + [
        "alias",
        "set",
        alias,
        profile["endpoint"],
        profile["access_key"],
        profile["secret_key"],
        "--api",
        "S3v4",
        "--path",
        normalize_path_style(profile.get("path_style"), provider),
    ]
    try:
        result = subprocess.run(
            cmd,
            env=mc_env(config_dir),
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError:
        raise ApiError(
            HTTPStatus.SERVICE_UNAVAILABLE,
            "The mc tool was not found in the runtime environment.",
        )
    except subprocess.TimeoutExpired:
        raise ApiError(HTTPStatus.GATEWAY_TIMEOUT, "Configuring the mc alias timed out.")
    if result.returncode != 0:
        raise ApiError(
            HTTPStatus.BAD_GATEWAY,
            result.stderr.strip() or result.stdout.strip() or "Configuring the mc alias failed.",
        )


def trim_output(value):
    if len(value) <= MAX_MC_OUTPUT:
        return value
    return value[:MAX_MC_OUTPUT] + "\n... output truncated ..."


def redact_command(cmd, profile=None):
    sensitive = set()
    if profile:
        sensitive.update(
            value
            for value in [profile.get("access_key"), profile.get("secret_key")]
            if value
        )
    redacted = []
    previous = None
    for part in cmd:
        if previous in {"--secret-key", "secret_key"} or part in sensitive:
            redacted.append("******")
        else:
            redacted.append(part)
        previous = part
    return redacted


def parse_json_lines(stdout):
    rows = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            rows.append({"raw": line})
    return rows


def safe_upload_name(filename):
    filename = Path(filename or "").name.strip()
    if not filename:
        filename = f"upload-{int(time.time())}"
    return filename


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class S3BrowserHandler(BaseHTTPRequestHandler):
    server_version = "S3B/0.1"

    def do_GET(self):
        try:
            self.route_get()
        except ApiError as exc:
            self.send_json({"ok": False, "error": exc.message}, exc.status)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self):
        try:
            self.route_post()
        except ApiError as exc:
            self.send_json({"ok": False, "error": exc.message}, exc.status)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_PUT(self):
        try:
            self.route_put()
        except ApiError as exc:
            self.send_json({"ok": False, "error": exc.message}, exc.status)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_DELETE(self):
        try:
            self.route_delete()
        except ApiError as exc:
            self.send_json({"ok": False, "error": exc.message}, exc.status)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def log_message(self, fmt, *args):
        print("%s - - [%s] %s" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def route_get(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/api/health":
            self.send_json({"ok": True, "mc": shutil.which("mc") is not None})
            return

        if path == "/api/profiles":
            self.send_json({"ok": True, "profiles": [], "storage": "browser"})
            return

        if path == "/api/buckets":
            profile = self.request_profile()
            result = run_mc(profile, ["ls", "--json", alias_for(profile)], check=False)
            self.send_json(
                {
                    "ok": result["code"] == 0,
                    "items": parse_json_lines(result["stdout"]),
                    "stdout": result["stdout"],
                    "stderr": result["stderr"],
                },
                HTTPStatus.OK if result["code"] == 0 else HTTPStatus.BAD_GATEWAY,
            )
            return

        if path == "/api/objects":
            profile = self.request_profile()
            bucket = validate_bucket(self.query_one(qs, "bucket"))
            prefix = clean_key(self.query_one(qs, "prefix", required=False))
            target = s3_target(profile, bucket, prefix)
            if prefix and not target.endswith("/"):
                target += "/"
            result = run_mc(profile, ["ls", "--json", target], check=False)
            self.send_json(
                {
                    "ok": result["code"] == 0,
                    "items": parse_json_lines(result["stdout"]),
                    "stdout": result["stdout"],
                    "stderr": result["stderr"],
                    "prefix": prefix,
                },
                HTTPStatus.OK if result["code"] == 0 else HTTPStatus.BAD_GATEWAY,
            )
            return

        if path == "/api/policy":
            profile = self.request_profile()
            requires_minio_policy(profile)
            bucket = validate_bucket(self.query_one(qs, "bucket"))
            result = run_mc(
                profile,
                ["anonymous", "get-json", s3_target(profile, bucket)],
                check=False,
            )
            self.send_json(
                {
                    "ok": result["code"] == 0,
                    "policy": result["stdout"],
                    "stderr": result["stderr"],
                    "command": result["command"],
                },
                HTTPStatus.OK if result["code"] == 0 else HTTPStatus.BAD_GATEWAY,
            )
            return

        if path == "/api/download":
            profile = self.request_profile()
            self.handle_download(
                profile,
                {
                    "bucket": self.query_one(qs, "bucket"),
                    "key": self.query_one(qs, "key"),
                },
            )
            return

        self.serve_static(path)

    def route_post(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/profiles":
            payload = self.read_json()
            profile = normalize_profile(payload.get("profile", payload))
            with tempfile.TemporaryDirectory(prefix="s3b-mc-") as config_dir:
                ensure_alias(profile, config_dir)
            self.send_json({"ok": True, "profile": public_profile(profile)}, HTTPStatus.CREATED)
            return

        if path == "/api/login":
            payload = self.read_json()
            profile = self.request_profile(payload)
            with tempfile.TemporaryDirectory(prefix="s3b-mc-") as config_dir:
                ensure_alias(profile, config_dir)
            self.send_json({"ok": True, "profile": public_profile(profile)})
            return

        if path == "/api/buckets":
            payload = self.read_json()
            profile = self.request_profile(payload)
            bucket = validate_bucket(require_text(payload, "bucket", "Bucket name"))
            result = run_mc(profile, ["mb", s3_target(profile, bucket)], check=False)
            self.send_json(
                {"ok": result["code"] == 0, **result},
                HTTPStatus.OK if result["code"] == 0 else HTTPStatus.BAD_GATEWAY,
            )
            return

        if path == "/api/policy":
            payload = self.read_json()
            profile = self.request_profile(payload)
            requires_minio_policy(profile)
            bucket = validate_bucket(require_text(payload, "bucket", "Bucket name"))
            policy = require_text(payload, "policy", "Policy")
            if policy not in {"private", "download", "upload", "public"}:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid policy.")
            result = run_mc(
                profile,
                ["anonymous", "set", policy, s3_target(profile, bucket)],
                check=False,
            )
            self.send_json(
                {"ok": result["code"] == 0, **result},
                HTTPStatus.OK if result["code"] == 0 else HTTPStatus.BAD_GATEWAY,
            )
            return

        if path == "/api/mc":
            payload = self.read_json()
            profile = self.request_profile(payload)
            args_text = str(payload.get("args", "")).strip()
            if args_text.startswith("mc "):
                args_text = args_text[3:].strip()
            if not args_text:
                args_text = "ls {alias}"
            try:
                args = shlex.split(args_text)
            except ValueError as exc:
                raise ApiError(HTTPStatus.BAD_REQUEST, str(exc))
            alias = alias_for(profile)
            args = [part.replace("{alias}", alias).replace("ALIAS", alias) for part in args]
            result = run_mc(profile, args, timeout=300, check=False)
            self.send_json({"ok": result["code"] == 0, **result})
            return

        if path == "/api/upload":
            self.handle_upload()
            return

        if path == "/api/download":
            payload = self.read_json()
            profile = self.request_profile(payload)
            self.handle_download(profile, payload)
            return

        raise ApiError(HTTPStatus.NOT_FOUND, "API route was not found.")

    def route_put(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/profiles/"):
            payload = self.read_json()
            profile = self.request_profile(payload)
            with tempfile.TemporaryDirectory(prefix="s3b-mc-") as config_dir:
                ensure_alias(profile, config_dir)
            self.send_json({"ok": True, "profile": public_profile(profile)})
            return
        raise ApiError(HTTPStatus.NOT_FOUND, "API route was not found.")

    def route_delete(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path.startswith("/api/profiles/"):
            self.send_json({"ok": True})
            return

        if path.startswith("/api/buckets/"):
            bucket = validate_bucket(unquote(path.rsplit("/", 1)[-1]))
            profile = self.request_profile()
            args = ["rb"]
            if self.query_one(qs, "force", required=False) in {"1", "true", "yes"}:
                args.append("--force")
            args.append(s3_target(profile, bucket))
            result = run_mc(profile, args, check=False)
            self.send_json(
                {"ok": result["code"] == 0, **result},
                HTTPStatus.OK if result["code"] == 0 else HTTPStatus.BAD_GATEWAY,
            )
            return

        if path == "/api/object":
            profile = self.request_profile()
            bucket = validate_bucket(self.query_one(qs, "bucket"))
            key = clean_key(self.query_one(qs, "key"))
            args = ["rm"]
            if self.query_one(qs, "recursive", required=False) in {"1", "true", "yes"}:
                args.extend(["--recursive", "--force"])
            args.append(s3_target(profile, bucket, key))
            result = run_mc(profile, args, check=False)
            self.send_json(
                {"ok": result["code"] == 0, **result},
                HTTPStatus.OK if result["code"] == 0 else HTTPStatus.BAD_GATEWAY,
            )
            return

        raise ApiError(HTTPStatus.NOT_FOUND, "API route was not found.")

    def handle_upload(self):
        content_type = self.headers.get("content-type", "")
        if not content_type.startswith("multipart/form-data"):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Upload requests must be multipart.")
        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": content_type,
                "CONTENT_LENGTH": self.headers.get("content-length", "0"),
            },
            keep_blank_values=True,
        )
        profile = self.profile_from_form(form)
        bucket = validate_bucket(str(form.getvalue("bucket", "")))
        prefix = clean_key(str(form.getvalue("prefix", "")))
        file_field = form["file"] if "file" in form else None
        if file_field is None or not getattr(file_field, "filename", None):
            raise ApiError(HTTPStatus.BAD_REQUEST, "No file was selected.")

        upload_name = safe_upload_name(file_field.filename)
        object_key = "/".join(part for part in [prefix, upload_name] if part)
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False) as tmp:
                tmp_path = tmp.name
                shutil.copyfileobj(file_field.file, tmp)
            result = run_mc(profile, ["cp", tmp_path, s3_target(profile, bucket, object_key)], check=False)
            self.send_json(
                {"ok": result["code"] == 0, "key": object_key, **result},
                HTTPStatus.OK if result["code"] == 0 else HTTPStatus.BAD_GATEWAY,
            )
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except FileNotFoundError:
                    pass

    def handle_download(self, profile, payload):
        bucket = validate_bucket(str(payload.get("bucket", "")))
        key = clean_key(str(payload.get("key", "")))
        filename = Path(key).name or "object"
        with tempfile.TemporaryDirectory() as tmpdir:
            dest = Path(tmpdir) / filename
            run_mc(profile, ["cp", s3_target(profile, bucket, key), str(dest)], timeout=300)
            mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(dest.stat().st_size))
            self.send_header(
                "Content-Disposition",
                f"attachment; filename*=UTF-8''{quote(filename)}",
            )
            self.end_headers()
            with dest.open("rb") as fh:
                shutil.copyfileobj(fh, self.wfile)

    def serve_static(self, path):
        if path == "/":
            path = "/index.html"
        relative = Path(path.lstrip("/"))
        if relative.parts and relative.parts[0] == "static":
            relative = Path(*relative.parts[1:])
        target = (STATIC_DIR / relative).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.exists() or target.is_dir():
            target = STATIC_DIR / "index.html"
        mime = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{mime}; charset=utf-8" if mime.startswith("text/") else mime)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with target.open("rb") as fh:
            shutil.copyfileobj(fh, self.wfile)

    def read_json(self):
        length = int(self.headers.get("content-length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid JSON.")

    def query_one(self, qs, key, required=True):
        values = qs.get(key)
        if not values or values[0] == "":
            if required:
                raise ApiError(HTTPStatus.BAD_REQUEST, f"{key} is required.")
            return ""
        return values[0]

    def request_profile(self, payload=None):
        if isinstance(payload, dict) and isinstance(payload.get("profile"), dict):
            return normalize_profile(payload["profile"])
        return normalize_profile(decode_profile_header(self.headers.get(PROFILE_HEADER)))

    def profile_from_form(self, form):
        raw = str(form.getvalue("profile", "") or "")
        if raw:
            try:
                return normalize_profile(json.loads(raw))
            except json.JSONDecodeError:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Profile credentials are invalid.")
        return self.request_profile()

    def send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main():
    server = ThreadingHTTPServer((HOST, PORT), S3BrowserHandler)
    print(f"S3B listening on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
