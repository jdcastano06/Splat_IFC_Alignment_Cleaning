"""Keep the SMART_vault SMB share mounted.

Credentials come from the repo-root `.env` (gitignored):

    VAULT_HOST=10.224.16.61
    VAULT_SHARE=SMART_vault
    VAULT_USER=...
    VAULT_PASSWORD=...
    VAULT_MOUNT=~/SMART_vault_mnt        # optional; this is the default

The share drops on sleep / network changes, so `ensure_mounted()` is cheap to call before any
vault access (it only shells out when the mount is actually missing, and rate-limits retries),
and `start_watchdog()` re-mounts in the background so the next request finds it already up.
"""

from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import quote

RETRY_EVERY_S = 15      # min gap between mount attempts, so a dead NAS isn't hammered per request
WATCHDOG_EVERY_S = 30
MOUNT_TIMEOUT_S = 30

_lock = threading.Lock()
_last_attempt = 0.0
last_error: str | None = None


def load_env(path: Path) -> None:
    """Minimal .env reader: KEY=VALUE lines, # comments, optional quotes. Never overrides the
    real environment, so `SPLAT_ROOT=... uvicorn ...` still wins."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        os.environ.setdefault(k.strip(), v)


def mount_point() -> Path:
    return Path(os.path.expanduser(os.environ.get("VAULT_MOUNT", "~/SMART_vault_mnt")))


def configured() -> bool:
    return all(os.environ.get(k) for k in ("VAULT_HOST", "VAULT_SHARE", "VAULT_USER", "VAULT_PASSWORD"))


def is_mounted(mp: Path | None = None) -> bool:
    mp = (mp or mount_point()).resolve()
    try:
        out = subprocess.run(["mount"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return False
    return any(f" on {mp} (" in line for line in out.splitlines())


def _mount() -> None:
    global last_error
    mp = mount_point()
    mp.mkdir(parents=True, exist_ok=True)
    url = "//{}:{}@{}/{}".format(
        quote(os.environ["VAULT_USER"], safe=""), quote(os.environ["VAULT_PASSWORD"], safe=""),
        os.environ["VAULT_HOST"], quote(os.environ["VAULT_SHARE"], safe=""))
    try:
        r = subprocess.run(["mount_smbfs", "-N", url, str(mp)],
                           capture_output=True, text=True, timeout=MOUNT_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        last_error = f"mount timed out after {MOUNT_TIMEOUT_S}s"
        return
    if r.returncode != 0 and not is_mounted(mp):
        # Never echo the URL: it carries the password.
        last_error = (r.stderr or r.stdout).strip() or f"mount_smbfs exit {r.returncode}"
    else:
        last_error = None
        print(f"[vault] mounted {os.environ['VAULT_SHARE']} at {mp}", flush=True)


def ensure_mounted(force: bool = False) -> bool:
    """Mount the share if it isn't. Returns whether it is mounted afterwards."""
    global _last_attempt, last_error
    if not configured():
        return is_mounted()
    if is_mounted():
        return True
    with _lock:
        if is_mounted():
            return True
        if not force and time.monotonic() - _last_attempt < RETRY_EVERY_S:
            return False
        _last_attempt = time.monotonic()
        print("[vault] share not mounted — mounting…", flush=True)
        _mount()
        if last_error:
            print(f"[vault] mount failed: {last_error}", flush=True)
        return is_mounted()


def start_watchdog() -> None:
    if not configured():
        return

    def loop():
        while True:
            try:
                ensure_mounted()
            except Exception as e:  # keep the watchdog alive whatever happens
                print(f"[vault] watchdog error: {e}", flush=True)
            time.sleep(WATCHDOG_EVERY_S)

    threading.Thread(target=loop, name="vault-watchdog", daemon=True).start()
