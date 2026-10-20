#!/usr/bin/env python3
"""Synchronize one explicitly configured read-only directory to an existing RC2 knowledge base."""

from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import json
import os
import re
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


SUPPORTED_EXTENSIONS = {
    ".txt", ".md", ".csv", ".json", ".docx", ".xlsx", ".pptx",
    ".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp",
}
MAX_API_FILE_BYTES = 10 * 1024 * 1024
MAX_KNOWLEDGE_DOCUMENTS = 50
IDEMPOTENCY_NAMESPACE = uuid.UUID("2cc58586-f6aa-4aa4-bc04-c5fc8c9e2bc3")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}\Z")


class SyncError(RuntimeError):
    pass


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _require_exact_mode(path: Path, expected: int, label: str) -> None:
    try:
        info = path.lstat()
    except OSError as exc:
        raise SyncError(f"{label} is unavailable: {path}") from exc
    if not stat.S_ISREG(info.st_mode):
        raise SyncError(f"{label} must be a regular file and not a symbolic link")
    mode = stat.S_IMODE(info.st_mode)
    if mode != expected:
        raise SyncError(f"{label} must have mode {oct(expected)}, got {oct(mode)}")


def _read_json(path: Path, label: str, *, required_owner_uid: int | None = None) -> dict[str, Any]:
    fd: int | None = None
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_size > 1024 * 1024
                or (required_owner_uid is not None and info.st_uid != required_owner_uid)):
            raise SyncError(f"{label} changed or has unsafe ownership, type, mode, or size")
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            fd = None
            value = json.load(handle)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SyncError(f"cannot read valid {label}: {path}") from exc
    finally:
        if fd is not None:
            os.close(fd)
    if not isinstance(value, dict):
        raise SyncError(f"{label} must be a JSON object")
    return value


