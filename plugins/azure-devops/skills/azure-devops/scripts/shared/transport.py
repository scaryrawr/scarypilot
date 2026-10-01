from __future__ import annotations

import base64
import configparser
import hashlib
import http.client
import json
import math
import ntpath
import os
import random
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable, Iterator


IMMUTABLE_CACHE_LOCK_STRIPES = 64


class AdoError(RuntimeError):
    def __init__(self, message: str, *, code: str | None = None):
        super().__init__(message)
        self.code = code


class WriteRejected(AdoError):
    def __init__(self, status: int):
        super().__init__(f"Azure DevOps HTTP {status}", code="write_rejected")
        self.status = status


class Deferred(AdoError):
    def __init__(self, retry_at: float):
        super().__init__("organization cooldown exceeds foreground wait budget")
        self.retry_at = retry_at


def organization(value: str) -> str:
    raw = value.strip().rstrip("/")
    if "://" not in raw:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", raw):
            raise AdoError("invalid organization")
        return raw.lower()
    try:
        parsed = urllib.parse.urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise AdoError("invalid Azure DevOps origin") from exc
    if parsed.scheme != "https" or parsed.username or parsed.password or port not in (None, 443):
        raise AdoError("invalid Azure DevOps origin")
    host = parsed.hostname or ""
    parts = parsed.path.split("/")
    if host in {"dev.azure.com", "almsearch.dev.azure.com"} and len(parts) > 1:
        return organization(urllib.parse.unquote(parts[1]))
    if host.endswith(".visualstudio.com"):
        return organization(host.removesuffix(".visualstudio.com"))
    raise AdoError("unsupported Azure DevOps origin")


def canonical_url(url: str) -> tuple[str, str]:
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError as exc:
        raise AdoError("invalid Azure DevOps origin") from exc
    if parsed.scheme != "https" or not parsed.hostname:
        raise AdoError("HTTP requests require an Azure DevOps HTTPS URL")
    org = organization(url)
    if parsed.fragment:
        raise AdoError("URL fragments are not supported")
    path = parsed.path
    if parsed.hostname not in {"dev.azure.com", "almsearch.dev.azure.com"}:
        if path.startswith("/DefaultCollection/"):
            path = path[len("/DefaultCollection"):]
        path = "/" + org + path
    else:
        path = "/" + org + "/" + "/".join(path.split("/")[2:])
    # Dot segments must not change the organization after credential validation.
    for part in path.split("/"):
        decoded = part
        for _ in range(4):
            next_value = urllib.parse.unquote(decoded)
            if next_value == decoded:
                break
            decoded = next_value
        else:
            raise AdoError("unsafe URL encoding")
        if decoded in (".", "..") or "/" in decoded or "\\" in decoded or any(ord(char) < 32 for char in decoded):
            raise AdoError("unsafe URL path")
    if any(ord(char) < 32 for char in url):
        raise AdoError("unsafe URL path")
    host = "almsearch.dev.azure.com" if parsed.hostname == "almsearch.dev.azure.com" else "dev.azure.com"
    return org, urllib.parse.urlunsplit(("https", host, path, parsed.query, ""))


def resolve_organization(explicit: str = "", detect: str = "true") -> str:
    if explicit:
        return organization(explicit)
    configured = os.environ.get("AZURE_DEVOPS_EXT_ORG", "")
    azure_dir = Path(os.environ.get("AZURE_CONFIG_DIR", str(Path.home() / ".azure")))
    parser = configparser.ConfigParser()
    parser.read(azure_dir / "azuredevops" / "config", encoding="utf-8")
    for section in ("defaults", "$defaults"):
        if not configured and parser.has_option(section, "organization"):
            configured = parser.get(section, "organization")
    if detect.lower() == "true":
        result = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True, check=False)
        if result.returncode == 0:
            remote = result.stdout.strip()
            match = re.search(r"(?:git@ssh\.dev\.azure\.com:v3/|ssh://git@ssh\.dev\.azure\.com[:/]v3/)([^/]+)", remote)
            if match:
                return organization(match.group(1))
            if "dev.azure.com/" in remote or ".visualstudio.com/" in remote:
                parsed = urllib.parse.urlsplit(remote)
                clean = urllib.parse.urlunsplit((parsed.scheme, parsed.hostname or "", parsed.path, "", ""))
                return organization(clean)
    if configured:
        return organization(configured)
    raise AdoError("could not determine organization; provide --org")


