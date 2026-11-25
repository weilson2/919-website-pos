"""Read-only go-live checks for the 919 web POS.

This tool never creates, migrates, or edits business records.  It is intended
to be run before a live shift and again before enabling LAN/private-network
access.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
REQUIRED_SCHEMA_VERSION = 9


@dataclass
class Result:
    level: str
    name: str
    detail: str


def readonly_connection(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=5)


def public_status(base_url: str) -> dict:
    request = Request(
        f"{base_url.rstrip('/')}/api/public/status",
        headers={"Accept": "application/json"},
        method="GET",
    )
    with urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Run read-only 919 POS go-live checks.")
    parser.add_argument(
        "--database",
        type=Path,
        default=Path(os.environ.get("POS_DB_PATH", ROOT / "pos.db")),
        help="Live SQLite database path.",
    )
    parser.add_argument(
        "--backup-dir",
        type=Path,
        default=Path(os.environ.get("POS_BACKUP_DIR", ROOT / "backups")),
        help="Verified backup directory.",
    )
    parser.add_argument(
        "--url",
        default="http://127.0.0.1:8000",
        help="Running POS base URL.",
    )
    parser.add_argument(
        "--remote",
        action="store_true",
        help="Treat missing remote-access security as a go-live failure.",
    )
    args = parser.parse_args()

    database = args.database.resolve()
    backup_dir = args.backup_dir.resolve()
    results: list[Result] = []

    def add(level: str, name: str, detail: str) -> None:
        results.append(Result(level, name, detail))

    if not database.is_file():
        add("FAIL", "Database", f"Not found: {database}")
    else:
        try:
            with readonly_connection(database) as connection:
                integrity = str(connection.execute("PRAGMA quick_check").fetchone()[0])
                if integrity.lower() == "ok":
                    add("PASS", "Database integrity", "SQLite quick_check returned ok")
                else:
                    add("FAIL", "Database integrity", integrity)

                version = int(
                    connection.execute(
                        "SELECT COALESCE(MAX(version),0) FROM web_schema_meta"
                    ).fetchone()[0]
                )
                level = "PASS" if version >= REQUIRED_SCHEMA_VERSION else "FAIL"
                add(level, "Schema", f"version {version}; required {REQUIRED_SCHEMA_VERSION}")

                journal = str(connection.execute("PRAGMA journal_mode").fetchone()[0]).upper()
                add("PASS" if journal == "WAL" else "WARN", "Journal mode", journal)

                active_tables = int(
                    connection.execute(
                        "SELECT COUNT(*) FROM dining_tables WHERE active=1"
                    ).fetchone()[0]
                )
                active_items = int(
                    connection.execute("SELECT COUNT(*) FROM items WHERE active=1").fetchone()[0]
                )
                unpaid_orders = int(
                    connection.execute(
                        "SELECT COUNT(*) FROM held_orders WHERE status IN ('OPEN','HELD')"
                    ).fetchone()[0]
                )
                add(
                    "INFO",
                    "Live records",
                    f"{active_tables} active tables, {active_items} active items, "
                    f"{unpaid_orders} unpaid orders",
                )

                duplicate_pins = connection.execute(
                    """SELECT pin,COUNT(*) FROM staff
                       WHERE active=1 GROUP BY pin HAVING COUNT(*)>1"""
                ).fetchall()
                if duplicate_pins:
                    add("FAIL", "Staff PINs", "Duplicate active PINs exist")
                else:
                    roles = connection.execute(
                        """SELECT role,COUNT(*) FROM staff
                           WHERE active=1 GROUP BY role ORDER BY role"""
                    ).fetchall()
                    role_text = ", ".join(f"{role}: {count}" for role, count in roles)
                    add("PASS", "Staff PINs", f"Unique for active staff ({role_text})")
        except sqlite3.Error as error:
            add("FAIL", "Database read", str(error))

        free_bytes = shutil.disk_usage(database.parent).free
        free_gib = free_bytes / (1024 ** 3)
        add(
            "PASS" if free_gib >= 2 else "WARN",
            "Free disk space",
            f"{free_gib:.1f} GiB available on {database.drive or database.anchor}",
        )

    backups = sorted(
        (path for path in backup_dir.glob("*.db") if path.is_file()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    ) if backup_dir.is_dir() else []
    if not backups:
        add("FAIL", "Verified backup", f"No .db backup found in {backup_dir}")
    else:
        newest = backups[0]
        age_hours = (
            datetime.now(timezone.utc).timestamp() - newest.stat().st_mtime
        ) / 3600
        try:
            with readonly_connection(newest) as backup_connection:
                backup_integrity = str(
                    backup_connection.execute("PRAGMA quick_check").fetchone()[0]
                )
            level = "PASS" if backup_integrity.lower() == "ok" and age_hours <= 24 else "WARN"
            add(
                level,
                "Verified backup",
                f"{newest.name}, {age_hours:.1f} hours old, quick_check={backup_integrity}",
            )
        except sqlite3.Error as error:
            add("FAIL", "Verified backup", f"Cannot verify {newest.name}: {error}")

        if database.drive and database.drive.lower() == backup_dir.drive.lower():
            add(
                "WARN",
                "Off-device backup",
                "Live database and backup folder are on the same drive; copy backups to "
                "another encrypted device or cloud location.",
            )
        else:
            add("PASS", "Off-device backup", f"Backup directory: {backup_dir}")

    try:
        status = public_status(args.url)
        add("PASS", "Web service", f"Online at {args.url} ({status.get('shop_name', 'POS')})")
        if status.get("admin_password_required"):
            add("PASS", "Admin password", "Strong-password challenge is enabled")
        else:
            level = "FAIL" if args.remote else "WARN"
            add(
                level,
                "Admin password",
                "Not configured; local testing is allowed, but LAN/KL access must stay disabled",
            )
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        add("FAIL", "Web service", f"Cannot read {args.url}: {error}")

    labels = {"PASS": "[PASS]", "WARN": "[WARN]", "FAIL": "[FAIL]", "INFO": "[INFO]"}
    print(f"919 POS readiness report\nDatabase: {database}\n")
    for result in results:
        print(f"{labels[result.level]} {result.name}: {result.detail}")

    failures = sum(result.level == "FAIL" for result in results)
    warnings = sum(result.level == "WARN" for result in results)
    print(f"\nResult: {failures} failure(s), {warnings} warning(s)")
    if failures:
        print("NOT READY: resolve every failure before go-live.")
        return 2
    if args.remote and warnings:
        print("REMOTE CHECK: review warnings before enabling off-site access.")
    else:
        print("LOCAL CHECK PASSED: review warnings before the first live shift.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