@dataclass(frozen=True)
class SyncConfig:
    source_root: Path
    knowledge_id: str
    allowed_extensions: frozenset[str]
    max_files: int
    max_file_bytes: int
    max_total_bytes: int
    max_directories: int
    max_depth: int
    source_readonly: bool
    credential_file: Path
    state_file: Path
    api_base_url: str
    origin: str
    allow_retract: bool

    @classmethod
    def load(cls, path: Path) -> "SyncConfig":
        path = path.expanduser().absolute()
        if not path.exists():
            raise SyncError(f"configured sync file does not exist: {path}")
        _require_exact_mode(path, 0o600, "sync config")
        raw = _read_json(path, "sync config")
        required = {
            "sourceRoot", "knowledgeId", "allowedExtensions", "maxFiles",
            "maxFileBytes", "maxTotalBytes", "maxDirectories", "maxDepth",
            "sourceReadonly", "credentialFile", "stateFile", "apiBaseUrl",
            "origin", "allowRetract",
        }
        missing = sorted(required - raw.keys())
        if missing:
            raise SyncError(f"sync config is missing required fields: {', '.join(missing)}")
        unknown = sorted(set(raw) - required)
        if unknown:
            raise SyncError(f"sync config has unknown fields: {', '.join(unknown)}")
        source_input = Path(str(raw["sourceRoot"])).expanduser().absolute()
        if source_input.is_symlink():
            raise SyncError("sourceRoot itself must not be a symbolic link")
        try:
            source_root = source_input.resolve(strict=True)
        except OSError as exc:
            raise SyncError(f"configured sourceRoot is unavailable: {source_input}") from exc
        if not source_root.is_dir():
            raise SyncError("configured sourceRoot must be a directory")
        try:
            knowledge_id = str(uuid.UUID(str(raw["knowledgeId"])))
        except ValueError as exc:
            raise SyncError("knowledgeId must be a UUID") from exc
        extensions = raw["allowedExtensions"]
        if not isinstance(extensions, list) or not extensions:
            raise SyncError("allowedExtensions must be a non-empty array")
        if any(not isinstance(value, str) or not re.fullmatch(r"\.?[A-Za-z0-9]+", value) for value in extensions):
            raise SyncError("allowedExtensions entries must be simple extension strings")
        normalized = frozenset((value.lower() if value.startswith(".") else "." + value.lower()) for value in extensions)
        unsupported = sorted(normalized - SUPPORTED_EXTENSIONS)
        if unsupported:
            raise SyncError(f"unsupported allowedExtensions: {', '.join(unsupported)}")
        if raw["sourceReadonly"] is not True:
            raise SyncError("sourceReadonly must be explicitly true")

        def bounded_int(name: str, minimum: int, maximum: int) -> int:
            value = raw[name]
            if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
                raise SyncError(f"{name} must be an integer from {minimum} to {maximum}")
            return value

        max_files = bounded_int("maxFiles", 1, MAX_KNOWLEDGE_DOCUMENTS)
        max_file_bytes = bounded_int("maxFileBytes", 1, MAX_API_FILE_BYTES)
        max_total_bytes = bounded_int("maxTotalBytes", max_file_bytes, MAX_KNOWLEDGE_DOCUMENTS * MAX_API_FILE_BYTES)
        max_directories = bounded_int("maxDirectories", 1, 10_000)
        max_depth = bounded_int("maxDepth", 0, 64)
        credential_file = Path(str(raw["credentialFile"])).expanduser().absolute()
        state_file = Path(str(raw["stateFile"])).expanduser().absolute()
        if _is_within(credential_file.resolve(strict=False), source_root):
            raise SyncError("credentialFile must be outside sourceRoot")
        if _is_within(state_file.resolve(strict=False), source_root):
            raise SyncError("stateFile must be outside sourceRoot")
        api_base_url = str(raw["apiBaseUrl"]).rstrip("/")
        origin = str(raw["origin"]).rstrip("/")
        parsed_api = urllib.parse.urlparse(api_base_url)
        if parsed_api.scheme != "https" or not parsed_api.netloc or parsed_api.username or parsed_api.password or parsed_api.query or parsed_api.fragment:
            raise SyncError("apiBaseUrl must use HTTPS")
        parsed_origin = urllib.parse.urlparse(origin)
        if (parsed_origin.scheme != "https" or not parsed_origin.netloc or parsed_origin.username or parsed_origin.password
                or parsed_origin.path not in ("", "/") or parsed_origin.query or parsed_origin.fragment):
            raise SyncError("origin must be an HTTPS origin without a path")
        if not isinstance(raw["allowRetract"], bool):
            raise SyncError("allowRetract must be boolean")
        return cls(
            source_root=source_root,
            knowledge_id=knowledge_id,
            allowed_extensions=normalized,
            max_files=max_files,
            max_file_bytes=max_file_bytes,
            max_total_bytes=max_total_bytes,
            max_directories=max_directories,
            max_depth=max_depth,
            source_readonly=True,
            credential_file=credential_file,
            state_file=state_file,
            api_base_url=api_base_url,
            origin=origin,
            allow_retract=raw["allowRetract"],
        )


@dataclass(frozen=True)
class SourceFile:
    relative_path: str
    absolute_path: Path
    filename: str
    size: int
    sha256: str


