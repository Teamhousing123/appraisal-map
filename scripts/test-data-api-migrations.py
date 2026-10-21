"""Replay migrations only in a fresh, disposable local PostgreSQL database.

Usage: python scripts/test-data-api-migrations.py
Set PGHOST=127.0.0.1, PGPORT, PGUSER, PGPASSWORD, PGDATABASE=appraisal_api_test.
The database must be empty. psql must be on PATH. Never uses application secrets.
"""
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def psql(*args):
    return subprocess.run(
        ["psql", "-X", "-v", "ON_ERROR_STOP=1", *args],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def main():
    if os.environ.get("PGHOST") not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("Refusing non-local test host.")
    if os.environ.get("PGDATABASE") != "appraisal_api_test":
        raise SystemExit("Use the dedicated empty appraisal_api_test database.")
    # Reject service URLs and application credentials supplied through libpq.
    if any(os.environ.get(key) for key in ("PGSERVICE", "PGSERVICEFILE", "PGOPTIONS", "PGHOSTADDR")):
        raise SystemExit("Remove libpq service/options overrides before testing.")
    if psql("-Atc", "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth','storage')") != "0":
        raise SystemExit("Refusing a non-empty database.")
    files = [ROOT / "supabase/tests/platform_fixture.sql"]
    files += sorted((ROOT / "supabase/migrations").glob("*.sql"))
    # A late application of the backdated baseline must preserve existing grants.
    files += [ROOT / "supabase/migrations/20260729000100_create_appraisals.sql",
              ROOT / "supabase/migrations/20261021000100_explicit_api_schema_usage.sql"]
    files += [ROOT / "supabase/tests/data_api_permissions.integration.sql",
              ROOT / "supabase/tests/primary_facts.integration.sql",
              ROOT / "supabase/tests/lot_frontage_status.integration.sql"]
    for path in files:
        try:
            psql("-f", str(path))
        except subprocess.CalledProcessError as error:
            raise SystemExit(f"Failed: {path.name}\n{error.stderr}") from error
        print(f"PASS {path.name}", flush=True)


if __name__ == "__main__":
    main()
