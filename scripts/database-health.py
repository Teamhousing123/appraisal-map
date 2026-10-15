"""Read-only Supabase probe and GitHub schedule watchdog. No dependencies."""

import json
import os
import ssl
import sys
import time
from datetime import datetime, timedelta, timezone
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

RETRY_DELAYS = (5, 15, 30)
REQUEST_TIMEOUT = 40
MAX_SUCCESS_AGE = timedelta(hours=10)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward credentials to a redirect target.


OPEN = build_opener(NoRedirect()).open


class ProbeError(Exception):
    def __init__(self, message, retryable=False):
        super().__init__(message)
        self.retryable = retryable


def probe(url, key, opener=OPEN):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ("", "/")):
        raise ProbeError("SUPABASE_URL must be an HTTPS project origin.")
    if not key.strip():
        raise ProbeError("SUPABASE_ANON_KEY is missing.")
    request = Request(
        url.rstrip("/") + "/rest/v1/rpc/appraisal_health_check",
        data=b"{}", method="POST",
        headers={"apikey": key, "Content-Type": "application/json"},
    )
    try:
        with opener(request, timeout=REQUEST_TIMEOUT) as response:
            payload = response.read(4097)
            if response.status != 200 or len(payload) > 4096:
                raise ProbeError("Database health response was invalid.")
            try:
                healthy = json.loads(payload) is True
            except (ValueError, UnicodeError):
                healthy = False
            if not healthy:
                raise ProbeError("Database health RPC did not return JSON true.")
    except HTTPError as error:
        status = error.code
        error.close()
        if status == 402:
            raise ProbeError(
                "HTTP 402: Supabase has restricted this project. Review the "
                "organization billing/usage restriction. Runner retries cannot "
                "lift provider quota restrictions."
            ) from None
        raise ProbeError(
            f"Database health request returned HTTP {status}.",
            status in (408, 425, 429) or 500 <= status <= 599,
        ) from None
    except (URLError, TimeoutError, OSError, HTTPException) as error:
        certificate_error = isinstance(getattr(error, "reason", error), ssl.SSLCertVerificationError)
        raise ProbeError("Database health connection failed.", not certificate_error) from None


def ping(url, key, check=probe, sleep=time.sleep, log=print):
    for attempt in range(len(RETRY_DELAYS) + 1):
        try:
            check(url, key)
            log("Database health check passed.")
            return
        except ProbeError as error:
            log(f"Attempt {attempt + 1}: {error}")
            if not error.retryable or attempt == len(RETRY_DELAYS):
                raise
            sleep(RETRY_DELAYS[attempt])


def probe_required(runs, now, branch):
    if not isinstance(runs, list):
        return True
    for run in runs:
        if not isinstance(run, dict):
            continue
        if (run.get("conclusion") != "success" or run.get("status") != "completed"
                or run.get("head_branch") != branch
                or run.get("event") not in ("schedule", "workflow_dispatch")):
            continue
        try:
            timestamp = run.get("updated_at")
            if not isinstance(timestamp, str):
                continue
            completed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            age = now - completed
        except (KeyError, TypeError, ValueError):
            continue
        if timedelta(0) <= age < MAX_SUCCESS_AGE:
            return False
    return True


def watchdog(repository, token, branch, opener=OPEN, now=None, log=print):
    # Only the primary workflow counts. A skipped watchdog must never count as
    # proof of a successful database request.
    query = urlencode({"status": "success", "branch": branch, "per_page": 100})
    request = Request(
        f"https://api.github.com/repos/{repository}/actions/workflows/keep-alive.yml/runs?{query}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28"},
    )
    try:
        with opener(request, timeout=20) as response:
            runs = json.load(response)["workflow_runs"]
        required = probe_required(runs, now or datetime.now(timezone.utc), branch)
    except (OSError, ValueError, KeyError, TypeError, HTTPException):
        log("Workflow history unavailable; the watchdog will probe the database.")
        return True
    log("No recent primary success; backup probe required." if required
        else "Primary database probe succeeded recently; backup probe skipped.")
    return required


def output(name, value):
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as handle:
        handle.write(f"{name}={value}\n")


def main():
    try:
        if sys.argv[1:] == ["ping"]:
            ping(os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_ANON_KEY", ""))
            if os.environ.get("GITHUB_OUTPUT"):
                output("healthy", "true")
        elif sys.argv[1:] == ["watchdog"]:
            required = watchdog(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"],
                                os.environ["DEFAULT_BRANCH"])
            output("required", str(required).lower())
        else:
            raise ProbeError("Usage: database-health.py ping|watchdog")
    except (ProbeError, KeyError) as error:
        print(f"::error::{error}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