def scan_source(config: SyncConfig) -> list[SourceFile]:
    root = config.source_root
    files: list[SourceFile] = []
    total_bytes = 0
    directory_count = 0
    stack: list[tuple[Path, int]] = [(root, 0)]
    while stack:
        folder, depth = stack.pop()
        directory_count += 1
        if directory_count > config.max_directories:
            raise SyncError("source directory count exceeds maxDirectories")
        if depth > config.max_depth:
            raise SyncError("source directory depth exceeds maxDepth")
        try:
            entries = sorted(os.scandir(folder), key=lambda entry: entry.name)
        except OSError as exc:
            raise SyncError(f"cannot read configured source directory: {folder}") from exc
        for entry in entries:
            entry_path = Path(entry.path)
            if entry.is_symlink():
                raise SyncError(f"symbolic links are not allowed under sourceRoot: {entry_path.relative_to(root)}")
            if entry.is_dir(follow_symlinks=False):
                if depth >= config.max_depth:
                    raise SyncError("source directory depth exceeds maxDepth")
                stack.append((entry_path, depth + 1))
                continue
            if not entry.is_file(follow_symlinks=False):
                raise SyncError(f"non-regular source entry is not allowed: {entry_path.relative_to(root)}")
            if entry_path.suffix.lower() not in config.allowed_extensions:
                continue
            if any(character in entry_path.name for character in ('"', "\r", "\n")):
                raise SyncError(f"source filename contains unsupported characters: {entry_path.relative_to(root)}")
            real = entry_path.resolve(strict=True)
            if not _is_within(real, root):
                raise SyncError(f"source file escapes configured root: {entry_path.relative_to(root)}")
            info = entry.stat(follow_symlinks=False)
            if info.st_size > config.max_file_bytes:
                raise SyncError(f"source file exceeds maxFileBytes: {entry_path.relative_to(root)}")
            total_bytes += info.st_size
            if total_bytes > config.max_total_bytes:
                raise SyncError("source files exceed maxTotalBytes")
            relative = entry_path.relative_to(root).as_posix()
            payload = _read_opened_source(root, real, relative, config.max_file_bytes, expected_size=info.st_size)
            files.append(SourceFile(relative, real, entry_path.name, info.st_size, hashlib.sha256(payload).hexdigest()))
            if len(files) > config.max_files:
                raise SyncError("source file count exceeds maxFiles")
    duplicate_names = sorted(name for name in {item.filename for item in files} if sum(x.filename == name for x in files) > 1)
    if duplicate_names:
        raise SyncError(f"duplicate basenames are ambiguous in a flat knowledge base: {', '.join(duplicate_names)}")
    return sorted(files, key=lambda item: item.relative_path)


def _opened_fd_canonical_path(fd: int) -> Path:
    if sys.platform != "linux" or not Path("/proc/self/fd").is_dir():
        raise SyncError("secure source reads require Linux /proc/self/fd support")
    try:
        return Path(os.path.realpath(f"/proc/self/fd/{fd}"))
    except OSError as exc:
        raise SyncError("cannot resolve the opened source file securely") from exc


