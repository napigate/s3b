#!/usr/bin/env python3
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)

import cgi
import json
import mimetypes
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse


ROOT_DIR = Path(__file__).resolve().parent
STATIC_DIR = ROOT_DIR / "static"
DATA_DIR = Path(os.environ.get("S3B_DATA_DIR", "/data")).resolve()
PROFILE_FILE = DATA_DIR / "profiles.json"
MC_CONFIG_DIR = DATA_DIR / "mc"
HOST = os.environ.get("S3B_HOST", "0.0.0.0")
PORT = int(os.environ.get("S3B_PORT", "8080"))
MAX_MC_OUTPUT = 2 * 1024 * 1024
BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")

DATA_LOCK = threading.RLock()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def ensure_data_files():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MC_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if not PROFILE_FILE.exists():
        save_profiles({"profiles": []})


def load_profiles():
    ensure_data_files()
    with DATA_LOCK:
        try:
            with PROFILE_FILE.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (json.JSONDecodeError, FileNotFoundError):
            data = {"profiles": []}
        data.setdefault("profiles", [])
        return data


def save_profiles(data):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with DATA_LOCK:
        tmp = PROFILE_FILE.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        tmp.replace(PROFILE_FILE)


def public_profile(profile):
    return {
        "id": profile["id"],
        "name": profile.get("name", ""),
        "endpoint": profile.get("endpoint", ""),
        "access_key": profile.get("access_key", ""),
        "insecure": bool(profile.get("insecure", False)),
        "created_at": profile.get("created_at"),
        "updated_at": profile.get("updated_at"),
        "alias": alias_for(profile),
    }


def get_profile(profile_id):
    data = load_profiles()
    for profile in data["profiles"]:
        if profile.get("id") == profile_id:
            return profile
    raise ApiError(HTTPStatus.NOT_FOUND, "Profile was not found.")


def alias_for(profile):
    return "p_" + profile["id"].replace("-", "")


def normalize_endpoint(endpoint):
    endpoint = (endpoint or "").strip()
    if not endpoint:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Endpoint is required.")
    if "://" not in endpoint:
        endpoint = "https://" + endpoint
    return endpoint.rstrip("/")


def require_text(payload, key, label):
    value = str(payload.get(key, "")).strip()
    if not value:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{label} is required.")
    return value


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


def mc_env():
    env = os.environ.copy()
    env["MC_CONFIG_DIR"] = str(MC_CONFIG_DIR)
    return env


def mc_base(profile=None):
    cmd = ["mc"]
    if profile and profile.get("insecure"):
        cmd.append("--insecure")
    return cmd


def run_mc(profile, args, timeout=120, check=True):
    ensure_alias(profile)
    return run_mc_raw(profile, args, timeout=timeout, check=check)


def run_mc_raw(profile, args, timeout=120, check=True):
    cmd = mc_base(profile) + list(args)
    try:
        result = subprocess.run(
            cmd,
            env=mc_env(),
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
        "command": redact_command(cmd),
    }