def stored_pat(org: str) -> str | None:
    services = [f"azdevops-cli:https://dev.azure.com/{org}",
                f"azdevops-cli:https://{org}.visualstudio.com", "azdevops-cli: default"]
    username = "Personal Access Token"
    azure_dir = Path(os.environ.get("AZURE_CONFIG_DIR", str(Path.home() / ".azure")))
    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read(azure_dir / "azuredevops" / "personalAccessTokens", encoding="utf-8")
    except configparser.Error as exc:
        raise AdoError("invalid Azure DevOps credential store") from exc
    for service in services:
        if sys.platform == "win32":
            value = windows_password(service, username)
            if value:
                return value
        else:
            command = None
            if sys.platform == "darwin":
                command = ["security", "find-generic-password", "-s", service, "-a", username, "-w"]
            elif shutil.which("secret-tool"):
                command = ["secret-tool", "lookup", "service", service, "username", username]
            if command:
                try:
                    result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=5)
                except (FileNotFoundError, subprocess.TimeoutExpired):
                    result = None
                if result and result.returncode == 0 and result.stdout.strip():
                    return result.stdout.rstrip("\r\n")
        if parser.has_option(service, username):
            return parser.get(service, username) or None
    return None


def windows_password(service: str, username: str) -> str | None:
    import ctypes
    from ctypes import wintypes

    class Credential(ctypes.Structure):
        _fields_ = [
            ("Flags", wintypes.DWORD), ("Type", wintypes.DWORD), ("TargetName", wintypes.LPWSTR),
            ("Comment", wintypes.LPWSTR), ("LastWritten", wintypes.FILETIME),
            ("CredentialBlobSize", wintypes.DWORD), ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
            ("Persist", wintypes.DWORD), ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
            ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR),
        ]

    library = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
    library.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                 ctypes.POINTER(ctypes.POINTER(Credential))]
    library.CredReadW.restype = wintypes.BOOL
    library.CredFree.argtypes = [ctypes.c_void_p]
    library.CredFree.restype = None
    for target in (service, f"{username}@{service}"):
        pointer = ctypes.POINTER(Credential)()
        if not library.CredReadW(target, 1, 0, ctypes.byref(pointer)):
            if ctypes.get_last_error() != 1168:
                raise AdoError("Windows credential store unavailable")
            continue
        try:
            if pointer.contents.UserName != username:
                continue
            raw = ctypes.string_at(pointer.contents.CredentialBlob, pointer.contents.CredentialBlobSize)
            try:
                return raw.decode("utf-16-le")
            except UnicodeDecodeError:
                try:
                    return raw.decode("utf-8")
                except UnicodeDecodeError as exc:
                    raise AdoError("invalid Windows credential encoding") from exc
        finally:
            library.CredFree(pointer)
    return None


def azure_cli_invocation(
    args: list[str],
    *,
    platform: str | None = None,
    find: Callable[[str], str | None] | None = None,
    exists: Callable[[str], bool] | None = None,
) -> list[str]:
    platform = platform or sys.platform
    find = find or shutil.which
    exists = exists or os.path.isfile
    executable = (find("az.exe") if platform == "win32" else None) or find("az")
    if not executable:
        raise AdoError("Azure CLI executable unavailable")
    if platform != "win32" or ntpath.splitext(executable)[1].lower() in (".exe", ".com"):
        return [executable, *args[1:]]
    if ntpath.splitext(executable)[1].lower() in (".cmd", ".bat"):
        python = ntpath.normpath(ntpath.join(ntpath.dirname(executable), "..", "python.exe"))
        if exists(python):
            return [python, "-X", "utf8", "-IBm", "azure.cli", *args[1:]]
    raise AdoError("Azure CLI for Windows requires a native executable or its bundled Python interpreter")