def _read_opened_source(
    root: Path,
    path: Path,
    relative_path: str,
    max_file_bytes: int,
    *,
    expected_size: int | None = None,
    expected_sha256: str | None = None,
) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise SyncError(f"cannot securely open source file: {relative_path}") from exc
    try:
        info = os.fstat(fd)
        opened_path = _opened_fd_canonical_path(fd)
        if not _is_within(opened_path, root) or opened_path != path:
            raise SyncError(f"opened source file escapes or changed path: {relative_path}")
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > max_file_bytes
                or (expected_size is not None and info.st_size != expected_size)):
            raise SyncError(f"source file changed before read: {relative_path}")
        chunks: list[bytes] = []
        remaining = max_file_bytes + 1
        while remaining > 0:
            chunk = os.read(fd, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        if len(payload) > max_file_bytes or len(payload) != info.st_size:
            raise SyncError(f"source file changed during read: {relative_path}")
        if expected_sha256 is not None and hashlib.sha256(payload).hexdigest() != expected_sha256:
            raise SyncError(f"source file changed before upload: {relative_path}")
        after = os.fstat(fd)
        if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise SyncError(f"source file changed during read: {relative_path}")
        return payload
    finally:
        os.close(fd)


def read_source_bytes(config: SyncConfig, source: SourceFile) -> bytes:
    return _read_opened_source(
        config.source_root,
        source.absolute_path,
        source.relative_path,
        config.max_file_bytes,
        expected_size=source.size,
        expected_sha256=source.sha256,
    )


class Rc2Client:
    def __init__(self, api_base_url: str, origin: str, client_id: str, *, allow_http_for_test: bool = False):
        if not allow_http_for_test and urllib.parse.urlparse(api_base_url).scheme != "https":
            raise SyncError("RC2 API requires HTTPS")
        self.api_base_url = api_base_url.rstrip("/")
        self.origin = origin.rstrip("/")
        self.client_id = client_id
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))

    def _request(self, route: str, *, method: str = "GET", body: bytes | None = None, content_type: str | None = None) -> Any:
        headers = {"Origin": self.origin, "clientid": self.client_id, "Accept": "application/json"}
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(self.api_base_url + route, data=body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=60) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            with exc:
                try:
                    payload = json.loads(exc.read().decode("utf-8"))
                except Exception:
                    payload = {}
            code = payload.get("code", exc.code) if isinstance(payload, dict) else exc.code
            raise SyncError(f"RC2 request failed: {method} {route}, code={code}") from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise SyncError(f"RC2 request failed: {method} {route}") from exc
        if not isinstance(payload, dict) or payload.get("code") != 200:
            code = payload.get("code", "invalid-response") if isinstance(payload, dict) else "invalid-response"
            raise SyncError(f"RC2 request failed: {method} {route}, code={code}")
        return payload.get("data")

    def login(self, username: str, password: str) -> None:
        body = json.dumps({
            "username": username,
            "password": password,
            "clientId": self.client_id,
            "grantType": "password",
        }).encode("utf-8")
        self._request("/auth/login", method="POST", body=body, content_type="application/json")
        if not any(cookie.name == "__Host-workspace-rc2" for cookie in self.cookies):
            raise SyncError("RC2 login did not establish the required secure session")

    def logout(self) -> None:
        try:
            self._request("/auth/logout", method="POST", body=b"{}", content_type="application/json")
        finally:
            self.cookies.clear()

    def documents(self, knowledge_id: str) -> list[dict[str, Any]]:
        values: list[dict[str, Any]] = []
        for page in range(1, 4):
            rows = self._request(f"/ai/knowledge/{knowledge_id}/documents?page={page}")
            if not isinstance(rows, list):
                raise SyncError("RC2 document listing returned an invalid response")
            values.extend(row for row in rows if isinstance(row, dict))
            if len(rows) < 30:
                break
        if len(values) > MAX_KNOWLEDGE_DOCUMENTS:
            raise SyncError("target knowledge base exceeds the supported document limit")
        return values

    def upload(
        self,
        knowledge_id: str,
        filename: str,
        content: bytes,
        idempotency_key: str,
        *,
        document_id: str | None = None,
        expected_version: int | None = None,
    ) -> dict[str, Any]:
        params = {"idempotencyKey": idempotency_key}
        if document_id is not None:
            params["documentId"] = document_id
            params["expectedVersion"] = str(expected_version)
        route = f"/ai/knowledge/{knowledge_id}/documents?{urllib.parse.urlencode(params)}"
        boundary = "----zhenwork-sync-" + uuid.uuid4().hex
        safe_name = filename.replace('"', "_").replace("\r", "_").replace("\n", "_")
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{safe_name}\"\r\n"
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode("utf-8") + content + f"\r\n--{boundary}--\r\n".encode("ascii")
        value = self._request(route, method="POST", body=body, content_type=f"multipart/form-data; boundary={boundary}")
        try:
            document_id = str(uuid.UUID(str(value.get("id")))) if isinstance(value, dict) else ""
        except ValueError:
            document_id = ""
        version = value.get("version") if isinstance(value, dict) else None
        if not document_id or isinstance(version, bool) or not isinstance(version, int) or version < 1:
            raise SyncError("RC2 upload returned an invalid response")
        return {**value, "id": document_id, "version": version}

    def retract(self, document_id: str) -> None:
        self._request(f"/ai/knowledge/documents/{document_id}", method="DELETE")