def ensure_alias(profile):
    ensure_data_files()
    alias = alias_for(profile)
    cmd = mc_base(profile) + [
        "alias",
        "set",
        alias,
        profile["endpoint"],
        profile["access_key"],
        profile["secret_key"],
        "--api",
        "S3v4",
    ]
    try:
        result = subprocess.run(
            cmd,
            env=mc_env(),
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


def redact_command(cmd):
    redacted = []
    previous = None
    for part in cmd:
        if previous in {"--secret-key", "secret_key"}:
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
            profiles = [public_profile(profile) for profile in load_profiles()["profiles"]]
            self.send_json({"ok": True, "profiles": profiles})
            return

        if path == "/api/buckets":
            profile = get_profile(self.query_one(qs, "profile_id"))
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
            profile = get_profile(self.query_one(qs, "profile_id"))
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
            profile = get_profile(self.query_one(qs, "profile_id"))
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
            self.handle_download(qs)
            return

        self.serve_static(path)

    def route_post(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/profiles":
            payload = self.read_json()
            profile = {
                "id": str(uuid.uuid4()),
                "name": require_text(payload, "name", "Profile name"),
                "endpoint": normalize_endpoint(payload.get("endpoint")),
                "access_key": require_text(payload, "access_key", "Access Key"),
                "secret_key": require_text(payload, "secret_key", "Secret Key"),
                "insecure": bool(payload.get("insecure", False)),
                "created_at": now_iso(),
                "updated_at": now_iso(),
            }
            data = load_profiles()
            data["profiles"].append(profile)
            save_profiles(data)
            ensure_alias(profile)
            self.send_json({"ok": True, "profile": public_profile(profile)}, HTTPStatus.CREATED)
            return

        if path == "/api/login":
            payload = self.read_json()
            profile = get_profile(require_text(payload, "profile_id", "Profile"))
            ensure_alias(profile)
            self.send_json({"ok": True, "profile": public_profile(profile)})
            return

        if path == "/api/buckets":
            payload = self.read_json()
            profile = get_profile(require_text(payload, "profile_id", "Profile"))
            bucket = validate_bucket(require_text(payload, "bucket", "Bucket name"))
            result = run_mc(profile, ["mb", s3_target(profile, bucket)], check=False)
            self.send_json(
                {"ok": result["code"] == 0, **result},
                HTTPStatus.OK if result["code"] == 0 else HTTPStatus.BAD_GATEWAY,
            )
            return

        if path == "/api/policy":
            payload = self.read_json()
            profile = get_profile(require_text(payload, "profile_id", "Profile"))
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
            profile = get_profile(require_text(payload, "profile_id", "Profile"))
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

        raise ApiError(HTTPStatus.NOT_FOUND, "API route was not found.")

    def route_put(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/profiles/"):
            profile_id = path.rsplit("/", 1)[-1]
            payload = self.read_json()
            data = load_profiles()
            for profile in data["profiles"]:
                if profile.get("id") == profile_id:
                    if "name" in payload:
                        profile["name"] = require_text(payload, "name", "Profile name")
                    if "endpoint" in payload:
                        profile["endpoint"] = normalize_endpoint(payload.get("endpoint"))
                    if "access_key" in payload:
                        profile["access_key"] = require_text(payload, "access_key", "Access Key")
                    if str(payload.get("secret_key", "")).strip():
                        profile["secret_key"] = require_text(payload, "secret_key", "Secret Key")
                    if "insecure" in payload:
                        profile["insecure"] = bool(payload.get("insecure", False))
                    profile["updated_at"] = now_iso()
                    save_profiles(data)
                    ensure_alias(profile)
                    self.send_json({"ok": True, "profile": public_profile(profile)})
                    return
            raise ApiError(HTTPStatus.NOT_FOUND, "Profile was not found.")
        raise ApiError(HTTPStatus.NOT_FOUND, "API route was not found.")

    def route_delete(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path.startswith("/api/profiles/"):
            profile_id = path.rsplit("/", 1)[-1]
            data = load_profiles()
            before = len(data["profiles"])
            data["profiles"] = [p for p in data["profiles"] if p.get("id") != profile_id]
            if len(data["profiles"]) == before:
                raise ApiError(HTTPStatus.NOT_FOUND, "Profile was not found.")
            save_profiles(data)
            self.send_json({"ok": True})
            return

        if path.startswith("/api/buckets/"):
            bucket = validate_bucket(unquote(path.rsplit("/", 1)[-1]))
            profile = get_profile(self.query_one(qs, "profile_id"))
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
            profile = get_profile(self.query_one(qs, "profile_id"))
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
        profile = get_profile(str(form.getvalue("profile_id", "")))
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

    def handle_download(self, qs):
        profile = get_profile(self.query_one(qs, "profile_id"))
        bucket = validate_bucket(self.query_one(qs, "bucket"))
        key = clean_key(self.query_one(qs, "key"))
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

    def send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main():
    ensure_data_files()
    server = ThreadingHTTPServer((HOST, PORT), S3BrowserHandler)
    print(f"S3B listening on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
