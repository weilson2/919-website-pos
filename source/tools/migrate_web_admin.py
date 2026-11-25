"""Back up, migrate, and verify the configured 919 POS database."""

from __future__ import annotations

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import web_server  # noqa: E402


def main() -> None:
    if not web_server.DB_PATH.exists():
        raise SystemExit(f"Database not found: {web_server.DB_PATH}")
    backup = web_server.create_database_backup("pos-pre-migration")
    web_server.ensure_web_schema()
    with web_server.connect() as connection:
        integrity = connection.execute("PRAGMA quick_check").fetchone()[0]
        version = int(connection.execute("SELECT COALESCE(MAX(version),0) FROM web_schema_meta").fetchone()[0])
    if str(integrity).lower() != "ok":
        raise SystemExit(f"Migration integrity check failed: {integrity}. Restore {backup}")
    print(f"Web migration complete: {web_server.DB_PATH}")
    print(f"Schema version: {version}")
    print(f"Verified pre-migration backup: {backup}")


if __name__ == "__main__":
    main()