def load_credentials(path: Path, *, required_owner_uid: int = 0) -> dict[str, str]:
    try:
        info = path.lstat()
    except OSError as exc:
        raise SyncError(f"credential file is unavailable: {path}") from exc
    if not stat.S_ISREG(info.st_mode):
        raise SyncError("credential file must be a regular file and not a symbolic link")
    if info.st_uid != required_owner_uid:
        raise SyncError(f"credential file must be owned by uid {required_owner_uid}")
    _require_exact_mode(path, 0o600, "credential file")
    raw = _read_json(path, "credential file", required_owner_uid=required_owner_uid)
    if set(raw) != {"clientId", "username", "password"}:
        raise SyncError("credential file must contain only clientId, username, and password")
    if not all(isinstance(raw[name], str) and raw[name] for name in raw):
        raise SyncError("credential values must be non-empty strings")
    return {name: raw[name] for name in ("clientId", "username", "password")}


def load_state(config: SyncConfig) -> dict[str, Any]:
    if not config.state_file.exists():
        return {"schemaVersion": 1, "sourceRoot": str(config.source_root), "knowledgeId": config.knowledge_id, "files": {}}
    _require_exact_mode(config.state_file, 0o600, "sync state")
    state = _read_json(config.state_file, "sync state")
    if set(state) != {"schemaVersion", "sourceRoot", "knowledgeId", "files"}:
        raise SyncError("sync state has unknown or missing fields")
    if state.get("schemaVersion") != 1 or not isinstance(state.get("files"), dict):
        raise SyncError("sync state has an unsupported schema")
    if state.get("sourceRoot") != str(config.source_root) or state.get("knowledgeId") != config.knowledge_id:
        raise SyncError("sync state belongs to a different sourceRoot or knowledgeId")
    seen_document_ids: set[str] = set()
    seen_remote_names: set[str] = set()
    for relative, value in state["files"].items():
        if (not isinstance(relative, str) or not relative or "\\" in relative or "\0" in relative
                or Path(relative).is_absolute() or any(part in ("", ".", "..") for part in relative.split("/"))):
            raise SyncError("sync state contains an invalid relative source path")
        if not isinstance(value, dict) or set(value) != {"documentId", "version", "sha256", "size", "remoteName"}:
            raise SyncError(f"sync state entry has unknown or missing fields: {relative}")
        try:
            document_id = str(uuid.UUID(str(value["documentId"])))
        except ValueError as exc:
            raise SyncError(f"sync state has an invalid documentId: {relative}") from exc
        if document_id != value["documentId"]:
            raise SyncError(f"sync state has a non-canonical documentId: {relative}")
        if document_id in seen_document_ids:
            raise SyncError(f"sync state reuses a documentId: {relative}")
        seen_document_ids.add(document_id)
        version = value["version"]
        if isinstance(version, bool) or not isinstance(version, int) or version < 1:
            raise SyncError(f"sync state has an invalid version: {relative}")
        if not isinstance(value["sha256"], str) or not SHA256_PATTERN.fullmatch(value["sha256"]):
            raise SyncError(f"sync state has an invalid sha256: {relative}")
        size = value["size"]
        if isinstance(size, bool) or not isinstance(size, int) or not 0 <= size <= config.max_file_bytes:
            raise SyncError(f"sync state has an invalid size: {relative}")
        remote_name = value["remoteName"]
        if (not isinstance(remote_name, str) or not remote_name or remote_name in (".", "..")
                or "/" in remote_name or "\\" in remote_name or "\0" in remote_name):
            raise SyncError(f"sync state has an invalid remoteName: {relative}")
        if remote_name in seen_remote_names:
            raise SyncError(f"sync state reuses a remoteName: {relative}")
        seen_remote_names.add(remote_name)
    return state


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _idempotency_key(config: SyncConfig, source: SourceFile, previous: dict[str, Any] | None) -> str:
    marker = ":".join([
        config.knowledge_id,
        source.relative_path,
        source.sha256,
        str(previous.get("documentId", "") if previous else ""),
        str(previous.get("version", "") if previous else ""),
    ])
    return str(uuid.uuid5(IDEMPOTENCY_NAMESPACE, marker))


