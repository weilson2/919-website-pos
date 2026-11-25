"""Local role-aware web server for the 919 POS and admin workspaces.

The server intentionally uses only the Python standard library for HTTP and the
existing SQLite database. Excel exports use the project's existing openpyxl
dependency.
"""

from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import base64
import binascii
import hashlib
import hmac
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import sqlite3
import sys
import threading
import time
from urllib.parse import parse_qs, urlparse
import zipfile

from category_list_prices import LIST_PRICE, ensure_list_price_columns, list_prices_for_sale


ROOT = Path(__file__).resolve().parent
WEB_SCHEMA_VERSION = 10
WEB_ROOT = ROOT / "web_prototype"
DB_PATH = Path(os.environ.get("POS_DB_PATH", ROOT / "pos.db")).resolve()
BACKUP_DIR = Path(os.environ.get("POS_BACKUP_DIR", ROOT / "backups")).resolve()
ITEM_IMAGE_DIR = WEB_ROOT / "uploads" / "items"
SESSION_TTL_SECONDS = int(os.environ.get("POS_SESSION_IDLE_SECONDS", 12 * 60 * 60))
ADMIN_SESSION_TTL_SECONDS = int(os.environ.get("POS_ADMIN_IDLE_SECONDS", 30 * 60))
SESSION_MAX_AGE_SECONDS = int(os.environ.get("POS_SESSION_MAX_AGE_SECONDS", 24 * 60 * 60))
SESSIONS: dict[str, dict] = {}
SESSION_LOCK = threading.Lock()
PAYMENT_AUTH_TTL_SECONDS = 5 * 60
PAYMENT_AUTHORIZATIONS: dict[str, dict] = {}
PAYMENT_AUTH_LOCK = threading.Lock()
AUTH_FAILURES: dict[str, dict] = {}
AUTH_FAILURE_LOCK = threading.Lock()
AUTH_FAILURE_WINDOW_SECONDS = int(os.environ.get("POS_AUTH_FAILURE_WINDOW_SECONDS", 5 * 60))
AUTH_MAX_FAILURES = int(os.environ.get("POS_AUTH_MAX_FAILURES", 5))
AUTH_LOCK_SECONDS = int(os.environ.get("POS_AUTH_LOCK_SECONDS", 60))
ADMIN_PASSWORD = os.environ.get("POS_ADMIN_PASSWORD", "")
ADMIN_PASSWORD_HASH = os.environ.get("POS_ADMIN_PASSWORD_HASH", "")
BUSINESS_DAY_START_MINUTES = 6 * 60

ROLE_MODES = {
    "order": {"order"},
    "cashier": {"order", "cashier"},
    "supervisor": {"order", "cashier"},
    # Admin is intentionally isolated for safe remote management.  Use a
    # cashier account at the physical counter instead of opening POS screens
    # from a remote owner session.
    "admin": {"admin"},
}