def authorization(org: str = "") -> str:
    pat = os.environ.get("AZURE_DEVOPS_EXT_PAT")
    if pat:
        return "Basic " + base64.b64encode((":" + pat).encode()).decode()
    try:
        result = subprocess.run(
            azure_cli_invocation(
                ["az", "account", "get-access-token", "--resource", "499b84ac-1321-427f-aa17-267ca6975798",
                 "--query", "accessToken", "-o", "tsv"],
            ),
            capture_output=True, text=True, encoding="utf-8", errors="replace", check=False, timeout=30,
        )
    except (AdoError, OSError, subprocess.TimeoutExpired):
        result = None
    if result and result.returncode == 0 and result.stdout.strip():
        return "Bearer " + result.stdout.strip()
    pat = stored_pat(org) if org else None
    if pat:
        return "Basic " + base64.b64encode((":" + pat).encode()).decode()
    raise AdoError("Azure CLI token unavailable; sign in or set AZURE_DEVOPS_EXT_PAT")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        raise AdoError("Azure DevOps redirect rejected")


@dataclass(frozen=True)
class Response:
    status: int
    headers: dict[str, str]
    body: bytes


def send_http(url: str, method: str, body: bytes | None, headers: dict[str, str], *,
              timeout: float = 30, timer: Callable[[], float] = time.monotonic) -> Response:
    deadline = timer() + timeout
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        response = opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        headers = {key.lower(): val for key, val in response.headers.items()}
        if not 200 <= response.code < 300:
            return Response(response.code, headers, b"")
        data = bytearray()
        while len(data) <= 8 * 1024 * 1024:
            if timer() >= deadline:
                raise TimeoutError("HTTP response deadline exceeded")
            chunk = response.read1(min(65536, 8 * 1024 * 1024 + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > 8 * 1024 * 1024:
            raise AdoError("response exceeds 8388608 bytes", code="response_too_large")
        return Response(response.code, headers, bytes(data))


class FileLock:

    def __init__(self, path: Path):
        self.file = path.open("a+b")
        try:
            os.chmod(path, 0o600)
        except OSError:
            self.file.close()
            raise
        # Both OS lock APIs support empty files; writes can collide with a Windows byte lock.
        self.held = False

    def acquire(self) -> bool:
        if os.name == "nt":
            import msvcrt
            self.file.seek(0)
            try:
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                return False
        else:
            import fcntl
            try:
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return False
        self.held = True
        return True

    def close(self) -> None:
        if self.held:
            if os.name == "nt":
                import msvcrt
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
        self.file.close()


class State:
    def __init__(self, directory: Path | None = None, *, clock: Callable[[], float] = time.time,
                 sleep: Callable[[float], None] = time.sleep):
        configured = os.environ.get("ADO_STATE_DIR")
        self.directory = directory or (Path(configured) if configured else Path.home() / ".cache/scarypilot/ado")
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)
        self.clock, self.sleep = clock, sleep
        self.path = self.directory / "state.sqlite3"
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS cooldown(org TEXT PRIMARY KEY, until REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS admission(org TEXT, slot INTEGER, owner TEXT, started REAL,
                    PRIMARY KEY(org, slot));
                CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, payload BLOB, accessed REAL);
                CREATE TABLE IF NOT EXISTS journal(scope TEXT, key TEXT, phase TEXT, payload TEXT,
                    receipt TEXT, PRIMARY KEY(scope, key));
            """)
        os.chmod(self.path, 0o600)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        try:
            db = sqlite3.connect(self.path, timeout=30)
        except sqlite3.Error as exc:
            raise AdoError("coordination database unavailable") from exc
        try:
            db.execute("PRAGMA busy_timeout=30000")
            with db:
                yield db
        except sqlite3.Error as exc:
            raise AdoError("coordination database operation failed") from exc
        finally:
            db.close()

    def cooldown(self, org: str) -> float:
        with self.connect() as db:
            row = db.execute("SELECT until FROM cooldown WHERE org=?", (org,)).fetchone()
        return float(row[0]) if row else 0

    def throttle(self, org: str, until: float) -> None:
        with self.connect() as db:
            db.execute("INSERT INTO cooldown VALUES(?,?) ON CONFLICT(org) DO UPDATE SET until=max(until,excluded.until)",
                       (org, until))

    @contextmanager
    def lock(self, key: str, wait: float = 30) -> Iterator[None]:
        lock = FileLock(self.directory / (hashlib.sha256(key.encode()).hexdigest() + ".lock"))
        deadline = self.clock() + wait
        try:
            while not lock.acquire():
                if self.clock() >= deadline:
                    raise AdoError("another process still owns this operation")
                self.sleep(0.05)
            yield
        finally:
            lock.close()

    @contextmanager
    def admit(self, org: str, deadline: float, *, check_budget: Callable[[], None] | None = None,
              budget_remaining: Callable[[], float | None] | None = None) -> Iterator[None]:
        owner = uuid.uuid4().hex
        chosen: tuple[int, FileLock] | None = None
        try:
            while chosen is None:
                if check_budget:
                    check_budget()
                delay = self.cooldown(org) - self.clock()
                if delay > 0:
                    remaining = budget_remaining() if budget_remaining else None
                    if self.clock() + delay > deadline or (remaining is not None and delay > remaining):
                        raise Deferred(self.cooldown(org))
                    self.sleep(delay)
                    continue
                for slot in range(4):
                    lock = FileLock(self.directory / f"admit-{org}-{slot}.lock")
                    if lock.acquire():
                        try:
                            with self.connect() as db:
                                db.execute("BEGIN IMMEDIATE")
                                row = db.execute("SELECT until FROM cooldown WHERE org=?", (org,)).fetchone()
                                if row and row[0] > self.clock():
                                    lock.close()
                                    break
                                db.execute("INSERT OR REPLACE INTO admission VALUES(?,?,?,?)",
                                           (org, slot, owner, self.clock()))
                        except AdoError:
                            lock.close()
                            raise
                        chosen = slot, lock
                        break
                    lock.close()
                if chosen is None:
                    if self.clock() >= deadline:
                        raise AdoError("organization admission wait exceeded")
                    self.sleep(0.05)
            yield
        finally:
            if chosen:
                slot, lock = chosen
                try:
                    with self.connect() as db:
                        db.execute("DELETE FROM admission WHERE org=? AND slot=? AND owner=?", (org, slot, owner))
                finally:
                    lock.close()


def retry_delay(value: str | None, now: float) -> float | None:
    if not value:
        return None
    try:
        delay = float(value)
        return max(0, delay) if math.isfinite(delay) else None
    except ValueError:
        try:
            date = parsedate_to_datetime(value)
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone.utc)
            return max(0, date.timestamp() - now)
        except (ValueError, TypeError, OverflowError):
            return None


def header_number(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) and number >= 0 else None
    except ValueError:
        return None


def quota_reset(value: str | None, now: float) -> float | None:
    number = header_number(value)
    if number is not None:
        return number if number > now else None
    if not value:
        return None
    try:
        date = parsedate_to_datetime(value)
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        timestamp = date.timestamp()
        return timestamp if math.isfinite(timestamp) and timestamp > now else None
    except (ValueError, TypeError, OverflowError):
        return None


def route_category(url: str) -> str:
    segments = [part for part in urllib.parse.urlsplit(url).path.lower().split("/") if part]
    if len(segments) > 2 and segments[2] == "_apis":
        route = segments[3:]
    elif len(segments) > 1 and segments[1] == "_apis":
        route = segments[2:]
    else:
        return "other"
    if route[:2] == ["search", "workitemsearchresults"]:
        return "workItemSearch"
    if route[:2] == ["wit", "wiql"]:
        return "workItemQuery"
    if route[:1] == ["wit"]:
        return "workItems"
    if route[:2] == ["build", "builds"]:
        return "builds"
    if route[:2] == ["policy", "evaluations"]:
        return "policies"
    if route[:2] == ["git", "pullrequests"]:
        return "pullRequest"
    if route[:2] == ["git", "repositories"]:
        endpoint = route[3:]
        if endpoint[:1] == ["items"]:
            return "items"
        if endpoint[:1] == ["pullrequests"]:
            nested = endpoint[2:]
            if nested[:1] == ["iterations"]:
                return "changes" if nested[2:3] == ["changes"] else "iterations"
            if nested[:1] == ["threads"]:
                return "threads"
            if nested[:1] == ["labels"]:
                return "labels"
            return "pullRequest"
    return "other"


class Transport:
    def __init__(self, state: State | None = None, *, auth: Callable[[], str] | None = None,
                 send: Callable[[str, str, bytes | None, dict[str, str]], Response] = send_http,
                 jitter: Callable[[], float] = random.random, timer: Callable[[], float] | None = None):
        self.state = state or State()
        self.auth, self.send = auth, send
        self.credentials: dict[str, str] = {}
        self.jitter = jitter
        self.timer = timer or (time.monotonic if self.state.clock is time.time else self.state.clock)
        self.deadline: ContextVar[float | None] = ContextVar("ado_read_deadline", default=None)
        self.diagnostics = os.environ.get("ADO_REQUEST_DIAGNOSTICS") == "1"

    def check_budget(self) -> None:
        remaining = self.budget_remaining()
        if remaining is not None and remaining <= 0:
            raise AdoError("incomplete read: total operation deadline exceeded", code="incomplete_read")

    def budget_remaining(self) -> float | None:
        deadline = self.deadline.get()
        return deadline - self.timer() if deadline is not None else None

    @contextmanager
    def budget(self, seconds: float) -> Iterator[None]:
        deadline = self.timer() + seconds
        outer = self.deadline.get()
        token = self.deadline.set(min(deadline, outer) if outer is not None else deadline)
        try:
            self.check_budget()
            yield
            self.check_budget()
        finally:
            self.deadline.reset(token)

    def diagnostic(self, record: dict[str, str | int | float | bool | None]) -> None:
        if self.diagnostics:
            print(json.dumps({"type": "ado_request_diagnostic", **record}), file=sys.stderr)

    def credential(self, org: str) -> str:
        if org not in self.credentials:
            self.credentials[org] = self.auth() if self.auth else authorization(org)
        return self.credentials[org]

    def request(self, url: str, method: str = "GET", body: bytes | None = None,
                headers: dict[str, str] | None = None, *,
                before_send: Callable[[], None] | None = None, replay_safe: bool = False) -> Response:
        org, url = canonical_url(url)
        self.check_budget()
        deadline = self.state.clock() + 30
        remaining = self.budget_remaining()
        if remaining is not None:
            deadline = min(deadline, self.state.clock() + remaining)
        method = method.upper()
        safe_read = method == "GET" or replay_safe
        if before_send and safe_read:
            raise AdoError("write journaling cannot be attached to a replay-safe read")
        supplied = {key.lower(): value for key, value in (headers or {}).items()}
        if supplied.keys() & {"host", "proxy-authorization", "cookie"}:
            raise AdoError("unsafe request headers")
        if "authorization" not in supplied:
            supplied["authorization"] = self.credential(org)
        supplied.setdefault("accept", "application/json")
        if any(ord(char) < 32 or ord(char) == 127
               for key, value in supplied.items() for char in key + value):
            raise AdoError("invalid request headers")
        self.check_budget()
        attempts = 3 if safe_read else 1
        for attempt in range(attempts):
            self.check_budget()
            if self.state.clock() >= deadline:
                raise AdoError("HTTP read retry budget exceeded")
            waiting_since = self.timer()
            with self.state.admit(org, deadline, check_budget=self.check_budget, budget_remaining=self.budget_remaining):
                self.check_budget()
                if self.state.clock() >= deadline:
                    raise AdoError("HTTP request budget exceeded")
                admitted_at = self.timer()
                if before_send:
                    before_send()
                sent_at = self.timer()
                has_response = True
                try:
                    remaining = self.budget_remaining()
                    timeout = min(30, deadline - self.state.clock(), remaining if remaining is not None else 30)
                    response = (send_http(url, method, body, supplied, timeout=max(0.001, timeout), timer=self.timer)
                                if self.send is send_http else self.send(url, method, body, supplied))
                except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, http.client.HTTPException) as exc:
                    if safe_read:
                        self.check_budget()
                    if not safe_read or attempt + 1 == attempts:
                        raise AdoError("HTTP read failed" if safe_read else "request outcome unknown") from exc
                    has_response = False
                    response = Response(503, {}, b"")
                delay = retry_delay(response.headers.get("retry-after"), self.state.clock())
                if delay is not None:
                    self.state.throttle(org, self.state.clock() + delay)
                elif response.status in (429, 502, 503, 504):
                    backoff = 2 ** attempt
                    if safe_read:
                        backoff *= 1 + 0.25 * max(0.0, min(1.0, self.jitter()))
                    self.state.throttle(org, self.state.clock() + backoff)
                remaining = header_number(response.headers.get("x-ratelimit-remaining"))
                reset = quota_reset(response.headers.get("x-ratelimit-reset"), self.state.clock())
                if remaining == 0 and reset is not None:
                    self.state.throttle(org, reset)
            cooldown = self.state.cooldown(org) if self.diagnostics else 0
            if has_response:
                self.diagnostic({
                    "source": "http",
                    "method": method if method in {"GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"} else "OTHER",
                    "status": response.status,
                    "attempt": attempt + 1,
                    "waitMs": max(0, round((admitted_at - waiting_since) * 1000)),
                    "durationMs": max(0, round((self.timer() - sent_at) * 1000)),
                    "retryAfterSeconds": delay,
                    "routeCategory": route_category(url),
                    "rateLimit": header_number(response.headers.get("x-ratelimit-limit")),
                    "rateRemaining": remaining,
                    "rateCost": header_number(response.headers.get("x-ratelimit-cost")),
                    "cooldownUntil": cooldown if cooldown > self.state.clock() else None,
                    "cacheHit": False,
                })
            if safe_read:
                self.check_budget()
                if self.state.clock() >= deadline:
                    raise AdoError("HTTP read retry budget exceeded")
            if 200 <= response.status < 300:
                return response
            if response.status not in (429, 502, 503, 504) or attempt + 1 == attempts:
                if not safe_read and 400 <= response.status < 500:
                    raise WriteRejected(response.status)
                raise AdoError(f"Azure DevOps HTTP {response.status}")
        raise AdoError("HTTP read retries exhausted")

    def json(self, url: str, method: str = "GET", body: bytes | None = None,
             headers: dict[str, str] | None = None, *, before_send: Callable[[], None] | None = None,
             replay_safe: bool = False) -> Any:
        response = self.request(url, method, body, headers, before_send=before_send, replay_safe=replay_safe)
        try:
            return json.loads(response.body) if response.body else {}
        except (ValueError, UnicodeDecodeError) as exc:
            raise AdoError("invalid Azure DevOps JSON response") from exc

    def immutable(self, url: str) -> Any:
        org, url = canonical_url(url)
        auth = self.credential(org)
        key = hashlib.sha256((auth + "\0" + url).encode()).hexdigest()
        with self.state.lock("cache:" + str(int(key[:8], 16) % IMMUTABLE_CACHE_LOCK_STRIPES)):
            with self.state.connect() as db:
                row = db.execute("SELECT payload FROM cache WHERE key=?", (key,)).fetchone()
                if row:
                    db.execute("UPDATE cache SET accessed=? WHERE key=?", (self.state.clock(), key))
                    try:
                        payload = json.loads(row[0])
                    except (ValueError, UnicodeDecodeError) as exc:
                        raise AdoError("invalid cached item JSON") from exc
                    self.diagnostic({"source": "cache", "routeCategory": "items", "cacheHit": True})
                    return payload
            try:
                payload = self.json(url, headers={"Authorization": auth})
            except AdoError as exc:
                if exc.code == "response_too_large":
                    raise AdoError("item response exceeds 8388608 bytes", code="content_too_large") from exc
                raise
            if not isinstance(payload, dict):
                raise AdoError("item response must be an object")
            content = payload.get("content")
            if content is not None:
                if not isinstance(content, str):
                    raise AdoError("item content must be a string")
                try:
                    size = len(content.encode())
                except UnicodeEncodeError as exc:
                    raise AdoError("invalid item content encoding") from exc
                if size > 2 * 1024 * 1024:
                    raise AdoError("item content exceeds 2097152 bytes", code="content_too_large")
            encoded = json.dumps(payload).encode()
            if len(encoded) > 8 * 1024 * 1024:
                raise AdoError("item JSON exceeds 8388608 bytes", code="content_too_large")
            with self.state.connect() as db:
                db.execute("INSERT OR REPLACE INTO cache VALUES(?,?,?)", (key, encoded, self.state.clock()))
                while True:
                    count, size = db.execute("SELECT count(*),coalesce(sum(length(payload)),0) FROM cache").fetchone()
                    if count <= 256 and size <= 64 * 1024 * 1024:
                        break
                    db.execute("DELETE FROM cache WHERE key=(SELECT key FROM cache ORDER BY accessed,key LIMIT 1)")
            return payload