def synchronize(config: SyncConfig, client: Rc2Client, *, retract_missing: bool = False) -> dict[str, int]:
    sources = scan_source(config)
    state = load_state(config)
    if not config.state_file.exists():
        save_state(config.state_file, state)
    state_files: dict[str, dict[str, Any]] = state["files"]
    remote = client.documents(config.knowledge_id)
    remote_by_id = {str(row.get("id")): row for row in remote if row.get("id")}
    remote_by_title: dict[str, list[dict[str, Any]]] = {}
    for row in remote:
        remote_by_title.setdefault(str(row.get("title", "")), []).append(row)

    source_paths = {item.relative_path for item in sources}
    for relative, previous in state_files.items():
        document_id = str(previous.get("documentId", ""))
        row = remote_by_id.get(document_id)
        if row is None:
            raise SyncError(f"tracked remote document is unavailable: {relative}")
        if str(row.get("title")) != previous.get("remoteName"):
            raise SyncError(f"tracked remote document title changed: {relative}")
        remote_version = row.get("latest_version")
        if isinstance(remote_version, bool) or not isinstance(remote_version, int) or remote_version < 1:
            raise SyncError(f"tracked remote document has an invalid version: {relative}")
        if remote_version != previous["version"]:
            raise SyncError(f"tracked remote document version changed outside this sync: {relative}")

    result = {"uploaded": 0, "updated": 0, "unchanged": 0, "retainedMissing": 0, "retracted": 0}
    for source in sources:
        previous = state_files.get(source.relative_path)
        if previous and previous.get("sha256") == source.sha256:
            result["unchanged"] += 1
            continue
        if previous is None and remote_by_title.get(source.filename):
            raise SyncError(f"untracked remote document has the same filename: {source.filename}")
        content = read_source_bytes(config, source)
        response = client.upload(
            config.knowledge_id,
            source.filename,
            content,
            _idempotency_key(config, source, previous),
            document_id=str(previous["documentId"]) if previous else None,
            expected_version=int(previous["version"]) if previous else None,
        )
        state_files[source.relative_path] = {
            "documentId": str(response["id"]),
            "version": int(response["version"]),
            "sha256": source.sha256,
            "size": source.size,
            "remoteName": source.filename,
        }
        save_state(config.state_file, state)
        result["updated" if previous else "uploaded"] += 1

    missing = sorted(set(state_files) - source_paths)
    if missing and retract_missing and not config.allow_retract:
        raise SyncError("--retract-missing requires allowRetract=true in the sync config")
    for relative in missing:
        if not retract_missing:
            result["retainedMissing"] += 1
            continue
        client.retract(str(state_files[relative]["documentId"]))
        del state_files[relative]
        save_state(config.state_file, state)
        result["retracted"] += 1
    return result


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path, help="explicit 0600 JSON sync config")
    parser.add_argument("--retract-missing", action="store_true", help="delete tracked remote documents missing locally; also requires allowRetract=true")
    args = parser.parse_args(argv)
    client: Rc2Client | None = None
    try:
        config = SyncConfig.load(args.config)
        credentials = load_credentials(config.credential_file)
        client = Rc2Client(config.api_base_url, config.origin, credentials["clientId"])
        client.login(credentials["username"], credentials["password"])
        result = synchronize(config, client, retract_missing=args.retract_missing)
        print(json.dumps({"status": "ok", **result}, separators=(",", ":")))
        return 0
    except SyncError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, separators=(",", ":")))
        return 2
    finally:
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