class APIError(Exception):
    def __init__(self, status: int, message: str, details: dict | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.details = details or {}


def configured_admin_password() -> bool:
    return bool(ADMIN_PASSWORD or ADMIN_PASSWORD_HASH)


def verify_admin_password(candidate: str) -> bool:
    value = str(candidate or "")
    if ADMIN_PASSWORD_HASH:
        try:
            algorithm, iterations, salt_hex, expected_hex = ADMIN_PASSWORD_HASH.split("$", 3)
            if algorithm != "pbkdf2_sha256":
                return False
            derived = hashlib.pbkdf2_hmac(
                "sha256", value.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
            ).hex()
            return hmac.compare_digest(derived, expected_hex)
        except (ValueError, TypeError):
            return False
    return bool(ADMIN_PASSWORD) and hmac.compare_digest(value, ADMIN_PASSWORD)


def auth_limit_check(key: str) -> None:
    now = time.time()
    with AUTH_FAILURE_LOCK:
        record = AUTH_FAILURES.get(key)
        if not record:
            return
        if float(record.get("locked_until", 0)) > now:
            wait = max(1, int(float(record["locked_until"]) - now) + 1)
            raise APIError(429, f"Too many incorrect attempts. Try again in {wait} seconds.", {"retry_after": wait})
        failures = [stamp for stamp in record.get("failures", []) if stamp >= now - AUTH_FAILURE_WINDOW_SECONDS]
        if failures:
            record["failures"] = failures
        else:
            AUTH_FAILURES.pop(key, None)


def auth_limit_failure(key: str) -> None:
    now = time.time()
    with AUTH_FAILURE_LOCK:
        record = AUTH_FAILURES.setdefault(key, {"failures": [], "locked_until": 0})
        record["failures"] = [
            stamp for stamp in record["failures"] if stamp >= now - AUTH_FAILURE_WINDOW_SECONDS
        ]
        record["failures"].append(now)
        if len(record["failures"]) >= AUTH_MAX_FAILURES:
            record["locked_until"] = now + AUTH_LOCK_SECONDS


def auth_limit_success(key: str) -> None:
    with AUTH_FAILURE_LOCK:
        AUTH_FAILURES.pop(key, None)


def is_loopback_host(host: str) -> bool:
    value = str(host or "").strip().strip("[]").lower()
    if value in {"localhost", ""}:
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def set_business_day_start(value: str) -> None:
    global BUSINESS_DAY_START_MINUTES
    match = re.fullmatch(r"([01]\d|2[0-3]):([0-5]\d)", str(value or ""))
    if match:
        BUSINESS_DAY_START_MINUTES = int(match.group(1)) * 60 + int(match.group(2))


def now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def now_audit() -> str:
    return datetime.now().strftime("%d-%m-%Y %H:%M:%S")


def business_date(moment: datetime | None = None) -> str:
    moment = moment or datetime.now()
    if moment.hour * 60 + moment.minute < BUSINESS_DAY_START_MINUTES:
        moment -= timedelta(days=1)
    return moment.strftime("%Y-%m-%d")


def month_shift(value: date, months: int) -> date:
    month_index = value.month - 1 + months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    day = min(value.day, monthrange(year, month)[1])
    return date(year, month, day)


def sale_business_date(value: str) -> str:
    """Return the 06:00-based business date for either legacy datetime format."""
    text = str(value or "").strip()
    for pattern in ("%d-%m-%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return business_date(datetime.strptime(text[:19], pattern))
        except ValueError:
            continue
    return business_date()


def apply_stock_for_order_items(
    connection: sqlite3.Connection,
    order_items: list,
    direction: int,
    source_type: str,
    reference_id: int,
    recorded_by: str,
    notes: str,
) -> None:
    """Apply stock for saved sale/refund item tuples, including variants and sets."""
    quantities: dict[str, int] = {}
    for item in order_items or []:
        if not isinstance(item, (list, tuple)) or len(item) < 3:
            continue
        name = str(item[0]).strip()
        try:
            quantity = int(item[2] or 0)
        except (TypeError, ValueError):
            quantity = 0
        if name and quantity > 0:
            quantities[name] = quantities.get(name, 0) + quantity

    resolved: dict[tuple[int, str], int] = {}
    for raw_name, quantity in quantities.items():
        multiplier = 1
        search_name = raw_name
        row = connection.execute(
            "SELECT id,name,track_stock FROM items WHERE name=?", (search_name,)
        ).fetchone()
        if not row and " Set(" in raw_name and raw_name.endswith(")"):
            marker = raw_name.rfind(" Set(")
            set_value = raw_name[marker + 5 : -1]
            if set_value.isdigit():
                multiplier = int(set_value)
            search_name = raw_name[:marker].strip()
            row = connection.execute(
                "SELECT id,name,track_stock FROM items WHERE name=?", (search_name,)
            ).fetchone()
        if not row and "(" in search_name and search_name.endswith(")"):
            base_name = search_name[: search_name.rfind("(")].strip()
            row = connection.execute(
                "SELECT id,name,track_stock FROM items WHERE name=?", (base_name,)
            ).fetchone()
        if row and int(row["track_stock"] or 0):
            key = (int(row["id"]), str(row["name"]))
            resolved[key] = resolved.get(key, 0) + quantity * multiplier

    for (item_id, item_name), quantity in resolved.items():
        stock_row = connection.execute("SELECT stock FROM items WHERE id=?", (item_id,)).fetchone()
        before = int(stock_row[0] or 0)
        delta = direction * quantity
        after = before + delta
        if after < 0:
            raise APIError(409, f"Insufficient stock for {item_name}.")
        connection.execute("UPDATE items SET stock=? WHERE id=?", (after, item_id))
        connection.execute(
            """INSERT INTO stock_movements
               (datetime,item_id,item_name,quantity_delta,stock_before,stock_after,
                source_type,reference_id,recorded_by,notes)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (now_audit(), item_id, item_name, delta, before, after, source_type,
             reference_id, recorded_by, notes),
        )


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=10000")
    connection.execute("PRAGMA synchronous=FULL")
    return connection


def load_shop_settings(connection: sqlite3.Connection | None = None) -> dict[str, str]:
    defaults = {
        "shop_name": "919 Restaurant", "currency": "RM", "business_day_start": "06:00",
        "language": "en", "backup_retention_days": "30", "receipt_footer": "Thank you",
        "business_registration_no": "", "business_address": "",
        "employer_epf_no": "", "employer_socso_no": "",
    }
    if connection is not None:
        rows = connection.execute(
            """SELECT key,value FROM app_settings
               WHERE key IN ('shop_name','currency','business_day_start','language','backup_retention_days',
                             'receipt_footer','business_registration_no','business_address',
                             'employer_epf_no','employer_socso_no')"""
        ).fetchall()
        defaults.update({str(row["key"]): str(row["value"] or "") for row in rows})
        return defaults
    with connect() as opened:
        return load_shop_settings(opened)


def create_database_backup(prefix: str = "pos-manual") -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup_path = BACKUP_DIR / f"{prefix}-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.db"
    image_archive = backup_path.with_name(f"{backup_path.stem}-item-images.zip")
    source = connect()
    destination = sqlite3.connect(backup_path)
    try:
        source.backup(destination)
        integrity = destination.execute("PRAGMA quick_check").fetchone()[0]
        if str(integrity).lower() != "ok":
            raise RuntimeError(f"Backup integrity check failed: {integrity}")
        destination.close()
        source.close()

        managed_images = []
        if ITEM_IMAGE_DIR.exists():
            image_root = ITEM_IMAGE_DIR.resolve()
            for candidate in ITEM_IMAGE_DIR.rglob("*"):
                if not candidate.is_file():
                    continue
                resolved = candidate.resolve()
                try:
                    relative = resolved.relative_to(image_root)
                except ValueError:
                    continue
                if resolved.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
                    managed_images.append((resolved, relative))
        if managed_images:
            with zipfile.ZipFile(image_archive, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for resolved, relative in managed_images:
                    archive.write(resolved, relative.as_posix())
            with zipfile.ZipFile(image_archive, "r") as archive:
                bad_file = archive.testzip()
                if bad_file:
                    raise RuntimeError(f"Item image backup verification failed: {bad_file}")
    except Exception:
        try:
            destination.close()
        except sqlite3.Error:
            pass
        try:
            source.close()
        except sqlite3.Error:
            pass
        backup_path.unlink(missing_ok=True)
        image_archive.unlink(missing_ok=True)
        raise
    return backup_path


def automatic_startup_backup() -> Path | None:
    if os.environ.get("POS_AUTO_BACKUP", "1") == "0":
        return None
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    interval_hours = max(1, int(os.environ.get("POS_BACKUP_INTERVAL_HOURS", "12")))
    retention_value = os.environ.get("POS_BACKUP_RETENTION_DAYS")
    if retention_value is None:
        try:
            with connect() as connection:
                has_settings = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'"
                ).fetchone()
                row = connection.execute(
                    "SELECT value FROM app_settings WHERE key='backup_retention_days'"
                ).fetchone() if has_settings else None
                retention_value = str(row[0]) if row else "30"
        except sqlite3.Error:
            retention_value = "30"
    try:
        retention_days = max(1, int(retention_value))
    except (TypeError, ValueError):
        retention_days = 30
    existing = sorted(BACKUP_DIR.glob("pos-auto-*.db"), key=lambda path: path.stat().st_mtime, reverse=True)
    now = time.time()
    backup_path = None
    if not existing or now - existing[0].stat().st_mtime >= interval_hours * 60 * 60:
        backup_path = create_database_backup("pos-auto")
    cutoff = now - retention_days * 24 * 60 * 60
    for path in existing:
        if path.stat().st_mtime < cutoff:
            path.unlink(missing_ok=True)
            path.with_name(f"{path.stem}-item-images.zip").unlink(missing_ok=True)
    return backup_path


def current_web_schema_version() -> int:
    with connect() as connection:
        exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_schema_meta'"
        ).fetchone()
        if not exists:
            return 0
        return int(connection.execute("SELECT COALESCE(MAX(version),0) FROM web_schema_meta").fetchone()[0])


def rows_to_dict(rows) -> list[dict]:
    return [dict(row) for row in rows]


def audit(connection: sqlite3.Connection, action: str, details: str, user: str) -> None:
    connection.execute(
        "INSERT INTO audit_log (timestamp,action,details,user) VALUES (?,?,?,?)",
        (now_audit(), action, details, user),
    )


def store_item_image(data_url: str, item_id: int) -> str:
    """Validate and store a small browser-compressed JPEG, PNG, or WebP image."""
    match = re.fullmatch(
        r"data:image/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)",
        str(data_url or ""),
        re.IGNORECASE,
    )
    if not match:
        raise APIError(400, "Choose a JPEG, PNG, or WebP item photo.")
    try:
        image_bytes = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        raise APIError(400, "The item photo could not be read.")
    if not image_bytes or len(image_bytes) > 5_000_000:
        raise APIError(413, "The item photo must be smaller than 5 MB after resizing.")

    requested = match.group(1).lower()
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        extension = "png"
    elif image_bytes.startswith(b"\xff\xd8\xff"):
        extension = "jpg"
    elif image_bytes.startswith(b"RIFF") and image_bytes[8:12] == b"WEBP":
        extension = "webp"
    else:
        raise APIError(400, f"The uploaded {requested.upper()} data is not a valid image file.")

    ITEM_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"item-{int(item_id)}-{secrets.token_hex(6)}.{extension}"
    target = ITEM_IMAGE_DIR / filename
    target.write_bytes(image_bytes)
    return f"/uploads/items/{filename}"


def remove_managed_item_image(image_path: str | None) -> None:
    if not image_path or not str(image_path).startswith("/uploads/items/"):
        return
    target = (WEB_ROOT / str(image_path).lstrip("/")).resolve()
    try:
        target.relative_to(ITEM_IMAGE_DIR.resolve())
    except ValueError:
        return
    try:
        target.unlink(missing_ok=True)
    except OSError:
        pass


def ensure_web_schema() -> None:
    if not DB_PATH.exists():
        raise RuntimeError(f"Database not found: {DB_PATH}")
    with connect() as connection:
        ITEM_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
        connection.execute(
            """CREATE TABLE IF NOT EXISTS app_settings (
                   key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by TEXT
               )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS web_schema_meta (
                   version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, notes TEXT
               )"""
        )
        invalid_pins = [
            f"{row['staff_id']}={row['pin']}" for row in connection.execute(
                "SELECT staff_id,pin FROM staff WHERE active=1"
            ) if not re.fullmatch(r"\d{1,8}", str(row["pin"] or ""))
        ]
        if invalid_pins:
            raise RuntimeError(
                "Active staff PINs must contain 1 to 8 digits before web migration. Invalid: "
                + ", ".join(invalid_pins)
            )
        duplicate_pins = connection.execute(
            "SELECT pin,COUNT(*) FROM staff WHERE active=1 GROUP BY pin HAVING COUNT(*)>1"
        ).fetchall()
        if duplicate_pins:
            values = ", ".join(str(row[0]) for row in duplicate_pins)
            raise RuntimeError(f"Active staff PINs must be unique before web migration. Duplicates: {values}")
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_active_pin_unique ON staff(pin) WHERE active=1"
        )
        defaults = {
            "shop_name": "919 Restaurant",
            "currency": "RM",
            "business_day_start": "06:00",
            "language": "en",
            "backup_retention_days": "30",
            "receipt_footer": "Thank you",
            "business_registration_no": "",
            "business_address": "",
            "employer_epf_no": "",
            "employer_socso_no": "",
        }
        for key, value in defaults.items():
            connection.execute(
                "INSERT OR IGNORE INTO app_settings (key,value,updated_at,updated_by) VALUES (?,?,?,?)",
                (key, value, now_iso(), "Web migration"),
            )
        connection.execute(
            "INSERT OR IGNORE INTO web_schema_meta (version,applied_at,notes) VALUES (1,?,?)",
            (now_iso(), "Role-aware web foundation, settings, and unique active staff PINs"),
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS stock_movements (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   datetime TEXT NOT NULL,
                   item_id INTEGER NOT NULL,
                   item_name TEXT NOT NULL,
                   quantity_delta INTEGER NOT NULL,
                   stock_before INTEGER NOT NULL,
                   stock_after INTEGER NOT NULL,
                   source_type TEXT NOT NULL,
                   reference_id INTEGER,
                   recorded_by TEXT,
                   notes TEXT,
                   FOREIGN KEY (item_id) REFERENCES items(id)
               )"""
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(item_id,id)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_stock_movements_source ON stock_movements(source_type,reference_id)")
        connection.execute(
            """INSERT INTO stock_movements
               (datetime,item_id,item_name,quantity_delta,stock_before,stock_after,
                source_type,reference_id,recorded_by,notes)
               SELECT ?,i.id,i.name,0,i.stock,i.stock,'MIGRATION_BASELINE',NULL,'System',
                      'Initial ledger balance'
               FROM items i
               WHERE i.track_stock=1
                 AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.item_id=i.id)""",
            (now_audit(),),
        )
        connection.execute(
            "INSERT OR IGNORE INTO web_schema_meta (version,applied_at,notes) VALUES (2,?,?)",
            (now_iso(), "Added immutable stock movement ledger compatibility"),
        )
        item_columns = {row[1] for row in connection.execute("PRAGMA table_info(items)")}
        if "image_path" not in item_columns:
            connection.execute("ALTER TABLE items ADD COLUMN image_path TEXT")
        connection.execute(
            "INSERT OR IGNORE INTO web_schema_meta (version,applied_at,notes) VALUES (3,?,?)",
            (now_iso(), "Added optional item photos and live POS catalog compatibility"),
        )
        held_columns = {row[1] for row in connection.execute("PRAGMA table_info(held_orders)")}
        held_migrations = {
            "discount": "ALTER TABLE held_orders ADD COLUMN discount REAL DEFAULT 0",
            "version": "ALTER TABLE held_orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
            "origin": "ALTER TABLE held_orders ADD COLUMN origin TEXT NOT NULL DEFAULT 'DESKTOP'",
            "sale_id": "ALTER TABLE held_orders ADD COLUMN sale_id INTEGER",
            "checkout_key": "ALTER TABLE held_orders ADD COLUMN checkout_key TEXT",
            "updated_by": "ALTER TABLE held_orders ADD COLUMN updated_by TEXT",
        }
        for column, sql in held_migrations.items():
            if column not in held_columns:
                connection.execute(sql)
        connection.execute(
            """CREATE TABLE IF NOT EXISTS web_order_lines (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   order_id INTEGER NOT NULL,
                   line_key TEXT NOT NULL,
                   item_id INTEGER NOT NULL,
                   item_name TEXT NOT NULL,
                   display_name TEXT NOT NULL,
                   unit_price REAL NOT NULL,
                   quantity INTEGER NOT NULL,
                   category TEXT,
                   variant_code TEXT,
                   variant_name TEXT,
                   stock_multiplier INTEGER NOT NULL DEFAULT 1,
                   sort_order INTEGER NOT NULL DEFAULT 0,
                   FOREIGN KEY (order_id) REFERENCES held_orders(id) ON DELETE CASCADE,
                   FOREIGN KEY (item_id) REFERENCES items(id),
                   UNIQUE(order_id,line_key)
               )"""
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_web_order_lines_order ON web_order_lines(order_id,sort_order,id)")
        connection.execute(
            """CREATE TABLE IF NOT EXISTS web_checkout_requests (
                   request_id TEXT PRIMARY KEY,
                   order_id INTEGER NOT NULL,
                   sale_id INTEGER NOT NULL,
                   session_staff_id TEXT,
                   created_at TEXT NOT NULL,
                   response_json TEXT NOT NULL,
                   FOREIGN KEY (order_id) REFERENCES held_orders(id),
                   FOREIGN KEY (sale_id) REFERENCES sales(id)
               )"""
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_web_checkout_order ON web_checkout_requests(order_id)")
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_held_orders_checkout_key ON held_orders(checkout_key) WHERE checkout_key IS NOT NULL")
        # Desktop users can keep several independent bills at one table.
        # Web startup must not reintroduce the old shared-database constraint.
        connection.execute("DROP INDEX IF EXISTS idx_held_orders_one_active_table")
        connection.execute(
            "INSERT OR IGNORE INTO web_schema_meta (version,applied_at,notes) VALUES (4,?,?)",
            (now_iso(), "Persistent web orders, normalized lines, optimistic versions, and idempotent checkout"),
        )
        connection.execute("DROP TRIGGER IF EXISTS trg_held_orders_external_change")
        connection.execute(
            """CREATE TRIGGER trg_held_orders_external_change
               AFTER UPDATE OF items,subtotal,tax,total,note,status,table_code ON held_orders
               WHEN NEW.version=OLD.version AND (
                    NEW.items IS NOT OLD.items OR NEW.subtotal IS NOT OLD.subtotal OR
                    NEW.tax IS NOT OLD.tax OR NEW.total IS NOT OLD.total OR
                    NEW.note IS NOT OLD.note OR NEW.status IS NOT OLD.status OR
                    NEW.table_code IS NOT OLD.table_code
               )
               BEGIN
                 UPDATE held_orders
                    SET version=OLD.version+1,origin='DESKTOP',
                        updated_by=COALESCE(NULLIF(NEW.cashier,''),'Desktop')
                  WHERE id=NEW.id;
                 DELETE FROM web_order_lines WHERE order_id=NEW.id;
               END"""
        )
        connection.execute("DROP TRIGGER IF EXISTS trg_held_orders_delete_lines")
        connection.execute(
            """CREATE TRIGGER trg_held_orders_delete_lines
               AFTER DELETE ON held_orders
               BEGIN
                 DELETE FROM web_order_lines WHERE order_id=OLD.id;
               END"""
        )
        connection.execute(
            "INSERT OR IGNORE INTO web_schema_meta (version,applied_at,notes) VALUES (5,?,?)",
            (now_iso(), "Desktop/web held-order compatibility trigger and stale-line invalidation"),
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS web_sale_corrections (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   request_id TEXT NOT NULL UNIQUE,
                   original_sale_id INTEGER NOT NULL,
                   correction_sale_id INTEGER,
                   refund_id INTEGER,
                   datetime TEXT NOT NULL,
                   reason TEXT NOT NULL,
                   processed_by TEXT NOT NULL,
                   refund_amount REAL NOT NULL DEFAULT 0,
                   charge_amount REAL NOT NULL DEFAULT 0,
                   charge_payment TEXT,
                   cash_received REAL,
                   change_amount REAL,
                   return_to_stock INTEGER NOT NULL DEFAULT 1,
                   response_json TEXT NOT NULL,
                   FOREIGN KEY (original_sale_id) REFERENCES sales(id),
                   FOREIGN KEY (correction_sale_id) REFERENCES sales(id),
                   FOREIGN KEY (refund_id) REFERENCES refunds(id)
               )"""
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_web_sale_corrections_original ON web_sale_corrections(original_sale_id,id)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_web_sale_corrections_sale ON web_sale_corrections(correction_sale_id)")
        connection.execute(
            "INSERT OR IGNORE INTO web_schema_meta (version,applied_at,notes) VALUES (6,?,?)",
            (now_iso(), "Audited paid-sale corrections and linked adjustment receipts"),
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS payroll_employees (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   employee_code TEXT NOT NULL COLLATE NOCASE UNIQUE,
                   full_name TEXT NOT NULL,
                   identification_no TEXT,
                   employment_type TEXT NOT NULL DEFAULT 'FULL_TIME',
                   citizenship_status TEXT NOT NULL DEFAULT 'MALAYSIAN',
                   nationality TEXT,
                   passport_no TEXT,
                   passport_expiry TEXT,
                   work_pass_no TEXT,
                   work_pass_expiry TEXT,
                   epf_treatment TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
                   statutory_basis TEXT,
                   designation TEXT,
                   department TEXT,
                   epf_no TEXT,
                   socso_no TEXT,
                   tax_no TEXT,
                   bank_name TEXT,
                   bank_account TEXT,
                   default_basic_salary REAL NOT NULL DEFAULT 0,
                   start_date TEXT,
                   active INTEGER NOT NULL DEFAULT 1,
                   notes TEXT,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
               )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS payroll_slips (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   slip_no TEXT NOT NULL UNIQUE,
                   employee_id INTEGER NOT NULL,
                   period_start TEXT NOT NULL,
                   period_end TEXT NOT NULL,
                   pay_date TEXT NOT NULL,
                   worked_days REAL NOT NULL DEFAULT 0,
                   paid_leave_days REAL NOT NULL DEFAULT 0,
                   unpaid_leave_days REAL NOT NULL DEFAULT 0,
                   basic_salary REAL NOT NULL DEFAULT 0,
                   overtime_hours REAL NOT NULL DEFAULT 0,
                   overtime_pay REAL NOT NULL DEFAULT 0,
                   rest_day_pay REAL NOT NULL DEFAULT 0,
                   public_holiday_pay REAL NOT NULL DEFAULT 0,
                   allowances REAL NOT NULL DEFAULT 0,
                   bonus REAL NOT NULL DEFAULT 0,
                   commission REAL NOT NULL DEFAULT 0,
                   other_earnings REAL NOT NULL DEFAULT 0,
                   other_earnings_note TEXT,
                   gross_pay REAL NOT NULL DEFAULT 0,
                   employee_epf REAL NOT NULL DEFAULT 0,
                   employee_socso REAL NOT NULL DEFAULT 0,
                   employee_eis REAL NOT NULL DEFAULT 0,
                   pcb REAL NOT NULL DEFAULT 0,
                   advance REAL NOT NULL DEFAULT 0,
                   unpaid_leave_deduction REAL NOT NULL DEFAULT 0,
                   other_deductions REAL NOT NULL DEFAULT 0,
                   other_deductions_note TEXT,
                   total_deductions REAL NOT NULL DEFAULT 0,
                   net_pay REAL NOT NULL DEFAULT 0,
                   employer_epf REAL NOT NULL DEFAULT 0,
                   employer_socso REAL NOT NULL DEFAULT 0,
                   employer_eis REAL NOT NULL DEFAULT 0,
                   epf_zero_reason TEXT,
                   status TEXT NOT NULL DEFAULT 'DRAFT',
                   payment_method TEXT,
                   payment_record_mode TEXT NOT NULL DEFAULT 'UNRECORDED',
                   payment_reference TEXT,
                   compliance_override_reason TEXT,
                   cashflow_id INTEGER,
                   employee_snapshot TEXT NOT NULL DEFAULT '{}',
                   employer_snapshot TEXT NOT NULL DEFAULT '{}',
                   notes TEXT,
                   created_at TEXT NOT NULL,
                   created_by TEXT NOT NULL,
                   updated_at TEXT NOT NULL,
                   updated_by TEXT NOT NULL,
                   paid_at TEXT,
                   paid_by TEXT,
                   voided_at TEXT,
                   voided_by TEXT,
                   void_reason TEXT,
                   FOREIGN KEY (employee_id) REFERENCES payroll_employees(id),
                   FOREIGN KEY (cashflow_id) REFERENCES cashflow(id) ON DELETE SET NULL,
                   CHECK (status IN ('DRAFT','PAID','VOID'))
               )"""
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_payroll_employees_active ON payroll_employees(active,full_name)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_payroll_slips_period ON payroll_slips(period_start,period_end,id)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_payroll_slips_employee ON payroll_slips(employee_id,id)")
        connection.execute(
            """CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_one_live_period
               ON payroll_slips(employee_id,period_start,period_end)
               WHERE status<>'VOID'"""
        )
        connection.execute(
            "INSERT OR IGNORE INTO web_schema_meta (version,applied_at,notes) VALUES (7,?,?)",
            (now_iso(), "Admin payroll employees, immutable salary slips, and linked salary payments"),
        )
        payroll_employee_columns = {row[1] for row in connection.execute("PRAGMA table_info(payroll_employees)")}
        payroll_employee_migrations = {
            "employment_type": "ALTER TABLE payroll_employees ADD COLUMN employment_type TEXT NOT NULL DEFAULT 'FULL_TIME'",
            "citizenship_status": "ALTER TABLE payroll_employees ADD COLUMN citizenship_status TEXT NOT NULL DEFAULT 'MALAYSIAN'",
            "nationality": "ALTER TABLE payroll_employees ADD COLUMN nationality TEXT",
            "passport_no": "ALTER TABLE payroll_employees ADD COLUMN passport_no TEXT",
            "passport_expiry": "ALTER TABLE payroll_employees ADD COLUMN passport_expiry TEXT",
            "work_pass_no": "ALTER TABLE payroll_employees ADD COLUMN work_pass_no TEXT",
            "work_pass_expiry": "ALTER TABLE payroll_employees ADD COLUMN work_pass_expiry TEXT",
            "epf_treatment": "ALTER TABLE payroll_employees ADD COLUMN epf_treatment TEXT NOT NULL DEFAULT 'PENDING_REVIEW'",
            "statutory_basis": "ALTER TABLE payroll_employees ADD COLUMN statutory_basis TEXT",
        }
        for column, sql in payroll_employee_migrations.items():
            if column not in payroll_employee_columns:
                connection.execute(sql)
        payroll_slip_columns = {row[1] for row in connection.execute("PRAGMA table_info(payroll_slips)")}
        payroll_slip_migrations = {
            "epf_zero_reason": "ALTER TABLE payroll_slips ADD COLUMN epf_zero_reason TEXT",
            "payment_record_mode": "ALTER TABLE payroll_slips ADD COLUMN payment_record_mode TEXT NOT NULL DEFAULT 'UNRECORDED'",
            "payment_reference": "ALTER TABLE payroll_slips ADD COLUMN payment_reference TEXT",
            "compliance_override_reason": "ALTER TABLE payroll_slips ADD COLUMN compliance_override_reason TEXT",
            "employee_snapshot": "ALTER TABLE payroll_slips ADD COLUMN employee_snapshot TEXT NOT NULL DEFAULT '{}'",
            "employer_snapshot": "ALTER TABLE payroll_slips ADD COLUMN employer_snapshot TEXT NOT NULL DEFAULT '{}'",
        }
        for column, sql in payroll_slip_migrations.items():
            if column not in payroll_slip_columns:
                connection.execute(sql)
        connection.execute(
            """UPDATE payroll_slips
                  SET payment_record_mode=CASE
                        WHEN status='PAID' AND cashflow_id IS NOT NULL THEN 'POSTED'
                        WHEN status='PAID' THEN 'HISTORICAL'
                        ELSE 'UNRECORDED'
                      END
                WHERE payment_record_mode IS NULL OR payment_record_mode='' OR
                      (payment_record_mode='UNRECORDED' AND status='PAID')"""
        )
        connection.execute(
            "INSERT OR IGNORE INTO web_schema_meta (version,applied_at,notes) VALUES (8,?,?)",
            (now_iso(), "Payroll employment, EPF, foreign-worker document, historical-payment, and immutable snapshot guardrails"),
        )
        order_line_columns = {row[1] for row in connection.execute("PRAGMA table_info(web_order_lines)")}
        if "is_foc" not in order_line_columns:
            connection.execute("ALTER TABLE web_order_lines ADD COLUMN is_foc INTEGER NOT NULL DEFAULT 0")
        if "foc_reason" not in order_line_columns:
            connection.execute("ALTER TABLE web_order_lines ADD COLUMN foc_reason TEXT")
        connection.execute(
            """CREATE TABLE IF NOT EXISTS foc_replacements (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   business_date TEXT NOT NULL,
                   datetime TEXT NOT NULL,
                   sale_id INTEGER NOT NULL,
                   order_id INTEGER,
                   line_key TEXT NOT NULL,
                   item_id INTEGER NOT NULL,
                   item_name TEXT NOT NULL,
                   display_name TEXT NOT NULL,
                   category TEXT,
                   variant_code TEXT,
                   quantity INTEGER NOT NULL,
                   stock_quantity INTEGER NOT NULL,
                   normal_unit_price REAL NOT NULL,
                   normal_value REAL NOT NULL,
                   reason TEXT NOT NULL,
                   authorized_by TEXT NOT NULL,
                   ordered_by TEXT,
                   table_code TEXT,
                   created_at TEXT NOT NULL,
                   FOREIGN KEY (sale_id) REFERENCES sales(id),
                   FOREIGN KEY (order_id) REFERENCES held_orders(id),
                   FOREIGN KEY (item_id) REFERENCES items(id),
                   UNIQUE(sale_id,line_key)
               )"""
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_foc_replacements_date ON foc_replacements(business_date,id)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_foc_replacements_sale ON foc_replacements(sale_id,id)")
        connection.execute(
            "INSERT OR IGNORE INTO web_schema_meta (version,applied_at,notes) VALUES (9,?,?)",
            (now_iso(), "Audited zero-charge FOC replacement lines, stock movements, and accountant reporting"),
        )
        ensure_list_price_columns(connection)
        connection.execute(
            "INSERT OR IGNORE INTO web_schema_meta (version,applied_at,notes) VALUES (?,?,?)",
            (WEB_SCHEMA_VERSION, now_iso(), "Optional category list prices and sale-time receipt snapshots"),
        )


def money_value(value, field: str = "Amount") -> Decimal:
    try:
        result = Decimal(str(value if value is not None else 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError, TypeError):
        raise APIError(400, f"{field} must be a valid amount.")
    if not result.is_finite():
        raise APIError(400, f"{field} must be a valid amount.")
    return result


def finite_number(value, field: str = "Number") -> float:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        raise APIError(400, f"{field} must be a valid number.")
    if not math.isfinite(result):
        raise APIError(400, f"{field} must be a valid number.")
    return result


def boolean_flag(value, field: str) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in {0, 1}:
        return bool(value)
    text = str(value if value is not None else "").strip().lower()
    if text in {"", "0", "false", "no"}:
        return False
    if text in {"1", "true", "yes"}:
        return True
    raise APIError(400, f"{field} must be true or false.")


PAYROLL_EARNING_FIELDS = (
    "basic_salary", "overtime_pay", "rest_day_pay", "public_holiday_pay",
    "allowances", "bonus", "commission", "other_earnings",
)
PAYROLL_DEDUCTION_FIELDS = (
    "employee_epf", "employee_socso", "employee_eis", "pcb", "advance",
    "unpaid_leave_deduction", "other_deductions",
)
PAYROLL_EMPLOYER_FIELDS = ("employer_epf", "employer_socso", "employer_eis")
PAYROLL_EMPLOYMENT_TYPES = {"FULL_TIME", "PART_TIME", "TEMPORARY", "PROBATIONARY"}
PAYROLL_CITIZENSHIP_STATUSES = {"MALAYSIAN", "NON_MALAYSIAN"}
PAYROLL_EPF_TREATMENTS = {"REQUIRED", "EXEMPT_WITH_BASIS", "PENDING_REVIEW"}
PAYROLL_PAYMENT_RECORD_MODES = {"POSTED", "LINKED", "HISTORICAL"}
PAYROLL_SLIP_VALUE_FIELDS = (
    "period_start", "period_end", "pay_date", "worked_days", "paid_leave_days",
    "unpaid_leave_days", "basic_salary", "overtime_hours", "overtime_pay",
    "rest_day_pay", "public_holiday_pay", "allowances", "bonus", "commission",
    "other_earnings", "other_earnings_note", "gross_pay", "employee_epf",
    "employee_socso", "employee_eis", "pcb", "advance", "unpaid_leave_deduction",
    "other_deductions", "other_deductions_note", "total_deductions", "net_pay",
    "employer_epf", "employer_socso", "employer_eis", "epf_zero_reason", "notes",
)


def payroll_slip_values(payload: dict, current: sqlite3.Row | None = None) -> dict:
    """Validate a salary-slip draft and calculate all authoritative totals."""
    def supplied(name: str, default=None):
        if name in payload:
            return payload[name]
        if current is not None and name in current.keys():
            return current[name]
        return default

    period_start = iso_date_value(supplied("period_start", business_date()[:8] + "01"), "Period start")
    period_end = iso_date_value(supplied("period_end", business_date()), "Period end")
    pay_date = iso_date_value(supplied("pay_date", period_end), "Pay date")
    if period_start > period_end:
        raise APIError(400, "Pay-period start cannot be after its end date.")

    values: dict[str, object] = {
        "period_start": period_start,
        "period_end": period_end,
        "pay_date": pay_date,
    }
    for name, label, maximum in (
        ("worked_days", "Worked days", 366),
        ("paid_leave_days", "Paid leave days", 366),
        ("unpaid_leave_days", "Unpaid leave days", 366),
        ("overtime_hours", "Overtime hours", 1000),
    ):
        number = finite_number(supplied(name, 0), label)
        if number < 0 or number > maximum:
            raise APIError(400, f"{label} must be between 0 and {maximum}.")
        values[name] = round(number, 2)

    money_fields = PAYROLL_EARNING_FIELDS + PAYROLL_DEDUCTION_FIELDS + PAYROLL_EMPLOYER_FIELDS
    for name in money_fields:
        amount = money_value(supplied(name, 0), name.replace("_", " ").title())
        if amount < 0:
            raise APIError(400, "Salary amounts and deductions cannot be negative.")
        values[name] = float(amount)

    gross = sum(money_value(values[name]) for name in PAYROLL_EARNING_FIELDS).quantize(Decimal("0.01"))
    deductions = sum(money_value(values[name]) for name in PAYROLL_DEDUCTION_FIELDS).quantize(Decimal("0.01"))
    net = (gross - deductions).quantize(Decimal("0.01"))
    if gross <= 0:
        raise APIError(400, "Gross pay must be greater than zero.")
    if net < 0:
        raise APIError(400, "Total deductions cannot be greater than gross pay.")
    values.update({"gross_pay": float(gross), "total_deductions": float(deductions), "net_pay": float(net)})
    for name, maximum in (
        ("other_earnings_note", 100), ("other_deductions_note", 100),
        ("epf_zero_reason", 300), ("notes", 500),
    ):
        value = str(supplied(name, "") or "").strip()
        if len(value) > maximum:
            raise APIError(400, f"{name.replace('_', ' ').title()} is too long.")
        values[name] = value
    return values


def payroll_employee_values(payload: dict, current: sqlite3.Row | None = None) -> dict:
    def supplied(name: str, default=None):
        if name in payload:
            return payload[name]
        if current is not None and name in current.keys():
            return current[name]
        return default

    limits = {
        "employee_code": 30, "full_name": 100, "identification_no": 40,
        "nationality": 80, "passport_no": 60, "work_pass_no": 80,
        "statutory_basis": 500,
        "designation": 80, "department": 80, "epf_no": 40, "socso_no": 40,
        "tax_no": 40, "bank_name": 80, "bank_account": 60, "notes": 500,
    }
    values = {}
    for name, maximum in limits.items():
        value = str(supplied(name, "") or "").strip()
        if len(value) > maximum:
            raise APIError(400, f"{name.replace('_', ' ').title()} is too long.")
        values[name] = value
    if not values["employee_code"] or not values["full_name"]:
        raise APIError(400, "Employee code and full name are required.")
    employment_type = str(supplied("employment_type", "FULL_TIME") or "").strip().upper()
    citizenship_status = str(supplied("citizenship_status", "MALAYSIAN") or "").strip().upper()
    epf_treatment = str(supplied("epf_treatment", "REQUIRED") or "").strip().upper()
    if employment_type not in PAYROLL_EMPLOYMENT_TYPES:
        raise APIError(400, "Choose a valid employee type. Contractors belong in Accounting, not Payroll.")
    if citizenship_status not in PAYROLL_CITIZENSHIP_STATUSES:
        raise APIError(400, "Choose Malaysian or non-Malaysian citizenship status.")
    if epf_treatment not in PAYROLL_EPF_TREATMENTS:
        raise APIError(400, "Choose a valid EPF treatment.")
    if epf_treatment == "EXEMPT_WITH_BASIS" and len(values["statutory_basis"]) < 10:
        raise APIError(400, "Document the official or professional basis for an EPF exemption.")
    values.update({
        "employment_type": employment_type,
        "citizenship_status": citizenship_status,
        "epf_treatment": epf_treatment,
    })
    for name, label in (("passport_expiry", "Passport expiry"), ("work_pass_expiry", "Work-pass expiry")):
        raw = str(supplied(name, "") or "").strip()
        values[name] = iso_date_value(raw, label) if raw else None
    basic = money_value(supplied("default_basic_salary", 0), "Default basic salary")
    if basic < 0:
        raise APIError(400, "Default basic salary cannot be negative.")
    values["default_basic_salary"] = float(basic)
    start_date = str(supplied("start_date", "") or "").strip()
    values["start_date"] = iso_date_value(start_date, "Start date") if start_date else None
    try:
        values["active"] = int(bool(int(supplied("active", 1))))
    except (TypeError, ValueError):
        raise APIError(400, "Employee status is invalid.")
    return values


PAYROLL_EMPLOYEE_SNAPSHOT_FIELDS = (
    "employee_code", "full_name", "identification_no", "employment_type",
    "citizenship_status", "nationality", "passport_no", "passport_expiry",
    "work_pass_no", "work_pass_expiry", "epf_treatment", "statutory_basis",
    "designation", "department", "epf_no", "socso_no", "tax_no", "bank_name",
    "bank_account", "start_date",
)
PAYROLL_EMPLOYER_SNAPSHOT_FIELDS = (
    "shop_name", "business_registration_no", "business_address",
    "employer_epf_no", "employer_socso_no", "currency",
)


def payroll_employee_snapshot(employee) -> dict:
    row = dict(employee)
    return {name: row.get(name) for name in PAYROLL_EMPLOYEE_SNAPSHOT_FIELDS}


def payroll_employer_snapshot(settings: dict) -> dict:
    return {name: settings.get(name, "") for name in PAYROLL_EMPLOYER_SNAPSHOT_FIELDS}


def parse_payroll_snapshot(value: str | None) -> dict:
    try:
        parsed = json.loads(value or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def payroll_employee_compliance(employee, as_of: str | None = None) -> dict:
    """Return payroll blockers/warnings without guessing statutory amounts."""
    row = dict(employee)
    check_date = date.fromisoformat(as_of or date.today().isoformat())
    blockers: list[str] = []
    warnings: list[str] = []
    employment_type = str(row.get("employment_type") or "FULL_TIME").upper()
    citizenship = str(row.get("citizenship_status") or "MALAYSIAN").upper()
    epf_treatment = str(row.get("epf_treatment") or "PENDING_REVIEW").upper()

    if epf_treatment == "PENDING_REVIEW":
        blockers.append("EPF treatment is still pending review.")
    elif epf_treatment == "EXEMPT_WITH_BASIS" and len(str(row.get("statutory_basis") or "").strip()) < 10:
        blockers.append("The EPF exemption has no documented official or professional basis.")
    if employment_type in {"PART_TIME", "TEMPORARY", "PROBATIONARY"} and epf_treatment != "REQUIRED":
        warnings.append("Part-time, temporary, and probationary employees are generally EPF-liable; verify any exception.")

    if citizenship == "MALAYSIAN":
        if not str(row.get("identification_no") or "").strip():
            blockers.append("Malaysian identification number is missing.")
    else:
        required_documents = (
            ("passport_no", "Passport number"), ("passport_expiry", "Passport expiry"),
            ("work_pass_no", "Work-pass number"), ("work_pass_expiry", "Work-pass expiry"),
        )
        for name, label in required_documents:
            if not str(row.get(name) or "").strip():
                blockers.append(f"{label} is missing.")
        for name, label in (("passport_expiry", "Passport"), ("work_pass_expiry", "Work pass")):
            raw = str(row.get(name) or "").strip()
            if not raw:
                continue
            try:
                expiry = date.fromisoformat(raw)
            except ValueError:
                blockers.append(f"{label} expiry is invalid.")
                continue
            days = (expiry - check_date).days
            if days < 0:
                blockers.append(f"{label} expired on {expiry.isoformat()}.")
            elif days <= 60:
                warnings.append(f"{label} expires in {days} days; verify renewal and EPF treatment.")

    status = "BLOCKED" if blockers else "REVIEW" if warnings else "READY"
    return {"status": status, "blockers": blockers, "warnings": warnings}


def active_order_using_option(
    connection: sqlite3.Connection, option_code: str, legacy_markers: tuple[str, ...] = ()
) -> sqlite3.Row | None:
    """Return an unpaid order that still relies on a catalog option."""
    row = connection.execute(
        """SELECT ho.id,ho.table_code
             FROM web_order_lines wol
             JOIN held_orders ho ON ho.id=wol.order_id
            WHERE ho.status='HELD' AND wol.variant_code=?
            ORDER BY ho.id LIMIT 1""",
        (option_code,),
    ).fetchone()
    if row:
        return row
    for marker in legacy_markers:
        if not marker:
            continue
        row = connection.execute(
            """SELECT id,table_code FROM held_orders
                WHERE status='HELD' AND COALESCE(origin,'DESKTOP')<>'WEB' AND items LIKE ?
                ORDER BY id LIMIT 1""",
            (f"%{marker}%",),
        ).fetchone()
        if row:
            return row
    return None


def iso_date_value(value, field: str = "Date") -> str:
    text = str(value or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        raise APIError(400, f"{field} must use YYYY-MM-DD.")
    try:
        date.fromisoformat(text)
    except ValueError:
        raise APIError(400, f"{field} is not a valid calendar date.")
    return text


def normalize_order_lines(connection: sqlite3.Connection, requested: object) -> list[dict]:
    if not isinstance(requested, list):
        raise APIError(400, "Order items must be a list.")
    if len(requested) > 100:
        raise APIError(400, "An order cannot contain more than 100 different lines.")
    combined: dict[str, dict] = {}
    for position, raw in enumerate(requested):
        if not isinstance(raw, dict):
            raise APIError(400, "Each order item must be an object.")
        try:
            item_id = int(raw.get("product_id", 0))
            quantity = int(raw.get("quantity", raw.get("qty", 0)))
        except (TypeError, ValueError):
            raise APIError(400, "Order item and quantity must be valid numbers.")
        if quantity < 1 or quantity > 999:
            raise APIError(400, "Each order quantity must be between 1 and 999.")
        item = connection.execute(
            "SELECT id,name,price,category,track_stock,stock FROM items WHERE id=? AND active=1",
            (item_id,),
        ).fetchone()
        if not item:
            raise APIError(409, f"Product #{item_id} is no longer available.")

        is_foc = boolean_flag(raw.get("is_foc", False), "FOC selection")
        foc_reason = str(raw.get("foc_reason") or "").strip()
        if is_foc and (len(foc_reason) < 3 or len(foc_reason) > 300):
            raise APIError(400, "Every FOC replacement needs a reason between 3 and 300 characters.")
        if not is_foc:
            foc_reason = ""

        variant_code = str(raw.get("variant_code") or "").strip()
        variant_name = ""
        display_name = str(item["name"])
        unit_price = money_value(item["price"], "Product price")
        stock_multiplier = 1
        canonical_code = "base"
        variant_match = re.fullmatch(r"variant-(\d+)", variant_code)
        set_match = re.fullmatch(r"set-(\d+)", variant_code)
        if variant_match:
            option = connection.execute(
                "SELECT id,variant_name,price_adjustment FROM item_variants WHERE id=? AND item_id=?",
                (int(variant_match.group(1)), item_id),
            ).fetchone()
            if not option:
                raise APIError(409, f"The selected option for {item['name']} is no longer available.")
            canonical_code = f"variant-{int(option['id'])}"
            variant_name = str(option["variant_name"])
            display_name = f"{item['name']} ({variant_name})"
            unit_price = (unit_price + money_value(option["price_adjustment"], "Option price")).quantize(Decimal("0.01"))
        elif set_match:
            option = connection.execute(
                "SELECT id,quantity,set_price FROM item_quantity_sets WHERE id=? AND item_id=?",
                (int(set_match.group(1)), item_id),
            ).fetchone()
            if not option:
                raise APIError(409, f"The selected set for {item['name']} is no longer available.")
            stock_multiplier = int(option["quantity"] or 1)
            if stock_multiplier < 1:
                raise APIError(409, f"The selected set for {item['name']} has an invalid quantity.")
            canonical_code = f"set-{int(option['id'])}"
            variant_name = f"Set of {stock_multiplier}"
            display_name = f"{item['name']} Set({stock_multiplier})"
            unit_price = money_value(option["set_price"], "Set price")
        elif variant_code not in {"", "base", "single"}:
            raise APIError(409, f"The selected option for {item['name']} is no longer available.")

        treatment = "sale"
        if is_foc:
            reason_key = hashlib.sha256(foc_reason.casefold().encode("utf-8")).hexdigest()[:12]
            treatment = f"foc-{reason_key}"
        line_key = f"{item_id}-{canonical_code}-{treatment}"
        if line_key in combined:
            combined[line_key]["quantity"] += quantity
            if combined[line_key]["quantity"] > 999:
                raise APIError(400, "A combined order quantity cannot exceed 999.")
            continue
        combined[line_key] = {
            "line_key": line_key,
            "product_id": item_id,
            "item_name": str(item["name"]),
            "display_name": display_name,
            "unit_price": float(unit_price),
            "quantity": quantity,
            "category": str(item["category"] or ""),
            "variant_code": None if canonical_code == "base" else canonical_code,
            "variant_name": variant_name or None,
            "stock_multiplier": stock_multiplier,
            "is_foc": is_foc,
            "foc_reason": foc_reason or None,
            "sort_order": position,
        }
    return list(combined.values())


def legacy_order_lines(connection: sqlite3.Connection, items_json: str) -> list[dict]:
    try:
        raw_items = json.loads(items_json or "[]")
    except (TypeError, json.JSONDecodeError):
        raise APIError(409, "The saved order item data cannot be read safely.")
    result: list[dict] = []
    for position, raw in enumerate(raw_items if isinstance(raw_items, list) else []):
        if not isinstance(raw, (list, tuple)) or len(raw) < 3:
            continue
        display_name = str(raw[0] or "").strip()
        is_foc = display_name.startswith("[FOC] ")
        if is_foc:
            display_name = display_name[6:].strip()
        try:
            quantity = int(raw[2] or 0)
        except (TypeError, ValueError):
            quantity = 0
        if not display_name or quantity < 1:
            continue
        search_name = display_name
        stock_multiplier = 1
        variant_code = None
        variant_name = None
        set_match = re.search(r" Set\((\d+)\)$", display_name)
        if set_match:
            stock_multiplier = max(1, int(set_match.group(1)))
            search_name = display_name[: set_match.start()].strip()
        elif "(" in display_name and display_name.endswith(")"):
            marker = display_name.rfind("(")
            variant_name = display_name[marker + 1 : -1].strip()
            search_name = display_name[:marker].strip()
        item = connection.execute(
            "SELECT id,name,category FROM items WHERE name=?", (search_name,)
        ).fetchone()
        if not item:
            item = connection.execute(
                "SELECT id,name,category FROM items WHERE name=?", (display_name,)
            ).fetchone()
        if not item:
            continue
        if set_match:
            option = connection.execute(
                "SELECT id FROM item_quantity_sets WHERE item_id=? AND quantity=? ORDER BY ABS(set_price-?) LIMIT 1",
                (int(item["id"]), stock_multiplier, float(raw[1] or 0)),
            ).fetchone()
            if option:
                variant_code = f"set-{int(option['id'])}"
                variant_name = f"Set of {stock_multiplier}"
        elif variant_name:
            option = connection.execute(
                "SELECT id FROM item_variants WHERE item_id=? AND variant_name=? COLLATE NOCASE LIMIT 1",
                (int(item["id"]), variant_name),
            ).fetchone()
            if option:
                variant_code = f"variant-{int(option['id'])}"
        result.append({
            "line_key": f"{int(item['id'])}-{variant_code or 'base'}-{position}",
            "product_id": int(item["id"]),
            "item_name": str(item["name"]),
            "display_name": display_name,
            "unit_price": float(money_value(raw[1], "Saved unit price")),
            "quantity": quantity,
            "category": str(raw[3] if len(raw) > 3 else item["category"] or ""),
            "variant_code": variant_code,
            "variant_name": variant_name,
            "stock_multiplier": stock_multiplier,
            "is_foc": is_foc,
            "foc_reason": "FOC replacement from legacy order" if is_foc else None,
            "sort_order": position,
        })
    return result


def load_order_lines(connection: sqlite3.Connection, order_row: sqlite3.Row) -> list[dict]:
    rows = connection.execute(
        """SELECT line_key,item_id,item_name,display_name,unit_price,quantity,category,
                  variant_code,variant_name,stock_multiplier,is_foc,foc_reason,sort_order
           FROM web_order_lines WHERE order_id=? ORDER BY sort_order,id""",
        (int(order_row["id"]),),
    ).fetchall()
    if rows and str(order_row["origin"] or "").upper() == "WEB":
        return [{
            "line_key": str(row["line_key"]),
            "product_id": int(row["item_id"]),
            "item_name": str(row["item_name"]),
            "display_name": str(row["display_name"]),
            "unit_price": float(row["unit_price"] or 0),
            "quantity": int(row["quantity"] or 0),
            "category": str(row["category"] or ""),
            "variant_code": row["variant_code"],
            "variant_name": row["variant_name"],
            "stock_multiplier": int(row["stock_multiplier"] or 1),
            "is_foc": bool(row["is_foc"]),
            "foc_reason": str(row["foc_reason"] or "") or None,
            "sort_order": int(row["sort_order"] or 0),
        } for row in rows]
    return legacy_order_lines(connection, str(order_row["items"] or "[]"))


def replace_order_lines(connection: sqlite3.Connection, order_id: int, lines: list[dict]) -> None:
    connection.execute("DELETE FROM web_order_lines WHERE order_id=?", (order_id,))
    connection.executemany(
        """INSERT INTO web_order_lines
           (order_id,line_key,item_id,item_name,display_name,unit_price,quantity,category,
            variant_code,variant_name,stock_multiplier,is_foc,foc_reason,sort_order)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [(
            order_id, line["line_key"], line["product_id"], line["item_name"],
            line["display_name"], line["unit_price"], line["quantity"], line["category"],
            line["variant_code"], line["variant_name"], line["stock_multiplier"],
            int(bool(line.get("is_foc"))), line.get("foc_reason"), line["sort_order"],
        ) for line in lines],
    )


def order_amounts(lines: list[dict], discount_value) -> tuple[float, float, float, float]:
    subtotal = sum(
        (
            money_value(line["unit_price"], "Unit price") * int(line["quantity"])
            for line in lines if not bool(line.get("is_foc"))
        ),
        Decimal("0.00"),
    ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    discount = money_value(discount_value, "Discount")
    if discount < 0:
        raise APIError(400, "Discount cannot be negative.")
    if discount > subtotal:
        raise APIError(400, "Discount cannot be greater than the subtotal.")
    tax = Decimal("0.00")
    total = (subtotal + tax - discount).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return float(subtotal), float(discount), float(tax), float(total)


def order_items_json(lines: list[dict]) -> str:
    return json.dumps(
        [[
            f"[FOC] {line['display_name']}" if line.get("is_foc") else line["display_name"],
            0.0 if line.get("is_foc") else float(line["unit_price"]),
            int(line["quantity"]),
            line["category"],
        ] for line in lines],
        ensure_ascii=False,
    )


def order_response(connection: sqlite3.Connection, row: sqlite3.Row) -> dict:
    lines = load_order_lines(connection, row)
    foc_lines = [line for line in lines if line.get("is_foc")]
    return {
        "id": int(row["id"]),
        "order_number": str(int(row["id"])).zfill(4),
        "table_code": str(row["table_code"] or ""),
        "status": str(row["status"] or "HELD"),
        "cashier": str(row["cashier"] or ""),
        "note": str(row["note"] or ""),
        "subtotal": float(row["subtotal"] or 0),
        "discount": float(row["discount"] or 0),
        "tax": float(row["tax"] or 0),
        "total": float(row["total"] or 0),
        "version": int(row["version"] or 1),
        "origin": str(row["origin"] or "DESKTOP"),
        "sale_id": int(row["sale_id"]) if row["sale_id"] is not None else None,
        "created_at": str(row["created_at"] or ""),
        "updated_at": str(row["updated_at"] or ""),
        "updated_by": str(row["updated_by"] or row["cashier"] or ""),
        "foc_quantity": sum(int(line["quantity"]) for line in foc_lines),
        "foc_value": float(sum(
            money_value(line["unit_price"], "Unit price") * int(line["quantity"])
            for line in foc_lines
        )),
        "items": lines,
    }


def validate_table(connection: sqlite3.Connection, table_code: str) -> str:
    code = str(table_code or "").strip()
    if not code:
        raise APIError(400, "Choose a table before saving the order.")
    row = connection.execute(
        "SELECT table_code FROM dining_tables WHERE active=1 AND table_code=? COLLATE NOCASE", (code,)
    ).fetchone()
    if not row:
        raise APIError(409, "This table is no longer active.")
    return str(row["table_code"])


def payment_authorization(token: str, session_token: str, order_id: int, payment: str) -> dict:
    now = time.time()
    with PAYMENT_AUTH_LOCK:
        expired = [key for key, value in PAYMENT_AUTHORIZATIONS.items() if value["expires"] < now]
        for key in expired:
            PAYMENT_AUTHORIZATIONS.pop(key, None)
        authorization = PAYMENT_AUTHORIZATIONS.get(str(token or ""))
    if not authorization or authorization["session_token"] != session_token:
        raise APIError(401, "Payment approval expired. Enter the cashier PIN again.")
    if authorization["order_id"] != order_id or authorization["payment"] != payment:
        raise APIError(403, "This payment approval does not match the current order.")
    return authorization


def apply_stock_for_web_lines(
    connection: sqlite3.Connection, lines: list[dict], sale_id: int, recorded_by: str, table_code: str
) -> None:
    required: dict[int, dict] = {}
    for line in lines:
        item_id = int(line["product_id"])
        quantity = int(line["quantity"]) * max(1, int(line.get("stock_multiplier") or 1))
        record = required.setdefault(item_id, {"quantity": 0, "name": line["item_name"]})
        record["quantity"] += quantity

    stock_items: dict[int, sqlite3.Row] = {}
    for item_id, requirement in required.items():
        item = connection.execute(
            "SELECT name,stock,track_stock FROM items WHERE id=?", (item_id,)
        ).fetchone()
        if not item:
            raise APIError(409, f"{requirement['name']} is no longer available.")
        stock_items[item_id] = item
        if not int(item["track_stock"] or 0):
            continue
        before = int(item["stock"] or 0)
        quantity = int(requirement["quantity"])
        if before - quantity < 0:
            raise APIError(409, f"Insufficient stock for {item['name']}: {before} available, {quantity} required.")

    movements: dict[tuple[int, bool, str], dict] = {}
    for line in lines:
        item_id = int(line["product_id"])
        item = stock_items[item_id]
        if not int(item["track_stock"] or 0):
            continue
        is_foc = bool(line.get("is_foc"))
        reason = str(line.get("foc_reason") or "") if is_foc else ""
        key = (item_id, is_foc, reason)
        movement = movements.setdefault(key, {"quantity": 0, "item": item})
        movement["quantity"] += int(line["quantity"]) * max(1, int(line.get("stock_multiplier") or 1))

    for (item_id, is_foc, reason), movement in movements.items():
        item = movement["item"]
        before = int(connection.execute("SELECT stock FROM items WHERE id=?", (item_id,)).fetchone()[0] or 0)
        quantity = int(movement["quantity"])
        after = before - quantity
        connection.execute("UPDATE items SET stock=? WHERE id=?", (after, item_id))
        source_type = "FOC_REPLACEMENT" if is_foc else "SALE"
        notes = f"FOC replacement: {reason}; table {table_code}" if is_foc else f"Web checkout table {table_code}"
        connection.execute(
            """INSERT INTO stock_movements
               (datetime,item_id,item_name,quantity_delta,stock_before,stock_after,
                source_type,reference_id,recorded_by,notes)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (now_audit(), item_id, str(item["name"]), -quantity, before, after, source_type, sale_id,
             recorded_by, notes),
        )


def record_foc_replacements(
    connection: sqlite3.Connection,
    lines: list[dict],
    sale_id: int,
    order_id: int | None,
    biz_date: str,
    timestamp: str,
    authorized_by: str,
    ordered_by: str,
    table_code: str,
) -> dict:
    records = []
    normal_value = Decimal("0.00")
    units = 0
    for line in lines:
        if not line.get("is_foc"):
            continue
        quantity = int(line["quantity"])
        stock_quantity = quantity * max(1, int(line.get("stock_multiplier") or 1))
        unit_price = money_value(line["unit_price"], "FOC normal unit price")
        line_value = (unit_price * quantity).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        connection.execute(
            """INSERT INTO foc_replacements
               (business_date,datetime,sale_id,order_id,line_key,item_id,item_name,display_name,
                category,variant_code,quantity,stock_quantity,normal_unit_price,normal_value,reason,
                authorized_by,ordered_by,table_code,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                biz_date, timestamp, sale_id, order_id, line["line_key"], line["product_id"],
                line["item_name"], line["display_name"], line["category"], line.get("variant_code"),
                quantity, stock_quantity, float(unit_price), float(line_value), line["foc_reason"],
                authorized_by, ordered_by, table_code, now_iso(),
            ),
        )
        records.append({
            "line_key": line["line_key"],
            "display_name": line["display_name"],
            "quantity": quantity,
            "normal_unit_price": float(unit_price),
            "normal_value": float(line_value),
            "reason": line["foc_reason"],
        })
        units += quantity
        normal_value += line_value
    return {"records": records, "units": units, "normal_value": float(normal_value)}


def create_refund_record(
    connection: sqlite3.Connection,
    sale: sqlite3.Row,
    requested: object,
    reason: str,
    actor_name: str,
    session_name: str,
    return_to_stock: bool,
) -> dict:
    """Create an audited refund without mutating the original paid receipt."""
    if not isinstance(requested, list):
        raise APIError(400, "Refund items must be a list.")
    try:
        sold_items = json.loads(sale["items"] or "[]")
    except (TypeError, json.JSONDecodeError):
        raise APIError(409, "The saved sale item data cannot be read safely.")
    sold: dict[str, dict] = {}
    for item in sold_items:
        if not isinstance(item, (list, tuple)) or len(item) < 3:
            continue
        name = str(item[0]).strip(); price = float(item[1] or 0); quantity = int(item[2] or 0)
        category = str(item[3]) if len(item) > 3 else ""
        if name and quantity > 0 and not name.startswith("[FOC] "):
            record = sold.setdefault(name, {"quantity": 0, "price": price, "category": category})
            record["quantity"] += quantity
    refunded: dict[str, int] = {}
    for row in connection.execute("SELECT items FROM refunds WHERE sale_id=?", (int(sale["id"]),)):
        try: prior_items = json.loads(row[0] or "[]")
        except (TypeError, json.JSONDecodeError): prior_items = []
        for item in prior_items:
            if isinstance(item, (list, tuple)) and len(item) >= 3:
                name = str(item[0]).strip(); refunded[name] = refunded.get(name, 0) + int(item[2] or 0)
    requested_by_name: dict[str, int] = {}
    for item in requested:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        try: quantity = int(item.get("qty", 0))
        except (TypeError, ValueError): quantity = 0
        if name and quantity > 0:
            requested_by_name[name] = requested_by_name.get(name, 0) + quantity
    if not requested_by_name:
        raise APIError(400, "Select at least one refund item and quantity.")
    refund_items = []; refund_total = 0.0
    for name, quantity in requested_by_name.items():
        if name not in sold:
            raise APIError(400, f"{name} is not part of this sale.")
        available = max(0, sold[name]["quantity"] - refunded.get(name, 0))
        if quantity > available:
            raise APIError(409, f"Only {available} of {name} remain refundable.")
        refund_items.append([name, sold[name]["price"], quantity])
        refund_total += sold[name]["price"] * quantity
    refund_total = round(refund_total + 1e-9, 2)
    previous_total = float(connection.execute(
        "SELECT COALESCE(SUM(refund_amount),0) FROM refunds WHERE sale_id=?", (int(sale["id"]),)
    ).fetchone()[0] or 0)
    if previous_total + refund_total > float(sale["total"] or 0) + 0.01:
        raise APIError(409, "This refund would exceed the original sale total.")
    payment = str(sale["payment"] or "CASH").upper(); timestamp = now_audit(); biz = sale_business_date(sale["datetime"])
    cursor = connection.execute(
        "INSERT INTO refunds (sale_id,datetime,items,refund_amount,reason,processed_by,payment_method) VALUES (?,?,?,?,?,?,?)",
        (int(sale["id"]), timestamp, json.dumps(refund_items, ensure_ascii=False), refund_total, reason, actor_name, payment),
    )
    refund_id = int(cursor.lastrowid)
    if return_to_stock:
        apply_stock_for_order_items(connection, refund_items, 1, "REFUND", refund_id, actor_name, f"Refund of Sale #{sale['id']}: {reason}")
    connection.execute("INSERT OR IGNORE INTO daily_summary (date,total_sales,transaction_count,cash_total,qr_total,card_total,total_discount) VALUES (?,0,0,0,0,0,0)", (biz,))
    crossed_full = previous_total + 0.005 < float(sale["total"] or 0) and previous_total + refund_total + 0.005 >= float(sale["total"] or 0)
    connection.execute("UPDATE daily_summary SET total_sales=total_sales-?,transaction_count=CASE WHEN ? AND transaction_count>0 THEN transaction_count-1 ELSE transaction_count END WHERE date=?", (refund_total, int(crossed_full), biz))
    payment_column = {"CASH": "cash_total", "QR": "qr_total", "CARD": "card_total"}.get(payment)
    if payment_column:
        connection.execute(f"UPDATE daily_summary SET {payment_column}={payment_column}-? WHERE date=?", (refund_total, biz))
    connection.execute(
        "INSERT INTO cashflow (date,datetime,type,source,reference_id,amount,payment_method,recorded_by,notes) VALUES (?,?,?,?,?,?,?,?,?)",
        (business_date(), now_iso(), "Expense", "Refund", refund_id, refund_total, payment, actor_name, f"Refund Sale #{sale['id']}: {reason}"),
    )
    audit(connection, "REFUND_WEB", f"Sale #{sale['id']} refund #{refund_id} RM{refund_total:.2f}; restocked {return_to_stock}; session {session_name}", actor_name)
    return {"id": refund_id, "amount": refund_total, "items": refund_items, "payment": payment}


def available_modes(role: str) -> list[str]:
    order = ["order", "cashier", "admin"]
    allowed = ROLE_MODES.get(str(role).lower(), {"order"})
    return [mode for mode in order if mode in allowed]


def resolve_payment_staff(connection: sqlite3.Connection, pin: str) -> dict:
    """Resolve the short confirmation PIN used to attribute received money."""
    matches = connection.execute(
        "SELECT staff_id,name,role FROM staff WHERE pin=? AND active=1", (str(pin).strip(),)
    ).fetchall()
    if len(matches) != 1:
        raise APIError(401, "PIN not recognised. Please try again.")
    staff = dict(matches[0])
    if str(staff["role"] or "order").lower() == "order":
        raise APIError(403, "Order-only staff cannot receive payments.")
    staff["initials"] = "".join(part[0] for part in staff["name"].split()[:2]).upper() or "ST"
    return staff


def validate_staff_pin(value) -> str:
    pin = str(value or "").strip()
    if not re.fullmatch(r"\d{1,8}", pin):
        raise APIError(400, "Staff PIN must contain 1 to 8 digits.")
    return pin


def purge_sessions() -> None:
    now = time.time()
    with SESSION_LOCK:
        expired = [
            token for token, session in SESSIONS.items()
            if now - float(session["last_seen"]) > (
                ADMIN_SESSION_TTL_SECONDS if session.get("mode") == "admin" else SESSION_TTL_SECONDS
            ) or now - float(session["created"]) > SESSION_MAX_AGE_SECONDS
        ]
        for token in expired:
            SESSIONS.pop(token, None)
    if expired:
        expired_tokens = set(expired)
        with PAYMENT_AUTH_LOCK:
            for key in [
                key for key, value in PAYMENT_AUTHORIZATIONS.items()
                if value["session_token"] in expired_tokens
            ]:
                PAYMENT_AUTHORIZATIONS.pop(key, None)


def revoke_staff_sessions(staff_id: str) -> None:
    with SESSION_LOCK:
        revoked = [
            token for token, session in SESSIONS.items()
            if str(session.get("staff_id")) == str(staff_id)
        ]
        for token in revoked:
            SESSIONS.pop(token, None)
    if revoked:
        revoked_tokens = set(revoked)
        with PAYMENT_AUTH_LOCK:
            for key in [
                key for key, value in PAYMENT_AUTHORIZATIONS.items()
                if value["session_token"] in revoked_tokens
            ]:
                PAYMENT_AUTHORIZATIONS.pop(key, None)


def accounting_summary(date_from: str, date_to: str) -> dict:
    with connect() as connection:
        row = connection.execute(
            """
            SELECT
              COALESCE(SUM(CASE WHEN type='Income' AND source LIKE 'Sales%' THEN amount ELSE 0 END),0) gross_sales,
              COALESCE(SUM(CASE WHEN type='Expense' AND source='Refund' THEN amount ELSE 0 END),0) refunds,
              COALESCE(SUM(CASE WHEN type='Income' AND source NOT LIKE 'Sales%' THEN amount ELSE 0 END),0) other_income,
              COALESCE(SUM(CASE WHEN type='Expense' AND source!='Refund' THEN amount ELSE 0 END),0) operating_expenses,
              COALESCE(SUM(CASE WHEN type='Income' AND source LIKE 'Sales%' AND UPPER(payment_method)='CASH' THEN amount
                                WHEN type='Expense' AND source='Refund' AND UPPER(payment_method)='CASH' THEN -amount ELSE 0 END),0) cash_sales,
              COALESCE(SUM(CASE WHEN type='Income' AND source LIKE 'Sales%' AND UPPER(payment_method)='QR' THEN amount
                                WHEN type='Expense' AND source='Refund' AND UPPER(payment_method)='QR' THEN -amount ELSE 0 END),0) qr_sales,
              COALESCE(SUM(CASE WHEN type='Income' AND source LIKE 'Sales%' AND UPPER(payment_method)='CARD' THEN amount
                                WHEN type='Expense' AND source='Refund' AND UPPER(payment_method)='CARD' THEN -amount ELSE 0 END),0) card_sales,
              COUNT(*) ledger_rows
            FROM cashflow WHERE date BETWEEN ? AND ?
            """,
            (date_from, date_to),
        ).fetchone()
        foc = connection.execute(
            """SELECT COUNT(*) foc_lines,
                      COALESCE(SUM(quantity),0) foc_units,
                      COALESCE(SUM(normal_value),0) foc_retail_value
                 FROM foc_replacements WHERE business_date BETWEEN ? AND ?""",
            (date_from, date_to),
        ).fetchone()
    result = {key: float(row[key] or 0) if key != "ledger_rows" else int(row[key] or 0) for key in row.keys()}
    result.update({
        "foc_lines": int(foc["foc_lines"] or 0),
        "foc_units": int(foc["foc_units"] or 0),
        "foc_retail_value": float(foc["foc_retail_value"] or 0),
    })
    result["net_sales"] = result["gross_sales"] - result["refunds"]
    result["total_income"] = result["net_sales"] + result["other_income"]
    result["net_profit"] = result["total_income"] - result["operating_expenses"]
    result.update({"date_from": date_from, "date_to": date_to, "generated_at": now_iso()})
    return result


def get_cash_summary(biz_date: str) -> dict:
    with connect() as connection:
        opening_row = connection.execute(
            "SELECT opening_cash,opened_by,opened_at FROM cash_opening WHERE date=? ORDER BY id DESC LIMIT 1",
            (biz_date,),
        ).fetchone()
        flow = connection.execute(
            """
            SELECT
              COALESCE(SUM(CASE WHEN type='Income' AND source LIKE 'Sales%' AND UPPER(payment_method)='CASH' THEN amount
                                WHEN type='Expense' AND source='Refund' AND UPPER(payment_method)='CASH' THEN -amount ELSE 0 END),0) pos_cash,
              COALESCE(SUM(CASE WHEN type='Income' AND source LIKE 'Sales%' AND UPPER(payment_method)='QR' THEN amount
                                WHEN type='Expense' AND source='Refund' AND UPPER(payment_method)='QR' THEN -amount ELSE 0 END),0) qr_sales,
              COALESCE(SUM(CASE WHEN type='Income' AND source LIKE 'Sales%' THEN amount
                                WHEN type='Expense' AND source='Refund' THEN -amount ELSE 0 END),0) net_sales,
              COALESCE(SUM(CASE WHEN type='Income' AND source NOT LIKE 'Sales%' AND UPPER(COALESCE(NULLIF(TRIM(payment_method),''),'CASH'))='CASH' THEN amount ELSE 0 END),0) other_income,
              COALESCE(SUM(CASE WHEN type='Expense' AND source!='Refund' AND UPPER(COALESCE(NULLIF(TRIM(payment_method),''),'CASH'))='CASH' THEN amount ELSE 0 END),0) expenses
            FROM cashflow WHERE date=?
            """,
            (biz_date,),
        ).fetchone()
        qr_rent = float(connection.execute(
            "SELECT COALESCE(SUM(amount),0) FROM rent_payments "
            "WHERE pay_date=? AND COALESCE(voided,0)=0 AND UPPER(TRIM(payment_method))='QR'",
            (biz_date,),
        ).fetchone()[0])
        closing = connection.execute(
            "SELECT * FROM cash_closing WHERE closing_date=? ORDER BY id DESC LIMIT 1",
            (biz_date,),
        ).fetchone()
    opening = float(opening_row["opening_cash"] or 0) if opening_row else 0.0
    pos_cash = float(flow["pos_cash"] or 0)
    other_income = float(flow["other_income"] or 0)
    expenses = float(flow["expenses"] or 0)
    expected = opening + pos_cash + other_income - expenses
    return {
        "date": biz_date,
        "opening_cash": opening,
        "opened_by": opening_row["opened_by"] if opening_row else None,
        "opened_at": opening_row["opened_at"] if opening_row else None,
        "pos_cash": pos_cash,
        "qr_sales": float(flow["qr_sales"] or 0),
        "qr_rent": qr_rent,
        "qr_total": float(flow["qr_sales"] or 0) + qr_rent,
        "net_sales": float(flow["net_sales"] or 0),
        "other_income": other_income,
        "expenses": expenses,
        "expected_cash": expected,
        "closing": dict(closing) if closing else None,
    }


def tenant_status(row: dict) -> dict:
    paid_until = row.get("paid_until_date")
    if not row.get("active"):
        return {"code": "inactive", "label": "Inactive", "days_remaining": None}
    if not paid_until:
        return {"code": "overdue", "label": "No payment yet", "days_remaining": None}
    try:
        remaining = (datetime.strptime(paid_until, "%Y-%m-%d").date() - date.today()).days
    except ValueError:
        return {"code": "unknown", "label": "Check date", "days_remaining": None}
    if remaining < 0:
        return {"code": "overdue", "label": f"Overdue {abs(remaining)}d", "days_remaining": remaining}
    if remaining == 0:
        return {"code": "due", "label": "Due today", "days_remaining": 0}
    if remaining <= 3:
        return {"code": "due", "label": f"Due in {remaining}d", "days_remaining": remaining}
    return {"code": "paid", "label": f"{remaining}d remaining", "days_remaining": remaining}


class POSRequestHandler(SimpleHTTPRequestHandler):
    server_version = "919POSWeb/1.0"

    def log_message(self, format_string: str, *args) -> None:
        sys.stdout.write(f"[{self.log_date_time_string()}] {format_string % args}\n")

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        # Cashier tools are embedded only by this same-origin POS page.
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; "
            "frame-ancestors 'self'; form-action 'self'",
        )
        if os.environ.get("POS_TRUST_HTTPS_PROXY") == "1" and self.headers.get("X-Forwarded-Proto") == "https":
            self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def client_key(self, scope: str) -> str:
        forwarded = ""
        if os.environ.get("POS_TRUST_HTTPS_PROXY") == "1":
            forwarded = self.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
        address = forwarded or str(self.client_address[0])
        return f"{scope}:{address}"

    def verified_payment_staff(self, connection: sqlite3.Connection, pin: str) -> dict:
        limit_key = self.client_key("staff-pin")
        auth_limit_check(limit_key)
        try:
            staff = resolve_payment_staff(connection, pin)
        except APIError:
            auth_limit_failure(limit_key)
            raise
        auth_limit_success(limit_key)
        return staff

    def validate_request_origin(self) -> None:
        if self.headers.get("Sec-Fetch-Site", "").lower() == "cross-site":
            raise APIError(403, "Cross-site requests are not allowed.")
        origin = self.headers.get("Origin", "").strip()
        if not origin:
            return
        parsed = urlparse(origin)
        request_host = self.headers.get("Host", "").lower()
        if parsed.scheme not in {"http", "https"} or parsed.netloc.lower() != request_host:
            raise APIError(403, "Request origin does not match this POS server.")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self.handle_api("GET", parsed.path, parse_qs(parsed.query))
        route_files = {"/": "/login.html", "/pos": "/index.html", "/admin": "/admin.html"}
        if parsed.path in route_files:
            self.path = route_files[parsed.path]
        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self.handle_api("POST", parsed.path, parse_qs(parsed.query))
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self.handle_api("PUT", parsed.path, parse_qs(parsed.query))
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self.handle_api("DELETE", parsed.path, parse_qs(parsed.query))
        self.send_error(HTTPStatus.NOT_FOUND)

    def read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise APIError(400, "Invalid request length")
        if length < 0 or length > 8_000_000:
            raise APIError(413, "Request is too large")
        if length == 0:
            return {}
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise APIError(400, "Invalid JSON body")
        if not isinstance(payload, dict):
            raise APIError(400, "JSON request body must be an object")
        return payload

    def send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file_bytes(self, body: bytes, filename: str, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def bearer_token(self) -> str:
        auth_header = self.headers.get("Authorization", "")
        return auth_header[7:].strip() if auth_header.startswith("Bearer ") else ""

    def session(self, modes: set[str] | None = None, roles: set[str] | None = None) -> dict:
        purge_sessions()
        token = self.bearer_token()
        with SESSION_LOCK:
            session = SESSIONS.get(token)
            if session:
                session["last_seen"] = time.time()
        if not session:
            raise APIError(401, "Your session has expired. Please log in again.")
        if modes and session["mode"] not in modes:
            raise APIError(403, "This action is not available in the current workspace.")
        if roles and session["role"] not in roles:
            raise APIError(403, "Your staff role does not permit this action.")
        return session

    def handle_api(self, method: str, path: str, query: dict) -> None:
        try:
            if method in {"POST", "PUT", "DELETE"}:
                self.validate_request_origin()
            result = self.dispatch_api(method, path, query)
            if result is not None:
                self.send_json(result)
        except APIError as error:
            self.send_json({"error": error.message, **error.details}, error.status)
        except sqlite3.IntegrityError as error:
            self.send_json({"error": f"Database rule prevented this change: {error}"}, 409)
        except Exception as error:
            print(f"API error {method} {path}: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
            message = "The request could not be completed."
            if os.environ.get("POS_WEB_DEBUG") == "1":
                message = f"{message} {type(error).__name__}: {error}"
            self.send_json({"error": message}, 500)

    def dispatch_api(self, method: str, path: str, query: dict):
        if method == "GET" and path == "/api/public/status":
            with connect() as connection:
                connection.execute("SELECT 1").fetchone()
                public_settings = load_shop_settings(connection)
            return {
                "online": True,
                "business_date": business_date(),
                "database": DB_PATH.name,
                "modes": ["order", "cashier", "admin"],
                "admin_password_required": configured_admin_password(),
                "shop_name": public_settings["shop_name"],
                "currency": public_settings["currency"],
                "business_day_start": public_settings["business_day_start"],
            }

        if method == "POST" and path == "/api/auth/login":
            limit_key = self.client_key("login")
            auth_limit_check(limit_key)
            payload = self.read_json()
            pin = str(payload.get("pin", "")).strip()
            requested_mode = str(payload.get("mode", "")).strip().lower()
            if requested_mode not in {"order", "cashier", "admin"}:
                raise APIError(400, "Choose a valid workspace.")
            with connect() as connection:
                matches = connection.execute(
                    "SELECT staff_id,name,role FROM staff WHERE pin=? AND active=1", (pin,)
                ).fetchall()
                if len(matches) != 1:
                    audit(connection, "WEB_LOGIN_FAILED", f"Mode {requested_mode}; PIN match count {len(matches)}", "Unknown")
                    connection.commit()
                    auth_limit_failure(limit_key)
                    raise APIError(401, "PIN not recognised.")
                staff = matches[0]
                role = str(staff["role"] or "order").lower()
                if requested_mode not in ROLE_MODES.get(role, {"order"}):
                    audit(connection, "WEB_LOGIN_DENIED", f"{staff['staff_id']} requested {requested_mode}", staff["name"])
                    connection.commit()
                    auth_limit_failure(limit_key)
                    raise APIError(403, f"{staff['name']} does not have access to the {requested_mode.title()} workspace.")
                if requested_mode == "admin" and configured_admin_password() and not verify_admin_password(payload.get("password", "")):
                    audit(connection, "WEB_LOGIN_FAILED", f"Admin password rejected for {staff['staff_id']}", staff["name"])
                    connection.commit()
                    auth_limit_failure(limit_key)
                    raise APIError(401, "Admin password not recognised.")
                audit(connection, "WEB_LOGIN", f"Opened {requested_mode} workspace", staff["name"])
            auth_limit_success(limit_key)
            token = secrets.token_urlsafe(32)
            session = {
                "token": token,
                "staff_id": staff["staff_id"],
                "name": staff["name"],
                "role": role,
                "mode": requested_mode,
                "modes": available_modes(role),
                "created": time.time(),
                "last_seen": time.time(),
            }
            with SESSION_LOCK:
                SESSIONS[token] = session
            return {"token": token, "session": {key: value for key, value in session.items() if key not in {"token", "created", "last_seen"}}}

        if method == "GET" and path == "/api/auth/me":
            session = self.session()
            return {"session": {key: value for key, value in session.items() if key not in {"token", "created", "last_seen"}}}

        if method == "POST" and path == "/api/auth/logout":
            session = self.session()
            token = self.bearer_token()
            with connect() as connection:
                audit(connection, "WEB_LOGOUT", f"Closed {session['mode']} workspace", session["name"])
            with SESSION_LOCK:
                SESSIONS.pop(token, None)
            with PAYMENT_AUTH_LOCK:
                for key in [key for key, value in PAYMENT_AUTHORIZATIONS.items() if value["session_token"] == token]:
                    PAYMENT_AUTHORIZATIONS.pop(key, None)
            return {"ok": True}

        if method == "POST" and path == "/api/auth/switch-mode":
            session = self.session()
            mode = str(self.read_json().get("mode", "")).lower()
            if mode not in session["modes"]:
                raise APIError(403, "Your role cannot open that workspace.")
            session["mode"] = mode
            with connect() as connection:
                audit(connection, "WEB_MODE_SWITCH", f"Switched to {mode} workspace", session["name"])
            return {"session": {key: value for key, value in session.items() if key not in {"token", "created", "last_seen"}}}

        if method == "POST" and path == "/api/auth/payment-identity":
            session = self.session(modes={"cashier", "admin"})
            limit_key = self.client_key("staff-pin")
            auth_limit_check(limit_key)
            payload = self.read_json()
            pin = str(payload.get("pin", "")).strip()
            try:
                order_id = int(payload.get("order_id", 0))
            except (TypeError, ValueError):
                order_id = 0
            payment = str(payload.get("payment", "")).strip().upper()
            if payment not in {"CASH", "QR", "FOC"}:
                raise APIError(400, "Choose CASH, QR, or FOC before identifying the cashier.")
            with connect() as connection:
                try:
                    staff = resolve_payment_staff(connection, pin)
                except APIError:
                    auth_limit_failure(limit_key)
                    raise
                order = connection.execute("SELECT id,status FROM held_orders WHERE id=?", (order_id,)).fetchone()
                if not order or str(order["status"]).upper() != "HELD":
                    raise APIError(409, "This unpaid order is no longer available.")
            auth_limit_success(limit_key)
            approval_token = secrets.token_urlsafe(32)
            with PAYMENT_AUTH_LOCK:
                PAYMENT_AUTHORIZATIONS[approval_token] = {
                    "session_token": self.bearer_token(),
                    "staff": staff,
                    "order_id": order_id,
                    "payment": payment,
                    "expires": time.time() + PAYMENT_AUTH_TTL_SECONDS,
                }
            return {"staff": staff, "payment_token": approval_token, "expires_in": PAYMENT_AUTH_TTL_SECONDS}

        # Every endpoint below requires an authenticated workspace.
        if method == "GET" and path == "/api/pos/catalog":
            self.session(modes={"order", "cashier"})
            with connect() as connection:
                items = rows_to_dict(connection.execute(
                    """SELECT i.id,i.name,i.price,i.category,i.stock,i.low_stock_threshold,
                              i.track_stock,i.barcode,i.image_path,
                              CASE WHEN pc.show_list_price=1 THEN ? END AS list_unit_price
                       FROM items i LEFT JOIN product_categories pc ON pc.name=i.category
                       WHERE i.active=1 ORDER BY i.category,i.name""",
                    (LIST_PRICE,),
                ))
                categories = rows_to_dict(connection.execute(
                    "SELECT id,name,icon,color,sort_order FROM product_categories WHERE active=1 ORDER BY sort_order,name"
                ))
                known_categories = {str(row["name"]).casefold() for row in categories}
                palette = ["#64748B", "#0F766E", "#7C3AED", "#B45309", "#BE123C"]
                for index, row in enumerate(connection.execute(
                    "SELECT DISTINCT category FROM items WHERE active=1 AND TRIM(category)<>'' ORDER BY category"
                )):
                    name = str(row[0]).strip()
                    if name.casefold() not in known_categories:
                        categories.append({"id": None, "name": name, "icon": "📦", "color": palette[index % len(palette)], "sort_order": 999})
                tables = rows_to_dict(connection.execute(
                    "SELECT id,table_code,sort_order FROM dining_tables WHERE active=1 ORDER BY sort_order,table_code"
                ))
                variants = rows_to_dict(connection.execute(
                    """SELECT iv.id,iv.item_id,iv.variant_name,iv.price_adjustment
                       FROM item_variants iv JOIN items i ON i.id=iv.item_id
                       WHERE i.active=1 ORDER BY iv.item_id,iv.id"""
                ))
                quantity_sets = rows_to_dict(connection.execute(
                    """SELECT qs.id,qs.item_id,qs.quantity,qs.set_price
                       FROM item_quantity_sets qs JOIN items i ON i.id=qs.item_id
                       WHERE i.active=1 ORDER BY qs.item_id,qs.quantity"""
                ))
                settings = load_shop_settings(connection)
            return {"items": items, "categories": categories, "tables": tables, "variants": variants, "quantity_sets": quantity_sets, "settings": settings}

        if method == "GET" and path == "/api/pos/orders":
            self.session(modes={"order", "cashier"})
            with connect() as connection:
                rows = connection.execute(
                    "SELECT * FROM held_orders WHERE status='HELD' ORDER BY updated_at DESC,id DESC"
                ).fetchall()
                orders = [order_response(connection, row) for row in rows]
            return {"orders": orders, "count": len(orders), "business_date": business_date()}

        if method == "POST" and path == "/api/pos/orders":
            session = self.session(modes={"order", "cashier"})
            payload = self.read_json()
            note = str(payload.get("note", "")).strip()
            if len(note) > 500:
                raise APIError(400, "Order note cannot exceed 500 characters.")
            with connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                table_code = validate_table(connection, payload.get("table_code", ""))
                existing = connection.execute(
                    "SELECT * FROM held_orders WHERE status='HELD' AND table_code=? COLLATE NOCASE ORDER BY id DESC LIMIT 1",
                    (table_code,),
                ).fetchone()
                if existing:
                    raise APIError(
                        409,
                        f"Table {table_code} already has an unpaid order. Reload it before making changes.",
                        {"current_order": order_response(connection, existing)},
                    )
                lines = normalize_order_lines(connection, payload.get("items", []))
                if not lines:
                    raise APIError(400, "Add at least one item before saving this order.")
                subtotal, discount, tax, total = order_amounts(lines, payload.get("discount", 0))
                timestamp = now_audit()
                cursor = connection.execute(
                    """INSERT INTO held_orders
                       (created_at,updated_at,cashier,items,subtotal,tax,total,note,status,table_code,
                        discount,version,origin,updated_by)
                       VALUES (?,?,?,?,?,?,?,?, 'HELD', ?,?,1,'WEB',?)""",
                    (timestamp, timestamp, session["name"], order_items_json(lines), subtotal, tax, total,
                     note, table_code, discount, session["name"]),
                )
                order_id = int(cursor.lastrowid)
                replace_order_lines(connection, order_id, lines)
                audit(connection, "WEB_ORDER_CREATE", f"Order #{order_id} table {table_code} RM{total:.2f}", session["name"])
                row = connection.execute("SELECT * FROM held_orders WHERE id=?", (order_id,)).fetchone()
                result = order_response(connection, row)
            return {"order": result}

        order_match = re.fullmatch(r"/api/pos/orders/(\d+)", path)
        if order_match and method == "GET":
            self.session(modes={"order", "cashier"})
            order_id = int(order_match.group(1))
            with connect() as connection:
                row = connection.execute("SELECT * FROM held_orders WHERE id=?", (order_id,)).fetchone()
                if not row:
                    raise APIError(404, "Order not found.")
                result = order_response(connection, row)
            return {"order": result}

        if order_match and method == "PUT":
            session = self.session(modes={"order", "cashier"})
            order_id = int(order_match.group(1))
            payload = self.read_json()
            note = str(payload.get("note", "")).strip()
            if len(note) > 500:
                raise APIError(400, "Order note cannot exceed 500 characters.")
            try:
                expected_version = int(payload.get("expected_version", 0))
            except (TypeError, ValueError):
                expected_version = 0
            with connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute("SELECT * FROM held_orders WHERE id=?", (order_id,)).fetchone()
                if not row:
                    raise APIError(404, "Order not found.")
                if str(row["status"]).upper() != "HELD":
                    raise APIError(409, "This order has already been completed or cancelled.", {"current_order": order_response(connection, row)})
                if expected_version != int(row["version"] or 1):
                    raise APIError(409, "This order changed on another device. The latest version has been loaded.", {"current_order": order_response(connection, row)})
                table_code = validate_table(connection, payload.get("table_code", row["table_code"]))
                lines = normalize_order_lines(connection, payload.get("items", []))
                if not lines:
                    raise APIError(400, "An unpaid order must contain at least one item.")
                subtotal, discount, tax, total = order_amounts(lines, payload.get("discount", row["discount"] or 0))
                timestamp = now_audit()
                connection.execute(
                    """UPDATE held_orders
                       SET updated_at=?,cashier=?,items=?,subtotal=?,tax=?,total=?,note=?,table_code=?,
                           discount=?,version=version+1,origin='WEB',updated_by=?
                       WHERE id=? AND version=? AND status='HELD'""",
                    (timestamp, session["name"], order_items_json(lines), subtotal, tax, total, note,
                     table_code, discount, session["name"], order_id, expected_version),
                )
                replace_order_lines(connection, order_id, lines)
                updated = connection.execute("SELECT * FROM held_orders WHERE id=?", (order_id,)).fetchone()
                result = order_response(connection, updated)
            return {"order": result}

        order_action_match = re.fullmatch(r"/api/pos/orders/(\d+)/(hold|cancel|checkout)", path)
        if order_action_match and method == "POST" and order_action_match.group(2) == "hold":
            session = self.session(modes={"order", "cashier"})
            order_id = int(order_action_match.group(1))
            payload = self.read_json()
            with connect() as connection:
                row = connection.execute("SELECT * FROM held_orders WHERE id=?", (order_id,)).fetchone()
                if not row or str(row["status"]).upper() != "HELD":
                    raise APIError(409, "This unpaid order is no longer available.")
                if int(payload.get("expected_version", 0)) != int(row["version"] or 1):
                    raise APIError(409, "This order changed on another device. Reload before holding it.", {"current_order": order_response(connection, row)})
                audit(connection, "WEB_ORDER_HOLD", f"Order #{order_id} table {row['table_code']} RM{float(row['total'] or 0):.2f}", session["name"])
                result = order_response(connection, row)
            return {"order": result}

        if order_action_match and method == "POST" and order_action_match.group(2) == "cancel":
            session = self.session(modes={"order", "cashier"})
            order_id = int(order_action_match.group(1))
            payload = self.read_json()
            reason = str(payload.get("reason", "Order cleared")).strip()[:300] or "Order cleared"
            try:
                expected_version = int(payload.get("expected_version", 0))
            except (TypeError, ValueError):
                expected_version = 0
            with connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute("SELECT * FROM held_orders WHERE id=?", (order_id,)).fetchone()
                if not row:
                    raise APIError(404, "Order not found.")
                if str(row["status"]).upper() != "HELD":
                    raise APIError(409, "This order has already been completed or cancelled.")
                if expected_version != int(row["version"] or 1):
                    raise APIError(409, "This order changed on another device. Reload before clearing it.", {"current_order": order_response(connection, row)})
                timestamp = now_audit()
                connection.execute(
                    "UPDATE held_orders SET status='CANCELLED',updated_at=?,updated_by=?,version=version+1 WHERE id=? AND version=?",
                    (timestamp, session["name"], order_id, expected_version),
                )
                audit(connection, "WEB_ORDER_CANCEL", f"Order #{order_id} table {row['table_code']}; {reason}", session["name"])
            return {"ok": True, "order_id": order_id, "status": "CANCELLED"}

        if order_action_match and method == "POST" and order_action_match.group(2) == "checkout":
            session = self.session(modes={"cashier"})
            order_id = int(order_action_match.group(1))
            payload = self.read_json()
            payment = str(payload.get("payment", "")).strip().upper()
            if payment not in {"CASH", "QR", "FOC"}:
                raise APIError(400, "Choose CASH, QR, or FOC.")
            request_id = str(payload.get("idempotency_key", "")).strip()
            if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", request_id):
                raise APIError(400, "A valid checkout request key is required.")
            try:
                expected_version = int(payload.get("expected_version", 0))
            except (TypeError, ValueError):
                expected_version = 0
            approval_token = str(payload.get("payment_token", ""))
            approval_to_consume = None
            with connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                prior = connection.execute(
                    "SELECT order_id,response_json FROM web_checkout_requests WHERE request_id=?", (request_id,)
                ).fetchone()
                if prior:
                    if int(prior["order_id"]) != order_id:
                        raise APIError(409, "This checkout request key was already used for another order.")
                    return json.loads(prior["response_json"])
                row = connection.execute("SELECT * FROM held_orders WHERE id=?", (order_id,)).fetchone()
                if not row:
                    raise APIError(404, "Order not found.")
                if str(row["status"]).upper() != "HELD":
                    raise APIError(409, "This order has already been completed or cancelled.")
                if expected_version != int(row["version"] or 1):
                    raise APIError(409, "This order changed on another device. Review the latest order before payment.", {"current_order": order_response(connection, row)})
                authorization = payment_authorization(approval_token, self.bearer_token(), order_id, payment)
                approval_to_consume = approval_token
                receiver = authorization["staff"]
                lines = load_order_lines(connection, row)
                if not lines:
                    raise APIError(409, "This order has no readable items.")
                subtotal, discount, tax, total = order_amounts(lines, row["discount"] or 0)
                all_foc = bool(lines) and all(bool(line.get("is_foc")) for line in lines)
                if payment == "FOC" and (not all_foc or Decimal(str(total)) != Decimal("0.00")):
                    raise APIError(400, "FOC checkout is only for an order containing zero-charge FOC replacements.")
                if payment != "FOC" and all_foc:
                    raise APIError(400, "Use FOC checkout for an order containing only FOC replacements.")
                received = (
                    money_value(payload.get("cash_received", 0), "Cash received")
                    if payment == "CASH" else Decimal(str(total))
                )
                if payment == "CASH" and received < Decimal(str(total)):
                    raise APIError(400, "Cash received is less than the order total.")
                timestamp = now_audit()
                timestamp_iso = now_iso()
                biz = business_date()
                items_json = order_items_json(lines)
                list_prices = list_prices_for_sale(connection, (line["category"] for line in lines))
                cursor = connection.execute(
                    """INSERT INTO sales (datetime,total,payment,items,discount,tax,cashier,table_code,category_list_prices)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (timestamp, total, payment, items_json, discount, tax, receiver["name"], row["table_code"],
                     json.dumps(list_prices)),
                )
                sale_id = int(cursor.lastrowid)
                apply_stock_for_web_lines(connection, lines, sale_id, receiver["name"], str(row["table_code"] or ""))
                foc_summary = record_foc_replacements(
                    connection, lines, sale_id, order_id, biz, timestamp, receiver["name"],
                    str(row["cashier"] or session["name"]), str(row["table_code"] or ""),
                )
                if payment != "FOC":
                    connection.execute(
                        """INSERT INTO cashflow
                           (date,datetime,type,source,reference_id,amount,payment_method,recorded_by,notes,supplier)
                           VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        (biz, timestamp_iso, "Income", "Sales", sale_id, total, payment, receiver["name"],
                         f"Web order #{order_id} table {row['table_code']}; {str(row['note'] or '').strip()}", ""),
                    )
                    connection.execute(
                        """INSERT OR IGNORE INTO daily_summary
                           (date,total_sales,transaction_count,cash_total,qr_total,card_total,total_discount)
                           VALUES (?,0,0,0,0,0,0)""",
                        (biz,),
                    )
                    payment_column = {"CASH": "cash_total", "QR": "qr_total"}[payment]
                    connection.execute(
                        f"""UPDATE daily_summary
                             SET total_sales=total_sales+?,transaction_count=transaction_count+1,
                                 {payment_column}={payment_column}+?,total_discount=total_discount+?
                             WHERE date=?""",
                        (total, total, discount, biz),
                    )
                connection.execute(
                    """UPDATE held_orders
                       SET status='PAID',updated_at=?,updated_by=?,version=version+1,sale_id=?,checkout_key=?
                       WHERE id=? AND version=? AND status='HELD'""",
                    (timestamp, receiver["name"], sale_id, request_id, order_id, expected_version),
                )
                change = float((received - Decimal(str(total))).quantize(Decimal("0.01"))) if payment == "CASH" else 0.0
                response = {
                    "ok": True,
                    "sale_id": sale_id,
                    "receipt_number": str(sale_id),
                    "order_id": order_id,
                    "order_version": expected_version + 1,
                    "table_code": str(row["table_code"] or ""),
                    "business_date": biz,
                    "datetime": timestamp,
                    "cashier": receiver,
                    "payment": payment,
                    "subtotal": subtotal,
                    "discount": discount,
                    "tax": tax,
                    "total": total,
                    "cash_received": float(received) if payment == "CASH" else None,
                    "change": change,
                    "note": str(row["note"] or ""),
                    "foc": foc_summary,
                    "items": [
                        {**line, "list_unit_price": list_prices.get(line["category"]) if not line.get("is_foc") else None}
                        for line in lines
                    ],
                }
                connection.execute(
                    """INSERT INTO web_checkout_requests
                       (request_id,order_id,sale_id,session_staff_id,created_at,response_json)
                       VALUES (?,?,?,?,?,?)""",
                    (request_id, order_id, sale_id, session["staff_id"], timestamp_iso,
                     json.dumps(response, ensure_ascii=False)),
                )
                if foc_summary["units"]:
                    reasons = "; ".join(dict.fromkeys(
                        str(item["reason"]) for item in foc_summary["records"]
                    ))
                    audit(
                        connection, "FOC_REPLACEMENT",
                        f"Sale #{sale_id} order #{order_id} table {row['table_code']}; "
                        f"{foc_summary['units']} item(s), normal retail RM{foc_summary['normal_value']:.2f}; {reasons}",
                        receiver["name"],
                    )
                audit(
                    connection,
                    "WEB_FOC" if payment == "FOC" else "WEB_SALE",
                    f"Sale #{sale_id} order #{order_id} table {row['table_code']} RM{total:.2f} {payment}",
                    receiver["name"],
                )
            if approval_to_consume:
                with PAYMENT_AUTH_LOCK:
                    PAYMENT_AUTHORIZATIONS.pop(approval_to_consume, None)
            return response

        if method == "GET" and path == "/api/admin/overview":
            session = self.session(modes={"admin"})
            biz = business_date()
            month_start = biz[:8] + "01"
            with connect() as connection:
                counts = {
                    "active_items": connection.execute("SELECT COUNT(*) FROM items WHERE active=1").fetchone()[0],
                    "active_staff": connection.execute("SELECT COUNT(*) FROM staff WHERE active=1").fetchone()[0],
                    "unpaid_orders": connection.execute("SELECT COUNT(*) FROM held_orders WHERE status='HELD'").fetchone()[0],
                    "low_stock": connection.execute("SELECT COUNT(*) FROM items WHERE active=1 AND track_stock=1 AND stock<=low_stock_threshold").fetchone()[0],
                    "active_tenants": connection.execute("SELECT COUNT(*) FROM rent_tenants WHERE active=1").fetchone()[0],
                }
                overdue = 0
                for row in connection.execute("SELECT paid_until_date FROM rent_tenants WHERE active=1"):
                    if not row[0] or row[0] < date.today().isoformat():
                        overdue += 1
                counts["overdue_tenants"] = overdue
                recent_audit = rows_to_dict(connection.execute("SELECT id,timestamp,action,details,user FROM audit_log ORDER BY id DESC LIMIT 8"))
            return {
                "business_date": biz,
                "counts": counts,
                "today_cash": get_cash_summary(biz),
                "month": accounting_summary(month_start, biz),
                "recent_audit": recent_audit,
                "session": {key: value for key, value in session.items() if key not in {"token", "created", "last_seen"}},
            }

        if method == "GET" and path == "/api/accounting/summary":
            self.session(modes={"admin"})
            date_from = query.get("from", [business_date()[:8] + "01"])[0]
            date_to = query.get("to", [business_date()])[0]
            return accounting_summary(date_from, date_to)

        if method == "GET" and path == "/api/accounting/foc":
            self.session(modes={"admin"})
            date_from = iso_date_value(query.get("from", [business_date()[:8] + "01"])[0], "From date")
            date_to = iso_date_value(query.get("to", [business_date()])[0], "To date")
            if date_from > date_to:
                raise APIError(400, "From date cannot be after To date.")
            with connect() as connection:
                rows = rows_to_dict(connection.execute(
                    """SELECT id,business_date,datetime,sale_id,order_id,item_name,display_name,category,
                              quantity,stock_quantity,normal_unit_price,normal_value,reason,
                              authorized_by,ordered_by,table_code
                         FROM foc_replacements
                        WHERE business_date BETWEEN ? AND ? ORDER BY business_date DESC,id DESC""",
                    (date_from, date_to),
                ))
            return {
                "rows": rows,
                "count": len(rows),
                "units": sum(int(row["quantity"] or 0) for row in rows),
                "normal_value": float(sum(
                    money_value(row["normal_value"], "FOC normal value") for row in rows
                )),
                "date_from": date_from,
                "date_to": date_to,
            }

        if method == "GET" and path == "/api/accounting/transactions":
            self.session(modes={"admin"})
            date_from = query.get("from", [business_date()[:8] + "01"])[0]
            date_to = query.get("to", [business_date()])[0]
            tx_type = query.get("type", [""])[0]
            search = query.get("search", [""])[0].strip()
            sql = "SELECT id,date,datetime,type,source,amount,payment_method,recorded_by,notes,supplier,reference_id FROM cashflow WHERE date BETWEEN ? AND ?"
            params: list = [date_from, date_to]
            if tx_type in {"Income", "Expense"}:
                sql += " AND type=?"; params.append(tx_type)
            if search:
                sql += " AND (source LIKE ? OR supplier LIKE ? OR notes LIKE ? OR recorded_by LIKE ?)"
                like = f"%{search}%"; params.extend([like, like, like, like])
            sql += " ORDER BY date DESC,id DESC LIMIT 500"
            with connect() as connection:
                rows = rows_to_dict(connection.execute(sql, params))
            return {"rows": rows, "count": len(rows)}

        if method == "GET" and path == "/api/accounting/categories":
            self.session(modes={"cashier", "admin"})
            with connect() as connection:
                return {"rows": rows_to_dict(connection.execute("SELECT id,name,type FROM cashflow_categories ORDER BY type,name"))}

        if method == "POST" and path == "/api/accounting/transactions":
            session = self.session(modes={"admin"})
            payload = self.read_json()
            tx_type = str(payload.get("type", "")).title()
            source = str(payload.get("source", "")).strip()
            payment = str(payload.get("payment_method", "CASH")).upper()
            tx_date = iso_date_value(payload.get("date", business_date()), "Transaction date")
            amount = float(money_value(payload.get("amount", 0)))
            if tx_type not in {"Income", "Expense"} or not source or amount <= 0 or payment not in {"CASH", "QR", "CARD", "BANK"}:
                raise APIError(400, "Type, category, and a positive amount are required.")
            with connect() as connection:
                cursor = connection.execute(
                    """INSERT INTO cashflow (date,datetime,type,source,amount,payment_method,recorded_by,notes,supplier)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (tx_date, now_iso(), tx_type, source, amount, payment, session["name"], str(payload.get("notes", "")).strip(), str(payload.get("supplier", "")).strip()),
                )
                audit(connection, "WEB_LEDGER_ADD", f"{tx_type} #{cursor.lastrowid} {source} RM{amount:.2f}", session["name"])
            return {"ok": True, "id": cursor.lastrowid}

        transaction_match = re.fullmatch(r"/api/accounting/transactions/(\d+)", path)
        if transaction_match and method in {"PUT", "DELETE"}:
            session = self.session(modes={"admin"}, roles={"admin"})
            row_id = int(transaction_match.group(1))
            payload = self.read_json()
            with connect() as connection:
                existing = connection.execute("SELECT * FROM cashflow WHERE id=?", (row_id,)).fetchone()
                if not existing:
                    raise APIError(404, "Ledger row not found.")
                payroll_link = connection.execute(
                    "SELECT id,slip_no,status FROM payroll_slips WHERE cashflow_id=?",
                    (row_id,),
                ).fetchone()
                if payroll_link:
                    raise APIError(409, f"This ledger row belongs to salary slip {payroll_link['slip_no']}. Use Payroll to void it safely.")
                if method == "DELETE":
                    reason = str(payload.get("reason", "")).strip()
                    if not reason:
                        raise APIError(400, "A deletion reason is required.")
                    connection.execute("DELETE FROM cashflow WHERE id=?", (row_id,))
                    audit(connection, "WEB_LEDGER_DELETE", f"#{row_id} {existing['type']} {existing['source']} RM{float(existing['amount']):.2f}; {reason}", session["name"])
                else:
                    tx_type = str(payload.get("type", existing["type"])).title()
                    amount = float(money_value(payload.get("amount", existing["amount"])))
                    source = str(payload.get("source", existing["source"])).strip()
                    payment = str(payload.get("payment_method", existing["payment_method"])).upper()
                    tx_date = iso_date_value(payload.get("date", existing["date"]), "Transaction date")
                    if tx_type not in {"Income", "Expense"} or amount <= 0 or not source or payment not in {"CASH", "QR", "CARD", "BANK"}:
                        raise APIError(400, "Enter valid transaction details.")
                    connection.execute(
                        """UPDATE cashflow SET date=?,type=?,source=?,amount=?,payment_method=?,notes=?,supplier=?,recorded_by=? WHERE id=?""",
                        (tx_date, tx_type, source, amount, payment, str(payload.get("notes", existing["notes"] or "")), str(payload.get("supplier", existing["supplier"] or "")), session["name"], row_id),
                    )
                    audit(connection, "WEB_LEDGER_EDIT", f"#{row_id} {tx_type} {source} RM{amount:.2f}", session["name"])
            return {"ok": True}

        if method == "POST" and path == "/api/accounting/categories":
            session = self.session(modes={"admin"})
            payload = self.read_json(); name = str(payload.get("name", "")).strip(); tx_type = str(payload.get("type", "")).title()
            if not name or tx_type not in {"Income", "Expense"}: raise APIError(400, "Name and type are required.")
            with connect() as connection:
                duplicate = connection.execute("SELECT id FROM cashflow_categories WHERE LOWER(name)=LOWER(?) AND type=?", (name, tx_type)).fetchone()
                if duplicate: raise APIError(409, "That accounting category already exists.")
                cursor = connection.execute("INSERT INTO cashflow_categories (name,type) VALUES (?,?)", (name, tx_type))
                audit(connection, "WEB_FLOW_CATEGORY_ADD", f"{tx_type}: {name}", session["name"])
            return {"ok": True, "id": cursor.lastrowid}

        flow_category_match = re.fullmatch(r"/api/accounting/categories/(\d+)", path)
        if flow_category_match and method in {"PUT", "DELETE"}:
            session = self.session(modes={"admin"}, roles={"admin"}); category_id = int(flow_category_match.group(1)); payload = self.read_json()
            with connect() as connection:
                current = connection.execute("SELECT * FROM cashflow_categories WHERE id=?", (category_id,)).fetchone()
                if not current: raise APIError(404, "Accounting category not found.")
                if method == "DELETE":
                    reason = str(payload.get("reason", "")).strip()
                    if not reason: raise APIError(400, "A deletion reason is required.")
                    connection.execute("DELETE FROM cashflow_categories WHERE id=?", (category_id,))
                    audit(connection, "WEB_FLOW_CATEGORY_DELETE", f"{current['type']}: {current['name']}; {reason}", session["name"])
                else:
                    name = str(payload.get("name", current["name"])).strip(); tx_type = str(payload.get("type", current["type"])).title()
                    if not name or tx_type not in {"Income", "Expense"}: raise APIError(400, "Name and type are required.")
                    duplicate = connection.execute("SELECT id FROM cashflow_categories WHERE LOWER(name)=LOWER(?) AND type=? AND id<>?", (name, tx_type, category_id)).fetchone()
                    if duplicate: raise APIError(409, "That accounting category already exists.")
                    connection.execute("UPDATE cashflow_categories SET name=?,type=? WHERE id=?", (name, tx_type, category_id))
                    audit(connection, "WEB_FLOW_CATEGORY_EDIT", f"#{category_id} {tx_type}: {name}", session["name"])
            return {"ok": True}

        if method == "GET" and path == "/api/payroll/employees":
            self.session(modes={"admin"}, roles={"admin"})
            with connect() as connection:
                rows = rows_to_dict(connection.execute(
                    """SELECT pe.*,
                              (SELECT COUNT(*) FROM payroll_slips ps WHERE ps.employee_id=pe.id AND ps.status<>'VOID') slip_count,
                              (SELECT MAX(period_end) FROM payroll_slips ps WHERE ps.employee_id=pe.id AND ps.status='PAID') last_paid_period
                         FROM payroll_employees pe
                        ORDER BY pe.active DESC,pe.full_name,pe.id"""
                ))
            for row in rows:
                row["compliance"] = payroll_employee_compliance(row)
            return {"rows": rows}

        if method == "POST" and path == "/api/payroll/employees":
            session = self.session(modes={"admin"}, roles={"admin"}); payload = self.read_json()
            values = payroll_employee_values(payload)
            columns = tuple(values.keys())
            with connect() as connection:
                if connection.execute("SELECT id FROM payroll_employees WHERE employee_code=? COLLATE NOCASE", (values["employee_code"],)).fetchone():
                    raise APIError(409, "That employee code already exists.")
                now = now_iso()
                cursor = connection.execute(
                    f"INSERT INTO payroll_employees ({','.join(columns)},created_at,updated_at) VALUES ({','.join('?' for _ in columns)},?,?)",
                    tuple(values[name] for name in columns) + (now, now),
                )
                employee_id = int(cursor.lastrowid)
                audit(connection, "PAYROLL_EMPLOYEE_ADD", f"Employee #{employee_id} {values['employee_code']} {values['full_name']}", session["name"])
            return {"ok": True, "id": employee_id}

        payroll_employee_match = re.fullmatch(r"/api/payroll/employees/(\d+)", path)
        if payroll_employee_match and method == "PUT":
            session = self.session(modes={"admin"}, roles={"admin"}); employee_id = int(payroll_employee_match.group(1)); payload = self.read_json()
            with connect() as connection:
                current = connection.execute("SELECT * FROM payroll_employees WHERE id=?", (employee_id,)).fetchone()
                if not current: raise APIError(404, "Payroll employee not found.")
                values = payroll_employee_values(payload, current)
                if connection.execute("SELECT id FROM payroll_employees WHERE employee_code=? COLLATE NOCASE AND id<>?", (values["employee_code"], employee_id)).fetchone():
                    raise APIError(409, "That employee code already exists.")
                columns = tuple(values.keys())
                connection.execute(
                    f"UPDATE payroll_employees SET {','.join(f'{name}=?' for name in columns)},updated_at=? WHERE id=?",
                    tuple(values[name] for name in columns) + (now_iso(), employee_id),
                )
                audit(connection, "PAYROLL_EMPLOYEE_EDIT", f"Employee #{employee_id} {values['employee_code']} {values['full_name']}; active {values['active']}", session["name"])
            return {"ok": True}

        if method == "GET" and path == "/api/payroll/slips":
            self.session(modes={"admin"}, roles={"admin"})
            month = str(query.get("month", [business_date()[:7]])[0]).strip()
            if month and not re.fullmatch(r"\d{4}-\d{2}", month): raise APIError(400, "Payroll month must use YYYY-MM.")
            status_filter = str(query.get("status", [""])[0]).strip().upper()
            sql = """SELECT ps.*,pe.employee_code,pe.full_name,pe.identification_no,
                              pe.employment_type,pe.citizenship_status,pe.nationality,
                              pe.passport_no,pe.passport_expiry,pe.work_pass_no,pe.work_pass_expiry,
                              pe.epf_treatment,pe.statutory_basis,pe.designation,pe.department
                       FROM payroll_slips ps JOIN payroll_employees pe ON pe.id=ps.employee_id WHERE 1=1"""
            params: list = []
            if month:
                sql += " AND substr(ps.period_start,1,7)=?"; params.append(month)
            if status_filter in {"DRAFT", "PAID", "VOID"}:
                sql += " AND ps.status=?"; params.append(status_filter)
            sql += " ORDER BY ps.period_start DESC,pe.full_name,ps.id DESC LIMIT 500"
            with connect() as connection:
                rows = rows_to_dict(connection.execute(sql, params))
            for row in rows:
                if row["status"] != "DRAFT":
                    snapshot = parse_payroll_snapshot(row.get("employee_snapshot"))
                    for name in PAYROLL_EMPLOYEE_SNAPSHOT_FIELDS:
                        if name in snapshot:
                            row[name] = snapshot[name]
                row["compliance"] = payroll_employee_compliance(row, row.get("pay_date"))
            summary = {
                "draft_count": sum(1 for row in rows if row["status"] == "DRAFT"),
                "paid_count": sum(1 for row in rows if row["status"] == "PAID"),
                "void_count": sum(1 for row in rows if row["status"] == "VOID"),
                "paid_net": round(sum(float(row["net_pay"] or 0) for row in rows if row["status"] == "PAID"), 2),
                "gross_pay": round(sum(float(row["gross_pay"] or 0) for row in rows if row["status"] != "VOID"), 2),
            }
            return {"rows": rows, "month": month, "summary": summary}

        if method == "POST" and path == "/api/payroll/slips":
            session = self.session(modes={"admin"}, roles={"admin"}); payload = self.read_json()
            try: employee_id = int(payload.get("employee_id", 0))
            except (TypeError, ValueError): employee_id = 0
            values = payroll_slip_values(payload)
            with connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                employee = connection.execute("SELECT * FROM payroll_employees WHERE id=?", (employee_id,)).fetchone()
                if not employee or not int(employee["active"] or 0): raise APIError(409, "Choose an active payroll employee.")
                if connection.execute("SELECT id FROM payroll_slips WHERE employee_id=? AND period_start=? AND period_end=? AND status<>'VOID'", (employee_id, values["period_start"], values["period_end"])).fetchone():
                    raise APIError(409, "This employee already has a non-void salary slip for that pay period.")
                next_id = int(connection.execute("SELECT COALESCE(MAX(id),0)+1 FROM payroll_slips").fetchone()[0])
                slip_no = f"PAY-{str(values['period_start'])[:7].replace('-', '')}-{next_id:05d}"
                now = now_iso(); columns = PAYROLL_SLIP_VALUE_FIELDS
                cursor = connection.execute(
                    f"""INSERT INTO payroll_slips
                          (slip_no,employee_id,{','.join(columns)},status,created_at,created_by,updated_at,updated_by)
                          VALUES (?,?,{','.join('?' for _ in columns)},'DRAFT',?,?,?,?)""",
                    (slip_no, employee_id) + tuple(values[name] for name in columns) + (now, session["name"], now, session["name"]),
                )
                slip_id = int(cursor.lastrowid)
                connection.execute(
                    "UPDATE payroll_slips SET employee_snapshot=?,employer_snapshot=? WHERE id=?",
                    (
                        json.dumps(payroll_employee_snapshot(employee), ensure_ascii=False),
                        json.dumps(payroll_employer_snapshot(load_shop_settings(connection)), ensure_ascii=False),
                        slip_id,
                    ),
                )
                audit(connection, "PAYROLL_SLIP_CREATE", f"{slip_no} {employee['full_name']} {values['period_start']} to {values['period_end']}; net RM{values['net_pay']:.2f}", session["name"])
            return {"ok": True, "id": slip_id, "slip_no": slip_no, "status": "DRAFT", "gross_pay": values["gross_pay"], "net_pay": values["net_pay"]}

        payroll_slip_match = re.fullmatch(r"/api/payroll/slips/(\d+)", path)
        if payroll_slip_match and method in {"GET", "PUT"}:
            session = self.session(modes={"admin"}, roles={"admin"}); slip_id = int(payroll_slip_match.group(1))
            if method == "GET":
                with connect() as connection:
                    slip = connection.execute("SELECT * FROM payroll_slips WHERE id=?", (slip_id,)).fetchone()
                    if not slip: raise APIError(404, "Salary slip not found.")
                    employee = connection.execute("SELECT * FROM payroll_employees WHERE id=?", (slip["employee_id"],)).fetchone()
                    settings = load_shop_settings(connection)
                employee_data = dict(employee)
                if slip["status"] != "DRAFT":
                    employee_data.update(parse_payroll_snapshot(slip["employee_snapshot"]))
                    settings.update(parse_payroll_snapshot(slip["employer_snapshot"]))
                return {
                    "slip": dict(slip), "employee": employee_data, "settings": settings,
                    "compliance": payroll_employee_compliance(employee_data, slip["pay_date"]),
                }
            payload = self.read_json()
            with connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                current = connection.execute("SELECT * FROM payroll_slips WHERE id=?", (slip_id,)).fetchone()
                if not current: raise APIError(404, "Salary slip not found.")
                if current["status"] != "DRAFT": raise APIError(409, "Only a draft salary slip can be edited.")
                values = payroll_slip_values(payload, current); columns = PAYROLL_SLIP_VALUE_FIELDS
                duplicate = connection.execute("SELECT id FROM payroll_slips WHERE employee_id=? AND period_start=? AND period_end=? AND status<>'VOID' AND id<>?", (current["employee_id"], values["period_start"], values["period_end"], slip_id)).fetchone()
                if duplicate: raise APIError(409, "This employee already has a non-void salary slip for that pay period.")
                connection.execute(
                    f"UPDATE payroll_slips SET {','.join(f'{name}=?' for name in columns)},updated_at=?,updated_by=? WHERE id=?",
                    tuple(values[name] for name in columns) + (now_iso(), session["name"], slip_id),
                )
                audit(connection, "PAYROLL_SLIP_EDIT", f"{current['slip_no']}; net RM{values['net_pay']:.2f}", session["name"])
            return {"ok": True, "id": slip_id, "net_pay": values["net_pay"]}

        payroll_pay_match = re.fullmatch(r"/api/payroll/slips/(\d+)/pay", path)
        if payroll_pay_match and method == "POST":
            session = self.session(modes={"admin"}, roles={"admin"}); slip_id = int(payroll_pay_match.group(1)); payload = self.read_json()
            record_mode = str(payload.get("record_mode", "POSTED")).strip().upper()
            if record_mode not in PAYROLL_PAYMENT_RECORD_MODES:
                raise APIError(400, "Choose whether to post, link, or historically record this payment.")
            payment_method = str(payload.get("payment_method", "BANK")).strip().upper()
            if payment_method not in {"CASH", "BANK"}: raise APIError(400, "Salary payment must use CASH or BANK.")
            payment_reference = str(payload.get("payment_reference", "") or "").strip()
            compliance_override = str(payload.get("compliance_override_reason", "") or "").strip()
            if len(payment_reference) > 300 or len(compliance_override) > 500:
                raise APIError(400, "Payment reference or compliance note is too long.")
            with connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                actor = self.verified_payment_staff(connection, str(payload.get("pin", "")))
                if str(actor["role"]).lower() != "admin": raise APIError(403, "An Admin PIN is required to record salary payment.")
                slip = connection.execute("SELECT * FROM payroll_slips WHERE id=?", (slip_id,)).fetchone()
                if not slip: raise APIError(404, "Salary slip not found.")
                if slip["status"] != "DRAFT": raise APIError(409, "Only a draft salary slip can be marked paid.")
                employee = connection.execute("SELECT * FROM payroll_employees WHERE id=?", (slip["employee_id"],)).fetchone()
                pay_date = iso_date_value(payload.get("pay_date", slip["pay_date"]), "Pay date")
                if pay_date > date.today().isoformat():
                    raise APIError(400, "Actual payment date cannot be in the future.")
                net_pay = float(money_value(slip["net_pay"], "Net pay"))
                if net_pay <= 0: raise APIError(409, "A salary payment must have positive net pay.")
                now = now_iso()
                cashflow_id = None
                if record_mode == "LINKED":
                    try:
                        existing_cashflow_id = int(payload.get("existing_cashflow_id", 0))
                    except (TypeError, ValueError):
                        existing_cashflow_id = 0
                    linked = connection.execute("SELECT * FROM cashflow WHERE id=?", (existing_cashflow_id,)).fetchone()
                    if not linked or str(linked["type"]).title() != "Expense":
                        raise APIError(409, "Choose an existing Accounting expense row.")
                    if money_value(linked["amount"]) != money_value(net_pay):
                        raise APIError(409, "The linked expense amount must exactly match this net salary.")
                    linked_method = str(linked["payment_method"] or "").upper()
                    if linked_method not in {"CASH", "BANK"}:
                        raise APIError(409, "The linked salary expense must use CASH or BANK.")
                    already_linked = connection.execute(
                        "SELECT slip_no FROM payroll_slips WHERE cashflow_id=? AND status<>'VOID' AND id<>?",
                        (existing_cashflow_id, slip_id),
                    ).fetchone()
                    if already_linked:
                        raise APIError(409, f"That expense is already linked to {already_linked['slip_no']}.")
                    cashflow_id = existing_cashflow_id
                    pay_date = iso_date_value(linked["date"], "Linked expense date")
                    payment_method = linked_method
                    payment_reference = payment_reference or f"Accounting #{existing_cashflow_id}"
                elif record_mode == "HISTORICAL":
                    if len(payment_reference) < 5:
                        raise APIError(400, "Enter a bank, voucher, or legacy-record reference for a historical payment.")

                compliance = payroll_employee_compliance(employee, pay_date)
                if compliance["blockers"] and record_mode != "HISTORICAL":
                    raise APIError(
                        409,
                        "Payroll compliance details must be resolved before recording a new or linked payment.",
                        {"compliance_issues": compliance["blockers"]},
                    )
                if compliance["blockers"] and len(compliance_override) < 10:
                    raise APIError(
                        409,
                        "Historical records with incomplete compliance details require a clear audit note.",
                        {"compliance_issues": compliance["blockers"]},
                    )
                if str(employee["epf_treatment"] or "PENDING_REVIEW").upper() == "REQUIRED":
                    missing_epf_share = float(slip["employee_epf"] or 0) <= 0 or float(slip["employer_epf"] or 0) <= 0
                    if missing_epf_share and len(str(slip["epf_zero_reason"] or "").strip()) < 10:
                        raise APIError(409, "Explain why an employee marked EPF required has a zero employee or employer EPF share.")

                if record_mode == "POSTED":
                    cashflow = connection.execute(
                        """INSERT INTO cashflow
                           (date,datetime,type,source,reference_id,amount,payment_method,recorded_by,notes,supplier)
                           VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        (pay_date, now, "Expense", "Salary Payment", slip_id, net_pay, payment_method, actor["name"],
                         f"{slip['slip_no']} · {slip['period_start']} to {slip['period_end']}"
                         + (f" · {payment_reference}" if payment_reference else ""), employee["full_name"]),
                    )
                    cashflow_id = int(cashflow.lastrowid)
                connection.execute(
                    """UPDATE payroll_slips SET status='PAID',pay_date=?,payment_method=?,payment_record_mode=?,
                              payment_reference=?,compliance_override_reason=?,cashflow_id=?,
                              employee_snapshot=?,employer_snapshot=?,paid_at=?,paid_by=?,updated_at=?,updated_by=?
                        WHERE id=?""",
                    (
                        pay_date, payment_method, record_mode, payment_reference, compliance_override, cashflow_id,
                        json.dumps(payroll_employee_snapshot(employee), ensure_ascii=False),
                        json.dumps(payroll_employer_snapshot(load_shop_settings(connection)), ensure_ascii=False),
                        now, actor["name"], now, actor["name"], slip_id,
                    ),
                )
                audit(connection, "PAYROLL_SLIP_PAID", f"{slip['slip_no']} {employee['full_name']} RM{net_pay:.2f} {payment_method} mode {record_mode}; session {session['name']}", actor["name"])
            return {
                "ok": True, "id": slip_id, "status": "PAID", "payment_method": payment_method,
                "record_mode": record_mode, "cashflow_id": cashflow_id,
                "paid_by": actor["name"], "net_pay": net_pay,
            }

        payroll_void_match = re.fullmatch(r"/api/payroll/slips/(\d+)/void", path)
        if payroll_void_match and method == "POST":
            session = self.session(modes={"admin"}, roles={"admin"}); slip_id = int(payroll_void_match.group(1)); payload = self.read_json()
            reason = str(payload.get("reason", "")).strip()
            if not reason or len(reason) > 300: raise APIError(400, "Enter a void reason up to 300 characters.")
            with connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                actor = self.verified_payment_staff(connection, str(payload.get("pin", "")))
                if str(actor["role"]).lower() != "admin": raise APIError(403, "An Admin PIN is required to void a salary slip.")
                slip = connection.execute("SELECT * FROM payroll_slips WHERE id=?", (slip_id,)).fetchone()
                if not slip: raise APIError(404, "Salary slip not found.")
                if slip["status"] == "VOID": raise APIError(409, "This salary slip is already void.")
                employee = connection.execute("SELECT full_name FROM payroll_employees WHERE id=?", (slip["employee_id"],)).fetchone()
                record_mode = str(slip["payment_record_mode"] or "POSTED").upper()
                if slip["status"] == "PAID" and record_mode == "POSTED":
                    removed = connection.execute("DELETE FROM cashflow WHERE id=? AND source='Salary Payment' AND reference_id=?", (slip["cashflow_id"], slip_id))
                    if removed.rowcount != 1: raise APIError(409, "The linked salary payment is missing. Resolve the accounting record before voiding.")
                now = now_iso()
                connection.execute(
                    """UPDATE payroll_slips SET status='VOID',cashflow_id=NULL,voided_at=?,voided_by=?,void_reason=?,
                              updated_at=?,updated_by=? WHERE id=?""",
                    (now, actor["name"], reason, now, actor["name"], slip_id),
                )
                audit(connection, "PAYROLL_SLIP_VOID", f"{slip['slip_no']} {employee['full_name'] if employee else ''}; previous {slip['status']} mode {record_mode}; {reason}; session {session['name']}", actor["name"])
            return {"ok": True, "id": slip_id, "status": "VOID", "voided_by": actor["name"]}

        if method == "GET" and path == "/api/cash/summary":
            self.session(modes={"cashier", "admin"})
            return get_cash_summary(query.get("date", [business_date()])[0])

        if method == "GET" and path == "/api/cash/entries":
            self.session(modes={"cashier", "admin"})
            biz = query.get("date", [business_date()])[0]
            with connect() as connection:
                rows = rows_to_dict(connection.execute("SELECT id,datetime,type,category,amount,description,recorded_by,supplier FROM cash_transactions WHERE date=? ORDER BY id DESC LIMIT 200", (biz,)))
            return {"date": biz, "rows": rows}

        if method == "POST" and path == "/api/cash/opening":
            session = self.session(modes={"cashier", "admin"})
            payload = self.read_json(); biz = iso_date_value(payload.get("date", business_date()), "Business date")
            amount = float(money_value(payload.get("amount", 0), "Opening cash"))
            if amount < 0: raise APIError(400, "Opening cash must be zero or more.")
            with connect() as connection:
                existing = connection.execute("SELECT id FROM cash_opening WHERE date=?", (biz,)).fetchone()
                if existing and session["mode"] != "admin": raise APIError(403, "Opening cash is locked. Open the Admin workspace to replace it.")
                connection.execute("DELETE FROM cash_opening WHERE date=?", (biz,))
                connection.execute("INSERT INTO cash_opening (date,opening_cash,opened_by,opened_at) VALUES (?,?,?,?)", (biz, amount, session["name"], now_iso()))
                audit(connection, "CASH_OPEN", f"Opening Cash RM {amount:.2f}", session["name"])
            return {"ok": True, "summary": get_cash_summary(biz)}

        if method == "POST" and path == "/api/cash/entry":
            session = self.session(modes={"cashier", "admin"})
            payload = self.read_json(); tx_type = str(payload.get("type", "")).title(); category = str(payload.get("category", "")).strip()
            amount = float(money_value(payload.get("amount", 0)))
            if tx_type not in {"Income", "Expense"} or not category or amount <= 0: raise APIError(400, "Type, category, and a positive amount are required.")
            biz = iso_date_value(payload.get("date", business_date()), "Business date"); description = str(payload.get("notes", "")).strip(); supplier = str(payload.get("supplier", "")).strip()
            with connect() as connection:
                cursor = connection.execute("INSERT INTO cash_transactions (datetime,type,category,amount,description,recorded_by,date,supplier) VALUES (?,?,?,?,?,?,?,?)", (now_iso(), tx_type.lower(), category, amount, description, session["name"], biz, supplier))
                reference_id = cursor.lastrowid
                connection.execute("INSERT INTO cashflow (date,datetime,type,source,reference_id,amount,payment_method,recorded_by,notes,supplier) VALUES (?,?,?,?,?,?,?,?,?,?)", (biz, now_iso(), tx_type, category, reference_id, amount, "CASH", session["name"], description, supplier))
                audit(connection, tx_type.upper(), f"{category} RM{amount:.2f} {description}", session["name"])
            return {"ok": True, "id": reference_id, "summary": get_cash_summary(biz)}

        if method == "POST" and path == "/api/cash/close":
            session = self.session(modes={"cashier", "admin"})
            payload = self.read_json(); biz = iso_date_value(payload.get("date", business_date()), "Business date"); summary = get_cash_summary(biz)
            if payload.get("actual_cash") is None or payload.get("actual_cash") == "":
                raise APIError(400, "Enter the actual counted cash.")
            actual = float(money_value(payload.get("actual_cash"), "Actual counted cash"))
            if actual < 0: raise APIError(400, "Actual counted cash cannot be negative.")
            if summary["closing"] and session["mode"] != "admin": raise APIError(409, "This business day is already closed. Open the Admin workspace to close it again.")
            difference = actual - summary["expected_cash"]
            with connect() as connection:
                connection.execute("INSERT INTO cash_closing (closing_date,opening_cash,pos_cash,other_income,expenses,expected_cash,actual_cash,difference,cashier,notes,closed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", (biz, summary["opening_cash"], summary["pos_cash"], summary["other_income"], summary["expenses"], summary["expected_cash"], actual, difference, session["name"], str(payload.get("notes", "Web cash close")), now_iso()))
                audit(connection, "DAY_CLOSE", f"Expected RM{summary['expected_cash']:.2f}; Actual RM{actual:.2f}; Difference RM{difference:.2f}", session["name"])
            return {"ok": True, "summary": get_cash_summary(biz)}

        if method == "GET" and path == "/api/rent/tenants":
            self.session(modes={"cashier", "admin"})
            with connect() as connection:
                rows = rows_to_dict(connection.execute("SELECT * FROM rent_tenants ORDER BY active DESC,stall_no,name"))
            for row in rows: row["status"] = tenant_status(row)
            return {"rows": rows}

        if method == "GET" and path == "/api/rent/payments":
            self.session(modes={"cashier", "admin"})
            date_from = query.get("from", [business_date()[:8] + "01"])[0]; date_to = query.get("to", [business_date()])[0]
            with connect() as connection:
                rows = rows_to_dict(connection.execute("SELECT * FROM rent_payments WHERE pay_date BETWEEN ? AND ? ORDER BY id DESC LIMIT 500", (date_from, date_to)))
            return {"rows": rows}

        if method == "POST" and path == "/api/rent/tenants":
            session = self.session(modes={"admin"})
            payload = self.read_json(); name = str(payload.get("name", "")).strip(); rental_type = str(payload.get("rental_type", "Daily")).title()
            rate = float(money_value(payload.get("daily_rate", 0), "Rental rate"))
            start_date = iso_date_value(payload.get("start_date", business_date()), "Rental start date")
            if not name or rental_type not in {"Daily", "Monthly"} or rate < 0: raise APIError(400, "Enter a name, rental type, and valid rate.")
            with connect() as connection:
                cursor = connection.execute("INSERT INTO rent_tenants (name,stall_no,rental_type,daily_rate,start_date,notes,active) VALUES (?,?,?,?,?,?,1)", (name, str(payload.get("stall_no", "")).strip(), rental_type, rate, start_date, str(payload.get("notes", "")).strip()))
                audit(connection, "RENT_TENANT_ADD", f"{name}; stall {payload.get('stall_no','')}", session["name"])
            return {"ok": True, "id": cursor.lastrowid}

        tenant_match = re.fullmatch(r"/api/rent/tenants/(\d+)", path)
        if tenant_match and method in {"PUT", "DELETE"}:
            session = self.session(modes={"admin"}); tenant_id = int(tenant_match.group(1)); payload = self.read_json()
            with connect() as connection:
                current = connection.execute("SELECT * FROM rent_tenants WHERE id=?", (tenant_id,)).fetchone()
                if not current: raise APIError(404, "Tenant not found.")
                if method == "DELETE":
                    reason = str(payload.get("reason", "")).strip()
                    if not reason: raise APIError(400, "A deletion reason is required.")
                    connection.execute("DELETE FROM rent_tenants WHERE id=?", (tenant_id,))
                    audit(connection, "RENT_TENANT_DELETE", f"Tenant #{tenant_id} {current['name']}; payment history kept; {reason}", session["name"])
                    return {"ok": True}
                values = {key: payload.get(key, current[key]) for key in ["name","stall_no","rental_type","daily_rate","start_date","notes","active"]}
                rental_type = str(values["rental_type"]).title()
                rate = float(money_value(values["daily_rate"], "Rental rate"))
                start_date = iso_date_value(values["start_date"], "Rental start date")
                if rental_type not in {"Daily", "Monthly"} or not str(values["name"]).strip() or rate < 0:
                    raise APIError(400, "Enter a valid tenant name, rental type, and rate.")
                connection.execute("UPDATE rent_tenants SET name=?,stall_no=?,rental_type=?,daily_rate=?,start_date=?,notes=?,active=? WHERE id=?", (str(values["name"]).strip(), str(values["stall_no"] or "").strip(), rental_type, rate, start_date, str(values["notes"] or "").strip(), int(bool(int(values["active"]))), tenant_id))
                audit(connection, "RENT_TENANT_EDIT", f"Tenant #{tenant_id} {values['name']}", session["name"])
            return {"ok": True}

        if method == "POST" and path == "/api/rent/sync":
            session = self.session(modes={"admin"}, roles={"admin"}); updated = 0
            with connect() as connection:
                for tenant in connection.execute("SELECT * FROM rent_tenants"):
                    units = float(connection.execute("SELECT COALESCE(SUM(days),0) FROM rent_payments WHERE tenant_id=? AND COALESCE(voided,0)=0", (tenant["id"],)).fetchone()[0] or 0)
                    start_text = str(tenant["start_date"] or "").strip()
                    if not start_text:
                        continue
                    try: start_date = datetime.strptime(start_text, "%Y-%m-%d").date()
                    except ValueError: continue
                    if str(tenant["rental_type"] or "").lower() == "monthly":
                        if not units.is_integer(): raise APIError(409, f"Tenant {tenant['name']} has a fractional monthly payment.")
                        paid_until = month_shift(start_date, int(units))
                    else:
                        paid_until = start_date + timedelta(days=units)
                    connection.execute("UPDATE rent_tenants SET total_days_paid=?,paid_until_date=? WHERE id=?", (units, paid_until.isoformat(), tenant["id"]))
                    updated += 1
                audit(connection, "RENT_SYNC_DATES", f"Recalculated {updated} tenant rent dates", session["name"])
            return {"ok": True, "updated": updated}

        if method == "POST" and path == "/api/rent/collect":
            session = self.session(modes={"cashier", "admin"}); payload = self.read_json(); tenant_id = int(payload.get("tenant_id", 0))
            units = finite_number(payload.get("units", 0), "Rental units")
            if units <= 0: raise APIError(400, "Enter a positive number of rental units.")
            staff_pin = str(payload.get("pin", "")).strip()
            if not staff_pin: raise APIError(400, "Enter the receiving staff PIN.")
            biz = business_date(); timestamp = now_iso()
            with connect() as connection:
                receiver = self.verified_payment_staff(connection, staff_pin)
                tenant = connection.execute("SELECT * FROM rent_tenants WHERE id=? AND active=1", (tenant_id,)).fetchone()
                if not tenant: raise APIError(404, "Active tenant not found.")
                is_monthly = str(tenant["rental_type"]).lower() == "monthly"
                if is_monthly and not units.is_integer(): raise APIError(400, "Monthly rent must use whole months.")
                amount = units * float(tenant["daily_rate"] or 0)
                cursor = connection.execute("INSERT INTO rent_payments (tenant_id,tenant_name,stall_no,days,rate,amount,pay_date,datetime,recorded_by,notes,voided) VALUES (?,?,?,?,?,?,?,?,?,?,0)", (tenant_id, tenant["name"], tenant["stall_no"] or "", units, tenant["daily_rate"], amount, biz, timestamp, receiver["name"], str(payload.get("notes", f"{tenant['name']} +{units:g}"))))
                payment_id = cursor.lastrowid
                base_text = tenant["paid_until_date"] or tenant["start_date"] or biz
                try: base_date = datetime.strptime(base_text, "%Y-%m-%d").date()
                except ValueError: base_date = date.today()
                new_paid = month_shift(base_date, int(units)) if is_monthly else base_date + timedelta(days=units)
                connection.execute("UPDATE rent_tenants SET paid_until_date=?,total_days_paid=total_days_paid+?,last_payment_date=? WHERE id=?", (new_paid.isoformat(), units, biz, tenant_id))
                connection.execute("INSERT INTO cashflow (date,datetime,type,source,reference_id,amount,payment_method,recorded_by,notes) VALUES (?,?,?,?,?,?,?,?,?)", (biz, timestamp, "Income", "Stall Rental", payment_id, amount, "CASH", receiver["name"], f"Rent {tenant['name']} Stall {tenant['stall_no'] or ''}"))
                audit(connection, "RENT_COLLECT", f"RM{amount:.2f} from {tenant['name']} ({units:g}{'m' if is_monthly else 'd'}); session {session['name']}", receiver["name"])
            return {"ok": True, "payment_id": payment_id, "amount": amount, "paid_until": new_paid.isoformat(), "received_by": receiver["name"]}

        void_match = re.fullmatch(r"/api/rent/payments/(\d+)/void", path)
        if void_match and method == "POST":
            session = self.session(modes={"admin"}, roles={"admin"}); payment_id = int(void_match.group(1)); payload = self.read_json(); reason = str(payload.get("reason", "")).strip()
            if not reason: raise APIError(400, "A void reason is required.")
            with connect() as connection:
                payment = connection.execute("SELECT * FROM rent_payments WHERE id=?", (payment_id,)).fetchone()
                if not payment or int(payment["voided"] or 0): raise APIError(404, "Active rental payment not found.")
                connection.execute("UPDATE rent_payments SET voided=1 WHERE id=?", (payment_id,))
                tenant = connection.execute("SELECT * FROM rent_tenants WHERE id=?", (payment["tenant_id"],)).fetchone()
                if tenant:
                    cursor_date = datetime.strptime(tenant["start_date"] or business_date(), "%Y-%m-%d").date()
                    total_units = 0.0
                    for active_payment in connection.execute("SELECT days FROM rent_payments WHERE tenant_id=? AND COALESCE(voided,0)=0 ORDER BY id", (tenant["id"],)):
                        units = float(active_payment[0] or 0); total_units += units
                        cursor_date = month_shift(cursor_date, int(units)) if str(tenant["rental_type"]).lower() == "monthly" else cursor_date + timedelta(days=units)
                    connection.execute("UPDATE rent_tenants SET total_days_paid=?,paid_until_date=? WHERE id=?", (total_units, cursor_date.isoformat(), tenant["id"]))
                connection.execute("DELETE FROM cashflow WHERE source='Stall Rental' AND reference_id=?", (payment_id,))
                audit(connection, "VOID_RENT_WEB", f"Rent #{payment_id} RM{float(payment['amount'] or 0):.2f}; {reason}", session["name"])
            return {"ok": True}

        if method == "GET" and path == "/api/stock/items":
            self.session(modes={"cashier", "admin"})
            search = query.get("search", [""])[0].strip(); tracked = query.get("tracked", [""])[0]
            sql = "SELECT id,name,price,category,stock,low_stock_threshold,active,track_stock,barcode,image_path FROM items WHERE 1=1"; params=[]
            if tracked == "1": sql += " AND active=1 AND track_stock=1"
            if search: sql += " AND name LIKE ?"; params.append(f"%{search}%")
            sql += " ORDER BY active DESC,category,name LIMIT 500"
            with connect() as connection:
                rows = rows_to_dict(connection.execute(sql, params))
                item_ids = [int(row["id"]) for row in rows]
                if item_ids:
                    placeholders = ",".join("?" for _ in item_ids)
                    variants = rows_to_dict(connection.execute(
                        f"SELECT id,item_id,variant_name,price_adjustment FROM item_variants WHERE item_id IN ({placeholders}) ORDER BY item_id,id",
                        item_ids,
                    ))
                    quantity_sets = rows_to_dict(connection.execute(
                        f"SELECT id,item_id,quantity,set_price FROM item_quantity_sets WHERE item_id IN ({placeholders}) ORDER BY item_id,quantity",
                        item_ids,
                    ))
                else:
                    variants = []; quantity_sets = []
            for row in rows:
                row["status"] = "not-tracked" if not row["track_stock"] else ("out" if row["stock"] <= 0 else ("low" if row["stock"] <= row["low_stock_threshold"] else "ok"))
            return {"rows": rows, "variants": variants, "quantity_sets": quantity_sets}

        item_options_match = re.fullmatch(r"/api/stock/items/(\d+)/options", path)
        if item_options_match and method == "GET":
            self.session(modes={"admin"}, roles={"admin"}); item_id = int(item_options_match.group(1))
            with connect() as connection:
                item = connection.execute("SELECT id,name,price,active FROM items WHERE id=?", (item_id,)).fetchone()
                if not item: raise APIError(404, "Item not found.")
                variants = rows_to_dict(connection.execute("SELECT id,item_id,variant_name,price_adjustment FROM item_variants WHERE item_id=? ORDER BY id", (item_id,)))
                quantity_sets = rows_to_dict(connection.execute("SELECT id,item_id,quantity,set_price FROM item_quantity_sets WHERE item_id=? ORDER BY quantity,id", (item_id,)))
            base_price = money_value(item["price"], "Base price")
            for row in variants:
                row["final_price"] = float((base_price + money_value(row["price_adjustment"], "Price adjustment")).quantize(Decimal("0.01")))
            return {"item": dict(item), "variants": variants, "quantity_sets": quantity_sets}

        if item_options_match and method == "POST":
            session = self.session(modes={"admin"}, roles={"admin"}); item_id = int(item_options_match.group(1)); payload = self.read_json()
            option_type = str(payload.get("type", "variant")).strip().lower()
            with connect() as connection:
                item = connection.execute("SELECT id,name,price FROM items WHERE id=?", (item_id,)).fetchone()
                if not item: raise APIError(404, "Item not found.")
                if option_type == "variant":
                    name = str(payload.get("name", "")).strip(); adjustment = money_value(payload.get("price_adjustment", 0), "Price adjustment")
                    if not name or len(name) > 60: raise APIError(400, "Enter a variant name up to 60 characters.")
                    if money_value(item["price"], "Base price") + adjustment < 0: raise APIError(400, "The final variant price cannot be negative.")
                    if connection.execute("SELECT id FROM item_variants WHERE item_id=? AND variant_name=? COLLATE NOCASE", (item_id, name)).fetchone(): raise APIError(409, "That variant already exists for this item.")
                    cursor = connection.execute("INSERT INTO item_variants (item_id,variant_name,price_adjustment) VALUES (?,?,?)", (item_id, name, float(adjustment)))
                    audit(connection, "ITEM_VARIANT_ADD", f"Item #{item_id} {item['name']}: {name} adjustment RM{float(adjustment):.2f}", session["name"])
                    return {"ok": True, "id": cursor.lastrowid, "type": "variant"}
                if option_type == "set":
                    try: quantity = int(payload.get("quantity", 0))
                    except (TypeError, ValueError): quantity = 0
                    set_price = money_value(payload.get("set_price", 0), "Set price")
                    if quantity < 2 or quantity > 999: raise APIError(400, "Set quantity must be between 2 and 999.")
                    if set_price <= 0: raise APIError(400, "Set price must be greater than zero.")
                    if connection.execute("SELECT id FROM item_quantity_sets WHERE item_id=? AND quantity=?", (item_id, quantity)).fetchone(): raise APIError(409, "That set quantity already exists for this item.")
                    cursor = connection.execute("INSERT INTO item_quantity_sets (item_id,quantity,set_price) VALUES (?,?,?)", (item_id, quantity, float(set_price)))
                    audit(connection, "ITEM_SET_ADD", f"Item #{item_id} {item['name']}: set {quantity} RM{float(set_price):.2f}", session["name"])
                    return {"ok": True, "id": cursor.lastrowid, "type": "set"}
                raise APIError(400, "Option type must be variant or set.")

        variant_option_match = re.fullmatch(r"/api/stock/variants/(\d+)", path)
        if variant_option_match and method in {"PUT", "DELETE"}:
            session = self.session(modes={"admin"}, roles={"admin"}); variant_id = int(variant_option_match.group(1)); payload = self.read_json()
            with connect() as connection:
                current = connection.execute("SELECT iv.*,i.name item_name,i.price base_price FROM item_variants iv JOIN items i ON i.id=iv.item_id WHERE iv.id=?", (variant_id,)).fetchone()
                if not current: raise APIError(404, "Variant not found.")
                busy = active_order_using_option(
                    connection,
                    f"variant-{variant_id}",
                    (f'{current["item_name"]} ({current["variant_name"]})',),
                )
                if busy: raise APIError(409, f"Table {busy['table_code'] or '?'} has an unpaid order using this variant. Complete or clear it first.")
                if method == "DELETE":
                    connection.execute("DELETE FROM item_variants WHERE id=?", (variant_id,))
                    audit(connection, "ITEM_VARIANT_DELETE", f"Item #{current['item_id']} {current['item_name']}: {current['variant_name']}", session["name"])
                    return {"ok": True}
                name = str(payload.get("name", current["variant_name"])).strip(); adjustment = money_value(payload.get("price_adjustment", current["price_adjustment"]), "Price adjustment")
                if not name or len(name) > 60: raise APIError(400, "Enter a variant name up to 60 characters.")
                if money_value(current["base_price"], "Base price") + adjustment < 0: raise APIError(400, "The final variant price cannot be negative.")
                if connection.execute("SELECT id FROM item_variants WHERE item_id=? AND variant_name=? COLLATE NOCASE AND id<>?", (current["item_id"], name, variant_id)).fetchone(): raise APIError(409, "That variant already exists for this item.")
                connection.execute("UPDATE item_variants SET variant_name=?,price_adjustment=? WHERE id=?", (name, float(adjustment), variant_id))
                audit(connection, "ITEM_VARIANT_EDIT", f"Item #{current['item_id']} {current['item_name']}: {current['variant_name']}->{name}; RM{float(adjustment):.2f}", session["name"])
            return {"ok": True}

        set_option_match = re.fullmatch(r"/api/stock/sets/(\d+)", path)
        if set_option_match and method in {"PUT", "DELETE"}:
            session = self.session(modes={"admin"}, roles={"admin"}); set_id = int(set_option_match.group(1)); payload = self.read_json()
            with connect() as connection:
                current = connection.execute("SELECT qs.*,i.name item_name FROM item_quantity_sets qs JOIN items i ON i.id=qs.item_id WHERE qs.id=?", (set_id,)).fetchone()
                if not current: raise APIError(404, "Quantity set not found.")
                busy = active_order_using_option(
                    connection,
                    f"set-{set_id}",
                    (f'{current["item_name"]} Set({current["quantity"]})',),
                )
                if busy: raise APIError(409, f"Table {busy['table_code'] or '?'} has an unpaid order using this set. Complete or clear it first.")
                if method == "DELETE":
                    connection.execute("DELETE FROM item_quantity_sets WHERE id=?", (set_id,))
                    audit(connection, "ITEM_SET_DELETE", f"Item #{current['item_id']} {current['item_name']}: set {current['quantity']}", session["name"])
                    return {"ok": True}
                try: quantity = int(payload.get("quantity", current["quantity"]))
                except (TypeError, ValueError): quantity = 0
                set_price = money_value(payload.get("set_price", current["set_price"]), "Set price")
                if quantity < 2 or quantity > 999: raise APIError(400, "Set quantity must be between 2 and 999.")
                if set_price <= 0: raise APIError(400, "Set price must be greater than zero.")
                if connection.execute("SELECT id FROM item_quantity_sets WHERE item_id=? AND quantity=? AND id<>?", (current["item_id"], quantity, set_id)).fetchone(): raise APIError(409, "That set quantity already exists for this item.")
                connection.execute("UPDATE item_quantity_sets SET quantity=?,set_price=? WHERE id=?", (quantity, float(set_price), set_id))
                audit(connection, "ITEM_SET_EDIT", f"Item #{current['item_id']} {current['item_name']}: set {current['quantity']}->{quantity}; RM{float(set_price):.2f}", session["name"])
            return {"ok": True}

        if method == "POST" and path == "/api/stock/items":
            session = self.session(modes={"admin"}, roles={"admin"}); payload = self.read_json()
            name = str(payload.get("name", "")).strip(); category = str(payload.get("category", "")).strip()
            try:
                price = float(money_value(payload.get("price", 0), "Price")); stock = int(payload.get("stock", 0)); threshold = int(payload.get("low_stock_threshold", 5))
            except (TypeError, ValueError):
                raise APIError(400, "Price and stock values must be valid numbers.")
            if not name or not category or price < 0 or stock < 0 or threshold < 0: raise APIError(400, "Enter a name, category, non-negative price, and valid stock values.")
            track_stock = int(bool(int(payload.get("track_stock", 0)))); barcode = str(payload.get("barcode", "")).strip() or None
            with connect() as connection:
                if connection.execute("SELECT id FROM items WHERE LOWER(name)=LOWER(?)", (name,)).fetchone(): raise APIError(409, "An item with that name already exists.")
                cursor = connection.execute("INSERT INTO items (name,price,category,stock,low_stock_threshold,active,created_at,barcode,track_stock,image_path) VALUES (?,?,?,?,?,1,?,?,?,NULL)", (name, price, category, stock, threshold, now_iso(), barcode, track_stock))
                image_path = store_item_image(payload["image_data"], cursor.lastrowid) if payload.get("image_data") else None
                if image_path:
                    connection.execute("UPDATE items SET image_path=? WHERE id=?", (image_path, cursor.lastrowid))
                if track_stock and stock:
                    connection.execute("INSERT INTO stock_movements (datetime,item_id,item_name,quantity_delta,stock_before,stock_after,source_type,reference_id,recorded_by,notes) VALUES (?,?,?,?,?,?,?,?,?,?)", (now_audit(), cursor.lastrowid, name, stock, 0, stock, "ITEM_OPENING", cursor.lastrowid, session["name"], "Opening stock when item was created"))
                audit(connection, "ITEM_ADD", f"Item #{cursor.lastrowid} {name}; RM{price:.2f}", session["name"])
            return {"ok": True, "id": cursor.lastrowid, "image_path": image_path}

        if method == "GET" and path == "/api/stock/movements":
            self.session(modes={"cashier", "admin"})
            item_id = query.get("item_id", [""])[0]; sql = "SELECT * FROM stock_movements"; params=[]
            if item_id: sql += " WHERE item_id=?"; params.append(int(item_id))
            sql += " ORDER BY id DESC LIMIT 500"
            with connect() as connection: rows = rows_to_dict(connection.execute(sql, params))
            return {"rows": rows}

        if method == "POST" and path == "/api/stock/adjust":
            session = self.session(modes={"admin"}, roles={"admin", "supervisor"}); payload = self.read_json(); item_id = int(payload.get("item_id", 0))
            try: delta = int(payload.get("delta", 0))
            except (TypeError, ValueError): delta = 0
            note = str(payload.get("note", "")).strip()
            if delta == 0 or not note: raise APIError(400, "A non-zero quantity and reason are required.")
            with connect() as connection:
                item = connection.execute("SELECT id,name,stock FROM items WHERE id=? AND active=1 AND track_stock=1", (item_id,)).fetchone()
                if not item: raise APIError(404, "Tracked item not found.")
                before = int(item["stock"]); after = before + delta
                if after < 0: raise APIError(409, f"Only {before} units are available.")
                connection.execute("UPDATE items SET stock=? WHERE id=?", (after, item_id))
                connection.execute("INSERT INTO stock_movements (datetime,item_id,item_name,quantity_delta,stock_before,stock_after,source_type,reference_id,recorded_by,notes) VALUES (?,?,?,?,?,?,?,?,?,?)", (now_audit(), item_id, item["name"], delta, before, after, "MANUAL_ADJUST", None, session["name"], note))
                audit(connection, "STOCK_ADJUST", f"{item['name']} {before}->{after}; {note}", session["name"])
            return {"ok": True, "before": before, "after": after}

        item_match = re.fullmatch(r"/api/stock/items/(\d+)", path)
        if item_match and method == "PUT":
            session = self.session(modes={"admin"}); item_id = int(item_match.group(1)); payload = self.read_json()
            old_image_path = None; image_path = None; image_changed = False
            with connect() as connection:
                current = connection.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
                if not current: raise APIError(404, "Item not found.")
                name = str(payload.get("name", current["name"])).strip()
                category = str(payload.get("category", current["category"])).strip()
                price = float(money_value(payload.get("price", current["price"]), "Price"))
                try:
                    threshold = int(payload.get("low_stock_threshold", current["low_stock_threshold"]))
                    track_stock = int(bool(int(payload.get("track_stock", current["track_stock"]))))
                    active = int(bool(int(payload.get("active", current["active"]))))
                except (TypeError, ValueError):
                    raise APIError(400, "Stock settings must use valid whole numbers.")
                if not name or not category or price < 0 or threshold < 0:
                    raise APIError(400, "Enter a name, category, non-negative price, and valid stock settings.")
                if connection.execute("SELECT id FROM items WHERE LOWER(name)=LOWER(?) AND id<>?", (name, item_id)).fetchone():
                    raise APIError(409, "An item with that name already exists.")
                old_image_path = current["image_path"]
                image_path = old_image_path
                if payload.get("remove_image"):
                    image_path = None; image_changed = True
                elif payload.get("image_data"):
                    image_path = store_item_image(payload["image_data"], item_id); image_changed = True
                barcode = str(payload.get("barcode", current["barcode"] or "")).strip() or None
                connection.execute("UPDATE items SET name=?,price=?,category=?,low_stock_threshold=?,track_stock=?,barcode=?,active=?,image_path=? WHERE id=?", (name, price, category, threshold, track_stock, barcode, active, image_path, item_id))
                audit(connection, "ITEM_EDIT", f"Item #{item_id} {name}", session["name"])
            if image_changed and old_image_path != image_path:
                remove_managed_item_image(old_image_path)
            return {"ok": True, "image_path": image_path}

        if method == "GET" and path == "/api/sales":
            self.session(modes={"cashier", "admin"})
            with connect() as connection:
                rows = rows_to_dict(connection.execute("SELECT id,datetime,total,payment,discount,tax,cashier,table_code,amended,amended_from,items,category_list_prices FROM sales ORDER BY id DESC LIMIT 300"))
            return {"rows": rows}

        sale_detail_match = re.fullmatch(r"/api/sales/(\d+)", path)
        if sale_detail_match and method == "GET":
            self.session(modes={"cashier", "admin"})
            sale_id = int(sale_detail_match.group(1))
            with connect() as connection:
                row = connection.execute(
                    "SELECT id,datetime,total,payment,discount,tax,cashier,table_code,amended,amended_from,items,category_list_prices FROM sales WHERE id=?",
                    (sale_id,),
                ).fetchone()
                if not row:
                    raise APIError(404, "Receipt not found.")
                result = dict(row)
                list_prices = json.loads(row["category_list_prices"])
                try:
                    raw_items = json.loads(row["items"] or "[]")
                except (TypeError, json.JSONDecodeError):
                    raw_items = []
                foc_rows = rows_to_dict(connection.execute(
                    """SELECT id,line_key,display_name,quantity,normal_unit_price,normal_value,reason,
                              authorized_by,ordered_by
                         FROM foc_replacements WHERE sale_id=? ORDER BY id""",
                    (sale_id,),
                ))
                unused_foc = list(foc_rows)
                parsed_items = []
                for item in raw_items:
                    if not isinstance(item, (list, tuple)) or len(item) < 3:
                        continue
                    saved_name = str(item[0])
                    is_foc = saved_name.startswith("[FOC] ")
                    display_name = saved_name[6:].strip() if is_foc else saved_name
                    foc_record = None
                    if is_foc:
                        foc_record = next(
                            (entry for entry in unused_foc if entry["display_name"] == display_name),
                            unused_foc[0] if unused_foc else None,
                        )
                        if foc_record in unused_foc:
                            unused_foc.remove(foc_record)
                    category = str(item[3]) if len(item) > 3 else ""
                    parsed_items.append({
                        "display_name": display_name,
                        "unit_price": float(foc_record["normal_unit_price"] if foc_record else item[1] or 0),
                        "list_unit_price": list_prices.get(category) if not is_foc else None,
                        "quantity": int(item[2] or 0),
                        "category": category,
                        "is_foc": is_foc,
                        "foc_reason": foc_record["reason"] if foc_record else None,
                    })
                result["parsed_items"] = parsed_items
                result["foc_replacements"] = foc_rows
                checkout_row = connection.execute(
                    "SELECT response_json FROM web_checkout_requests WHERE sale_id=? ORDER BY created_at DESC LIMIT 1",
                    (sale_id,),
                ).fetchone()
                if checkout_row:
                    try:
                        checkout_meta = json.loads(checkout_row["response_json"] or "{}")
                    except (TypeError, json.JSONDecodeError):
                        checkout_meta = {}
                    for key in ("subtotal", "cash_received", "change", "note", "business_date", "order_id"):
                        if key in checkout_meta:
                            result[key] = checkout_meta[key]
                correction_rows = rows_to_dict(connection.execute(
                    """SELECT id,original_sale_id,correction_sale_id,refund_id,datetime,reason,processed_by,
                              refund_amount,charge_amount,charge_payment,cash_received,change_amount
                         FROM web_sale_corrections
                        WHERE original_sale_id=? OR correction_sale_id=? ORDER BY id""",
                    (sale_id, sale_id),
                ))
                result["corrections"] = correction_rows
                own_correction = next((item for item in correction_rows if item["correction_sale_id"] == sale_id), None)
                if own_correction:
                    result["correction_of"] = int(own_correction["original_sale_id"])
                    result["note"] = f"Correction of Receipt #{own_correction['original_sale_id']}: {own_correction['reason']}"
                    if str(row["payment"] or "").upper() == "CASH":
                        result["cash_received"] = own_correction["cash_received"]
                        result["change"] = own_correction["change_amount"]
            return {"sale": result}

        if method == "GET" and path == "/api/refunds":
            self.session(modes={"admin"})
            with connect() as connection: rows = rows_to_dict(connection.execute("SELECT * FROM refunds ORDER BY id DESC LIMIT 300"))
            return {"rows": rows}

        sale_payment_match = re.fullmatch(r"/api/sales/(\d+)/payment", path)
        if sale_payment_match and method == "POST":
            session = self.session(modes={"admin"}, roles={"admin"}); sale_id = int(sale_payment_match.group(1)); payload = self.read_json(); new_payment = str(payload.get("payment", "")).upper()
            if new_payment not in {"CASH", "QR", "CARD"}: raise APIError(400, "Choose CASH, QR, or CARD.")
            with connect() as connection:
                actor = self.verified_payment_staff(connection, str(payload.get("pin", "")))
                if str(actor["role"]).lower() != "admin": raise APIError(403, "An Admin PIN is required to correct a saved payment method.")
                sale = connection.execute("SELECT * FROM sales WHERE id=?", (sale_id,)).fetchone()
                if not sale: raise APIError(404, "Sale not found.")
                old_payment = str(sale["payment"] or "CASH").upper()
                if old_payment == "FOC":
                    raise APIError(409, "An FOC replacement has no payment method to correct.")
                if old_payment == new_payment: return {"ok": True, "payment": new_payment, "changed_by": actor["name"]}
                refunded = float(connection.execute("SELECT COALESCE(SUM(refund_amount),0) FROM refunds WHERE sale_id=?", (sale_id,)).fetchone()[0] or 0)
                net_amount = max(0.0, float(sale["total"] or 0) - refunded); biz = sale_business_date(sale["datetime"])
                columns = {"CASH": "cash_total", "QR": "qr_total", "CARD": "card_total"}
                connection.execute("INSERT OR IGNORE INTO daily_summary (date,total_sales,transaction_count,cash_total,qr_total,card_total,total_discount) VALUES (?,0,0,0,0,0,0)", (biz,))
                if old_payment in columns: connection.execute(f"UPDATE daily_summary SET {columns[old_payment]}={columns[old_payment]}-? WHERE date=?", (net_amount, biz))
                if new_payment in columns: connection.execute(f"UPDATE daily_summary SET {columns[new_payment]}={columns[new_payment]}+? WHERE date=?", (net_amount, biz))
                connection.execute("UPDATE sales SET payment=? WHERE id=?", (new_payment, sale_id))
                connection.execute("UPDATE cashflow SET payment_method=? WHERE type='Income' AND reference_id=? AND source LIKE 'Sales%'", (new_payment, sale_id))
                audit(connection, "CHANGE_PAYMENT_WEB", f"Sale #{sale_id} {old_payment}->{new_payment}; net RM{net_amount:.2f}; session {session['name']}", actor["name"])
            return {"ok": True, "payment": new_payment, "changed_by": actor["name"]}

        sale_correction_match = re.fullmatch(r"/api/sales/(\d+)/correct", path)
        if sale_correction_match and method == "POST":
            session = self.session(modes={"admin"}, roles={"admin"}); sale_id = int(sale_correction_match.group(1)); payload = self.read_json()
            reason = str(payload.get("reason", "")).strip(); refund_items = payload.get("refund_items", []); additions = payload.get("additions", [])
            request_id = str(payload.get("idempotency_key", "")).strip()
            if not reason or len(reason) > 300: raise APIError(400, "Enter a correction reason up to 300 characters.")
            if not isinstance(refund_items, list) or not isinstance(additions, list): raise APIError(400, "Correction items must be lists.")
            if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", request_id): raise APIError(400, "A valid correction request key is required.")
            has_refund = False; has_additions = False
            for item in refund_items:
                if not isinstance(item, dict): continue
                try: has_refund = has_refund or int(item.get("qty", 0) or 0) > 0
                except (TypeError, ValueError): pass
            for item in additions:
                if not isinstance(item, dict): continue
                try: has_additions = has_additions or int(item.get("quantity", item.get("qty", 0)) or 0) > 0
                except (TypeError, ValueError): pass
            if not has_refund and not has_additions: raise APIError(400, "Choose at least one item to refund or add.")
            with connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                prior = connection.execute("SELECT response_json FROM web_sale_corrections WHERE request_id=?", (request_id,)).fetchone()
                if prior: return json.loads(prior["response_json"])
                actor = self.verified_payment_staff(connection, str(payload.get("pin", "")))
                if str(actor["role"]).lower() != "admin": raise APIError(403, "An Admin PIN is required to correct a paid order.")
                sale = connection.execute("SELECT * FROM sales WHERE id=?", (sale_id,)).fetchone()
                if not sale: raise APIError(404, "Sale not found.")
                if str(sale["payment"] or "").upper() == "FOC":
                    raise APIError(409, "Use the FOC audit record; an FOC-only receipt cannot be changed into a paid sale.")
                if sale["amended_from"] is not None or int(sale["amended"] or 0) == 1: raise APIError(409, "Open the original receipt to make another correction.")

                refund_result = create_refund_record(
                    connection, sale, refund_items, f"Paid-order correction: {reason}", actor["name"], session["name"],
                    bool(payload.get("return_to_stock", True)),
                ) if has_refund else None

                correction_sale_id = None; charge_total = 0.0; charge_payment = None; received_value = None; change_value = None
                if has_additions:
                    lines = normalize_order_lines(connection, additions)
                    if not lines: raise APIError(400, "Choose at least one valid item to add.")
                    subtotal, discount, tax, charge_total = order_amounts(lines, 0)
                    charge_payment = str(payload.get("payment", "")).strip().upper()
                    if charge_payment not in {"CASH", "QR", "CARD"}: raise APIError(400, "Choose CASH, QR, or CARD for the additional charge.")
                    received = money_value(payload.get("cash_received", 0), "Cash received") if charge_payment == "CASH" else Decimal(str(charge_total))
                    if charge_payment == "CASH" and received < Decimal(str(charge_total)): raise APIError(400, "Cash received is less than the additional charge.")
                    timestamp = now_audit(); timestamp_iso = now_iso(); biz = business_date(); items_json = order_items_json(lines)
                    list_prices = list_prices_for_sale(connection, (line["category"] for line in lines))
                    cursor = connection.execute(
                        """INSERT INTO sales (datetime,total,payment,items,discount,tax,cashier,table_code,amended,amended_from,category_list_prices)
                           VALUES (?,?,?,?,?,?,?,?,2,?,?)""",
                        (timestamp, charge_total, charge_payment, items_json, discount, tax, actor["name"],
                         sale["table_code"], sale_id, json.dumps(list_prices)),
                    )
                    correction_sale_id = int(cursor.lastrowid)
                    apply_stock_for_web_lines(connection, lines, correction_sale_id, actor["name"], str(sale["table_code"] or ""))
                    connection.execute(
                        """INSERT INTO cashflow
                           (date,datetime,type,source,reference_id,amount,payment_method,recorded_by,notes,supplier)
                           VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        (biz, timestamp_iso, "Income", "Sales Correction", correction_sale_id, charge_total, charge_payment,
                         actor["name"], f"Additional charge correcting Sale #{sale_id}: {reason}", ""),
                    )
                    connection.execute("INSERT OR IGNORE INTO daily_summary (date,total_sales,transaction_count,cash_total,qr_total,card_total,total_discount) VALUES (?,0,0,0,0,0,0)", (biz,))
                    payment_column = {"CASH": "cash_total", "QR": "qr_total", "CARD": "card_total"}[charge_payment]
                    connection.execute(
                        f"UPDATE daily_summary SET total_sales=total_sales+?,transaction_count=transaction_count+1,{payment_column}={payment_column}+? WHERE date=?",
                        (charge_total, charge_total, biz),
                    )
                    received_value = float(received) if charge_payment == "CASH" else None
                    change_value = float((received - Decimal(str(charge_total))).quantize(Decimal("0.01"))) if charge_payment == "CASH" else 0.0

                correction_cursor = connection.execute(
                    """INSERT INTO web_sale_corrections
                       (request_id,original_sale_id,correction_sale_id,refund_id,datetime,reason,processed_by,
                        refund_amount,charge_amount,charge_payment,cash_received,change_amount,return_to_stock,response_json)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (request_id, sale_id, correction_sale_id, refund_result["id"] if refund_result else None, now_iso(), reason,
                     actor["name"], refund_result["amount"] if refund_result else 0, charge_total, charge_payment,
                     received_value, change_value, int(bool(payload.get("return_to_stock", True))), "{}"),
                )
                response = {
                    "ok": True, "correction_id": int(correction_cursor.lastrowid), "original_sale_id": sale_id,
                    "refund_id": refund_result["id"] if refund_result else None,
                    "refund_amount": refund_result["amount"] if refund_result else 0,
                    "correction_sale_id": correction_sale_id, "charge_amount": charge_total,
                    "payment": charge_payment, "cash_received": received_value, "change": change_value,
                    "processed_by": actor["name"], "reason": reason,
                }
                connection.execute("UPDATE web_sale_corrections SET response_json=? WHERE id=?", (json.dumps(response, ensure_ascii=False), int(correction_cursor.lastrowid)))
                audit(connection, "SALE_CORRECTION_WEB", f"Sale #{sale_id}; refund RM{response['refund_amount']:.2f}; charge RM{charge_total:.2f}; adjustment sale #{correction_sale_id or '-'}; {reason}; session {session['name']}", actor["name"])
            return response

        if method == "POST" and path == "/api/refunds":
            session = self.session(modes={"admin"}, roles={"admin"}); payload = self.read_json()
            try: sale_id = int(payload.get("sale_id", 0))
            except (TypeError, ValueError): sale_id = 0
            reason = str(payload.get("reason", "")).strip(); requested = payload.get("items", [])
            if not reason or not isinstance(requested, list): raise APIError(400, "Choose refund items and enter a reason.")
            with connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                actor = self.verified_payment_staff(connection, str(payload.get("pin", "")))
                if str(actor["role"]).lower() != "admin": raise APIError(403, "An Admin PIN is required to process a refund.")
                sale = connection.execute("SELECT * FROM sales WHERE id=?", (sale_id,)).fetchone()
                if not sale: raise APIError(404, "Sale not found.")
                result = create_refund_record(connection, sale, requested, reason, actor["name"], session["name"], bool(payload.get("return_to_stock", True)))
            return {"ok": True, "id": result["id"], "amount": result["amount"], "processed_by": actor["name"]}

        if method == "GET" and path == "/api/staff":
            self.session(modes={"admin"})
            with connect() as connection: rows = rows_to_dict(connection.execute("SELECT id,staff_id,name,role,active,created_at FROM staff ORDER BY active DESC,name"))
            return {"rows": rows, "roles": ["order", "cashier", "admin"]}

        if method == "POST" and path == "/api/staff":
            session = self.session(modes={"admin"}, roles={"admin"}); payload = self.read_json(); role = str(payload.get("role", "cashier")).lower()
            if role not in ROLE_MODES: raise APIError(400, "Invalid staff role.")
            staff_id = str(payload.get("staff_id", "")).strip()
            name = str(payload.get("name", "")).strip()
            pin = validate_staff_pin(payload.get("pin", ""))
            if not staff_id or not name: raise APIError(400, "Staff ID, name, and PIN are required.")
            if len(staff_id) > 30 or len(name) > 80: raise APIError(400, "Staff ID or name is too long.")
            with connect() as connection:
                cursor = connection.execute("INSERT INTO staff (staff_id,name,pin,role,active,created_at) VALUES (?,?,?,?,1,?)", (staff_id, name, pin, role, now_iso()))
                audit(connection, "STAFF_ADD", f"{name} ({staff_id}) role {role}", session["name"])
            return {"ok": True, "id": cursor.lastrowid}

        staff_match = re.fullmatch(r"/api/staff/(\d+)", path)
        if staff_match and method in {"PUT", "DELETE"}:
            session = self.session(modes={"admin"}, roles={"admin"}); staff_db_id = int(staff_match.group(1)); payload = self.read_json()
            with connect() as connection:
                current = connection.execute("SELECT * FROM staff WHERE id=?", (staff_db_id,)).fetchone()
                if not current: raise APIError(404, "Staff member not found.")
                if method == "DELETE":
                    reason = str(payload.get("reason", "")).strip()
                    if current["staff_id"] == "ADMIN": raise APIError(409, "The primary Admin cannot be deleted.")
                    if not reason: raise APIError(400, "A deletion reason is required.")
                    connection.execute("DELETE FROM staff WHERE id=?", (staff_db_id,))
                    audit(connection, "STAFF_DELETE", f"{current['staff_id']} {current['name']}; {reason}", session["name"])
                    deleted_staff_id = str(current["staff_id"])
                    result = {"ok": True}
                else:
                    role = str(payload.get("role", current["role"])).lower(); active = int(payload.get("active", current["active"]))
                    if role not in ROLE_MODES: raise APIError(400, "Invalid role.")
                    if current["staff_id"] == "ADMIN" and (role != "admin" or not active): raise APIError(409, "The primary Admin must remain active with the Admin role.")
                    pin = validate_staff_pin(payload.get("pin", current["pin"]))
                    name = str(payload.get("name", current["name"])).strip()
                    if not name or len(name) > 80: raise APIError(400, "Enter a staff name up to 80 characters.")
                    connection.execute("UPDATE staff SET name=?,pin=?,role=?,active=? WHERE id=?", (name, pin, role, active, staff_db_id))
                    audit(connection, "STAFF_EDIT", f"{current['staff_id']} role {role} active {active}", session["name"])
                    deleted_staff_id = str(current["staff_id"])
                    result = {"ok": True}
            revoke_staff_sessions(deleted_staff_id)
            return result

        if method == "GET" and path == "/api/catalog/categories":
            self.session(modes={"admin"})
            with connect() as connection: rows = rows_to_dict(connection.execute("SELECT * FROM product_categories ORDER BY sort_order,name"))
            return {"rows": rows, "list_price": LIST_PRICE}

        if method == "POST" and path == "/api/catalog/categories":
            session = self.session(modes={"admin"}, roles={"admin"}); payload = self.read_json(); name = str(payload.get("name", "")).strip(); color = str(payload.get("color", "#475569")).strip()
            try: sort_order = int(payload.get("sort_order", 10))
            except (TypeError, ValueError): raise APIError(400, "Sort order must be a whole number.")
            if not name or not re.fullmatch(r"#[0-9A-Fa-f]{6}", color): raise APIError(400, "Enter a category name and six-digit hex colour.")
            show_list_price = int(boolean_flag(payload.get("show_list_price", 0), "Show list price"))
            with connect() as connection:
                if connection.execute("SELECT id FROM product_categories WHERE LOWER(name)=LOWER(?)", (name,)).fetchone(): raise APIError(409, "That product category already exists.")
                cursor = connection.execute("INSERT INTO product_categories (name,icon,color,active,sort_order,exclude_export,show_list_price) VALUES (?,?,?,1,?,?,?)", (name, str(payload.get("icon", "📦")).strip() or "📦", color, sort_order, int(bool(int(payload.get("exclude_export", 0)))), show_list_price))
                audit(connection, "CATEGORY_ADD", f"Category #{cursor.lastrowid} {name}", session["name"])
            return {"ok": True, "id": cursor.lastrowid}

        product_category_match = re.fullmatch(r"/api/catalog/categories/(\d+)", path)
        if product_category_match and method == "PUT":
            session = self.session(modes={"admin"}, roles={"admin"}); category_id = int(product_category_match.group(1)); payload = self.read_json()
            with connect() as connection:
                current = connection.execute("SELECT * FROM product_categories WHERE id=?", (category_id,)).fetchone()
                if not current: raise APIError(404, "Product category not found.")
                name = str(payload.get("name", current["name"])).strip(); color = str(payload.get("color", current["color"] or "#475569")).strip()
                if not name or not re.fullmatch(r"#[0-9A-Fa-f]{6}", color): raise APIError(400, "Enter a category name and six-digit hex colour.")
                if connection.execute("SELECT id FROM product_categories WHERE LOWER(name)=LOWER(?) AND id<>?", (name, category_id)).fetchone(): raise APIError(409, "That product category already exists.")
                show_list_price = int(boolean_flag(payload.get("show_list_price", current["show_list_price"]), "Show list price"))
                values = (name, str(payload.get("icon", current["icon"] or "📦")).strip() or "📦", color, int(payload.get("active", current["active"])), int(payload.get("sort_order", current["sort_order"])), int(payload.get("exclude_export", current["exclude_export"])), show_list_price, category_id)
                connection.execute("UPDATE product_categories SET name=?,icon=?,color=?,active=?,sort_order=?,exclude_export=?,show_list_price=? WHERE id=?", values)
                if name != current["name"]: connection.execute("UPDATE items SET category=? WHERE category=?", (name, current["name"]))
                audit(connection, "CATEGORY_EDIT", f"Category #{category_id} {current['name']}->{name}", session["name"])
            return {"ok": True}

        if method == "GET" and path == "/api/catalog/tables":
            self.session(modes={"admin"})
            with connect() as connection: rows = rows_to_dict(connection.execute("SELECT * FROM dining_tables ORDER BY sort_order,table_code"))
            return {"rows": rows}

        if method == "POST" and path == "/api/catalog/tables":
            session = self.session(modes={"admin"}, roles={"admin"}); payload = self.read_json(); table_code = str(payload.get("table_code", "")).strip().upper()
            if not table_code or len(table_code) > 12: raise APIError(400, "Enter a table code up to 12 characters.")
            with connect() as connection:
                if connection.execute("SELECT id FROM dining_tables WHERE UPPER(table_code)=?", (table_code,)).fetchone(): raise APIError(409, "That table code already exists.")
                default_sort = int(connection.execute("SELECT COALESCE(MAX(sort_order),0)+1 FROM dining_tables").fetchone()[0])
                cursor = connection.execute("INSERT INTO dining_tables (table_code,sort_order,active,created_at) VALUES (?,?,1,?)", (table_code, int(payload.get("sort_order", default_sort)), now_iso()))
                audit(connection, "TABLE_ADD", f"Table #{cursor.lastrowid} {table_code}", session["name"])
            return {"ok": True, "id": cursor.lastrowid}

        table_match = re.fullmatch(r"/api/catalog/tables/(\d+)", path)
        if table_match and method == "PUT":
            session = self.session(modes={"admin"}, roles={"admin"}); table_id = int(table_match.group(1)); payload = self.read_json()
            with connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                current = connection.execute("SELECT * FROM dining_tables WHERE id=?", (table_id,)).fetchone()
                if not current: raise APIError(404, "Dining table not found.")
                table_code = str(payload.get("table_code", current["table_code"])).strip().upper()
                if not table_code or len(table_code) > 12: raise APIError(400, "Enter a table code up to 12 characters.")
                if connection.execute("SELECT id FROM dining_tables WHERE UPPER(table_code)=? AND id<>?", (table_code, table_id)).fetchone(): raise APIError(409, "That table code already exists.")
                active = int(bool(int(payload.get("active", current["active"]))))
                held_count = int(connection.execute(
                    "SELECT COUNT(*) FROM held_orders WHERE status='HELD' AND table_code=? COLLATE NOCASE",
                    (current["table_code"],),
                ).fetchone()[0])
                if not active and held_count:
                    raise APIError(409, f"Table {current['table_code']} has an unpaid order. Pay or clear it before deactivating the table.")
                connection.execute("UPDATE dining_tables SET table_code=?,sort_order=?,active=? WHERE id=?", (table_code, int(payload.get("sort_order", current["sort_order"])), active, table_id))
                if table_code != current["table_code"] and held_count:
                    connection.execute(
                        "UPDATE held_orders SET table_code=?,updated_at=?,updated_by=?,origin='WEB',version=version+1 WHERE status='HELD' AND table_code=? COLLATE NOCASE",
                        (table_code, now_audit(), session["name"], current["table_code"]),
                    )
                audit(connection, "TABLE_EDIT", f"Table #{table_id} {current['table_code']}->{table_code}; active {active}", session["name"])
            return {"ok": True}

        if method == "GET" and path == "/api/system/audit":
            self.session(modes={"admin"})
            limit = min(1000, max(1, int(query.get("limit", [300])[0])))
            action = query.get("action", [""])[0]
            sql = "SELECT id,timestamp,action,details,user FROM audit_log"; params=[]
            if action: sql += " WHERE action=?"; params.append(action)
            sql += " ORDER BY id DESC LIMIT ?"; params.append(limit)
            with connect() as connection: rows = rows_to_dict(connection.execute(sql, params))
            return {"rows": rows}

        if method == "GET" and path == "/api/system/settings":
            self.session(modes={"admin"})
            with connect() as connection: rows = connection.execute("SELECT key,value,updated_at,updated_by FROM app_settings ORDER BY key").fetchall()
            return {"settings": {row["key"]: row["value"] for row in rows}, "metadata": rows_to_dict(rows)}

        if method == "PUT" and path == "/api/system/settings":
            session = self.session(modes={"admin"}, roles={"admin"}); payload = self.read_json(); settings = payload.get("settings", {})
            allowed = {
                "shop_name","currency","business_day_start","language","backup_retention_days","receipt_footer",
                "business_registration_no","business_address","employer_epf_no","employer_socso_no",
            }
            if not isinstance(settings, dict): raise APIError(400, "Settings must be an object.")
            clean = {key: str(value).strip() for key, value in settings.items() if key in allowed}
            if "shop_name" in clean and (not clean["shop_name"] or len(clean["shop_name"]) > 100): raise APIError(400, "Shop name must contain 1 to 100 characters.")
            if "currency" in clean and (not clean["currency"] or len(clean["currency"]) > 8): raise APIError(400, "Currency label must contain 1 to 8 characters.")
            if "business_day_start" in clean and not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", clean["business_day_start"]): raise APIError(400, "Business day start must use HH:MM.")
            if "language" in clean and clean["language"] not in {"en", "zh", "both"}: raise APIError(400, "Choose English, Chinese, or Both.")
            if "receipt_footer" in clean and len(clean["receipt_footer"]) > 300: raise APIError(400, "Receipt footer cannot exceed 300 characters.")
            for key, maximum in (("business_registration_no", 80), ("business_address", 300), ("employer_epf_no", 80), ("employer_socso_no", 80)):
                if key in clean and len(clean[key]) > maximum: raise APIError(400, f"{key.replace('_', ' ').title()} is too long.")
            if "backup_retention_days" in clean:
                try: retention_days = int(clean["backup_retention_days"])
                except ValueError: raise APIError(400, "Backup retention must be a whole number of days.")
                if retention_days < 1 or retention_days > 3650: raise APIError(400, "Backup retention must be between 1 and 3650 days.")
                clean["backup_retention_days"] = str(retention_days)
            with connect() as connection:
                for key, value in clean.items():
                    connection.execute("INSERT INTO app_settings (key,value,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by", (key, value, now_iso(), session["name"]))
                audit(connection, "SETTINGS_UPDATE", f"Updated: {', '.join(sorted(clean))}", session["name"])
            if "business_day_start" in clean:
                set_business_day_start(clean["business_day_start"])
            return {"ok": True}

        if method == "GET" and path == "/api/system/status":
            self.session(modes={"admin"})
            with connect() as connection:
                integrity = connection.execute("PRAGMA quick_check").fetchone()[0]
                version = connection.execute("SELECT COALESCE(MAX(version),0) FROM web_schema_meta").fetchone()[0]
                table_count = connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
                journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
                active_orders = connection.execute("SELECT COUNT(*) FROM held_orders WHERE status='HELD'").fetchone()[0]
            backups = sorted(BACKUP_DIR.glob("pos-*.db"), key=lambda item: item.stat().st_mtime, reverse=True) if BACKUP_DIR.exists() else []
            latest_images = backups[0].with_name(f"{backups[0].stem}-item-images.zip") if backups else None
            return {
                "database_path": str(DB_PATH), "database_size": DB_PATH.stat().st_size,
                "integrity": integrity, "schema_version": version, "table_count": table_count,
                "journal_mode": str(journal_mode).upper(), "active_orders": int(active_orders),
                "backup_directory": str(BACKUP_DIR),
                "latest_backup": backups[0].name if backups else None,
                "latest_backup_at": datetime.fromtimestamp(backups[0].stat().st_mtime).isoformat(timespec="seconds") if backups else None,
                "latest_backup_images": latest_images.name if latest_images and latest_images.exists() else None,
                "automatic_backups": os.environ.get("POS_AUTO_BACKUP", "1") != "0",
            }

        if method == "POST" and path == "/api/system/backup":
            session = self.session(modes={"admin"}, roles={"admin"})
            backup_path = create_database_backup("pos-manual")
            with connect() as connection: audit(connection, "DATABASE_BACKUP", backup_path.name, session["name"])
            image_archive = backup_path.with_name(f"{backup_path.stem}-item-images.zip")
            return {
                "ok": True,
                "path": str(backup_path),
                "size": backup_path.stat().st_size,
                "item_images_path": str(image_archive) if image_archive.exists() else None,
            }

        if method == "GET" and path == "/api/reports/daily":
            self.session(modes={"admin"})
            days = min(365, max(1, int(query.get("days", [30])[0]))); end = date.today(); start = end - timedelta(days=days - 1)
            with connect() as connection:
                rows = rows_to_dict(connection.execute("SELECT date,total_sales,transaction_count,cash_total,qr_total,card_total,total_discount FROM daily_summary WHERE date BETWEEN ? AND ? ORDER BY date DESC", (start.isoformat(), end.isoformat())))
            return {"rows": rows, "from": start.isoformat(), "to": end.isoformat()}

        if method == "GET" and path == "/api/exports/accountant":
            self.session(modes={"admin"})
            month = query.get("month", [business_date()[:7]])[0]
            body = self.build_accountant_workbook(month)
            return self.send_file_bytes(body, f"919-accountant-{month}.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

        if method == "GET" and path == "/api/exports/stock":
            self.session(modes={"admin"})
            body = self.build_stock_workbook()
            return self.send_file_bytes(body, f"919-stock-{business_date()}.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

        if method == "GET" and path == "/api/exports/rent":
            self.session(modes={"admin"})
            body = self.build_rent_workbook()
            return self.send_file_bytes(body, f"919-rent-{business_date()}.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

        raise APIError(404, "API endpoint not found.")

    def build_accountant_workbook(self, month: str) -> bytes:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill

        try:
            start = datetime.strptime(month + "-01", "%Y-%m-%d").date()
        except ValueError:
            raise APIError(400, "Month must use YYYY-MM format.")
        end = date(start.year, start.month, monthrange(start.year, start.month)[1])
        summary = accounting_summary(start.isoformat(), end.isoformat())
        workbook = Workbook(); sheet = workbook.active; sheet.title = "Summary"
        sheet.append(["919 Restaurant Accountant Export"]); sheet["A1"].font = Font(size=16, bold=True)
        sheet.append(["Period", start.isoformat(), end.isoformat()]); sheet.append(["Generated", now_iso()]); sheet.append([])
        for label, key in [("Gross Sales","gross_sales"),("Refunds","refunds"),("Net Sales","net_sales"),("Other Income","other_income"),("Total Income","total_income"),("Operating Expenses","operating_expenses"),("Net Profit","net_profit"),("Cash Sales","cash_sales"),("QR Sales","qr_sales"),("Card Sales","card_sales"),("FOC Replacement Units","foc_units"),("FOC Normal Retail Value (not revenue)","foc_retail_value")]:
            sheet.append([label, summary[key]])
        for cell in sheet[5]: cell.fill = PatternFill("solid", fgColor="DCE6F1")
        sheet.column_dimensions["A"].width = 24; sheet.column_dimensions["B"].width = 18; sheet.column_dimensions["C"].width = 18
        ledger = workbook.create_sheet("Income & Expenses"); ledger.append(["Date","Type","Source","Supplier","Payment","Amount","Recorded By","Notes"])
        with connect() as connection:
            rows = connection.execute("SELECT date,type,source,supplier,payment_method,amount,recorded_by,notes FROM cashflow WHERE date BETWEEN ? AND ? ORDER BY date,id", (start.isoformat(), end.isoformat())).fetchall()
        for row in rows: ledger.append([row["date"],row["type"],row["source"],row["supplier"],row["payment_method"],float(row["amount"] or 0),row["recorded_by"],row["notes"]])
        for cell in ledger[1]: cell.font = Font(bold=True); cell.fill = PatternFill("solid", fgColor="1F4E78"); cell.font = Font(bold=True,color="FFFFFF"); cell.alignment = Alignment(horizontal="center")
        ledger.freeze_panes = "A2"; ledger.auto_filter.ref = ledger.dimensions
        widths = [12,12,22,20,12,14,18,40]
        for index, width in enumerate(widths, 1): ledger.column_dimensions[chr(64+index)].width = width
        foc_sheet = workbook.create_sheet("FOC Replacements")
        foc_sheet.append(["Business Date","Time","Sale","Order","Table","Item","Category","Qty","Stock Qty","Normal Unit Price","Normal Retail Value","Reason","Authorized By","Ordered By"])
        with connect() as connection:
            foc_rows = connection.execute(
                """SELECT business_date,datetime,sale_id,order_id,table_code,display_name,category,
                          quantity,stock_quantity,normal_unit_price,normal_value,reason,authorized_by,ordered_by
                     FROM foc_replacements WHERE business_date BETWEEN ? AND ?
                    ORDER BY business_date,id""",
                (start.isoformat(), end.isoformat()),
            ).fetchall()
        for row in foc_rows:
            foc_sheet.append([
                row["business_date"], row["datetime"], row["sale_id"], row["order_id"], row["table_code"],
                row["display_name"], row["category"], row["quantity"], row["stock_quantity"],
                float(row["normal_unit_price"] or 0), float(row["normal_value"] or 0), row["reason"],
                row["authorized_by"], row["ordered_by"],
            ])
        for cell in foc_sheet[1]:
            cell.font = Font(bold=True,color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="A45A14")
            cell.alignment = Alignment(horizontal="center")
        foc_sheet.freeze_panes = "A2"; foc_sheet.auto_filter.ref = foc_sheet.dimensions
        for column, width in {"A":14,"B":20,"C":10,"D":10,"E":10,"F":24,"G":18,"H":9,"I":11,"J":18,"K":20,"L":42,"M":18,"N":18}.items():
            foc_sheet.column_dimensions[column].width = width
        buffer = BytesIO(); workbook.save(buffer); return buffer.getvalue()

    def build_stock_workbook(self) -> bytes:
        from openpyxl import Workbook
        from openpyxl.styles import Font
        workbook = Workbook(); current = workbook.active; current.title = "Current Stock"; current.append(["ID","Item","Category","Stock","Reorder At","Active"])
        with connect() as connection:
            for row in connection.execute("SELECT id,name,category,stock,low_stock_threshold,active FROM items WHERE track_stock=1 ORDER BY category,name"):
                current.append(list(row))
            movements = workbook.create_sheet("Movements"); movements.append(["ID","Datetime","Item","Delta","Before","After","Source","Staff","Notes"])
            for row in connection.execute("SELECT id,datetime,item_name,quantity_delta,stock_before,stock_after,source_type,recorded_by,notes FROM stock_movements ORDER BY id DESC LIMIT 5000"):
                movements.append(list(row))
        for sheet in workbook.worksheets:
            for cell in sheet[1]: cell.font = Font(bold=True)
            sheet.freeze_panes = "A2"; sheet.auto_filter.ref = sheet.dimensions
        buffer = BytesIO(); workbook.save(buffer); return buffer.getvalue()

    def build_rent_workbook(self) -> bytes:
        from openpyxl import Workbook
        from openpyxl.styles import Font
        workbook = Workbook(); tenants = workbook.active; tenants.title = "Tenants"; tenants.append(["ID","Name","Stall","Type","Rate","Start","Paid Until","Active","Notes"])
        with connect() as connection:
            for row in connection.execute("SELECT id,name,stall_no,rental_type,daily_rate,start_date,paid_until_date,active,notes FROM rent_tenants ORDER BY stall_no,name"):
                tenants.append(list(row))
            payments = workbook.create_sheet("Payments"); payments.append(["ID","Date","Tenant","Stall","Units","Rate","Amount","Recorded By","Voided","Notes"])
            for row in connection.execute("SELECT id,pay_date,tenant_name,stall_no,days,rate,amount,recorded_by,voided,notes FROM rent_payments ORDER BY id DESC"):
                payments.append(list(row))
        for sheet in workbook.worksheets:
            for cell in sheet[1]: cell.font = Font(bold=True)
            sheet.freeze_panes = "A2"; sheet.auto_filter.ref = sheet.dimensions
        buffer = BytesIO(); workbook.save(buffer); return buffer.getvalue()


class POSHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    # HTTPServer enables SO_REUSEADDR by default.  On Windows that can allow a
    # second POS process to bind the same address and port, causing requests to
    # be split unpredictably between two processes that share one database.
    # A live POS must have exactly one server owner, so use an exclusive bind.
    allow_reuse_address = False

    def server_bind(self) -> None:
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main() -> None:
    host = os.environ.get("POS_WEB_HOST", "127.0.0.1")
    port = int(os.environ.get("POS_WEB_PORT", "8000"))
    if not DB_PATH.exists():
        raise RuntimeError(f"Database not found: {DB_PATH}")
    if not is_loopback_host(host):
        if os.environ.get("POS_ALLOW_REMOTE") != "1":
            raise RuntimeError(
                "Remote binding is disabled. Set POS_ALLOW_REMOTE=1 only after configuring a private network or HTTPS gateway."
            )
        if not configured_admin_password():
            raise RuntimeError(
                "A remote server requires POS_ADMIN_PASSWORD_HASH (recommended) or POS_ADMIN_PASSWORD."
            )
    backup_path = automatic_startup_backup()
    migration_backup = create_database_backup("pos-pre-migration") if current_web_schema_version() < WEB_SCHEMA_VERSION else None
    with connect() as connection:
        connection.execute("PRAGMA journal_mode=WAL")
    ensure_web_schema()
    runtime_settings = load_shop_settings()
    set_business_day_start(os.environ.get("POS_BUSINESS_DAY_START", runtime_settings["business_day_start"]))
    handler = partial(POSRequestHandler, directory=str(WEB_ROOT))
    server = POSHTTPServer((host, port), handler)
    print(f"919 POS web server: http://{host}:{port}/")
    print(f"Database: {DB_PATH}")
    if backup_path:
        print(f"Verified startup backup: {backup_path}")
    if migration_backup:
        print(f"Verified pre-migration backup: {migration_backup}")
    if not is_loopback_host(host):
        print("Remote access enabled: use a private network or HTTPS reverse proxy; never expose this port directly.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
