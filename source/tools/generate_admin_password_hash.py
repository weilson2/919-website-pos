"""Create a PBKDF2 hash for POS_ADMIN_PASSWORD_HASH without echoing the password."""

from __future__ import annotations

import getpass
import hashlib
import secrets


ITERATIONS = 310_000


def main() -> None:
    password = getpass.getpass("New remote Admin password (14+ characters): ")
    if len(password) < 14:
        raise SystemExit("Password was not changed: use at least 14 characters.")
    confirmation = getpass.getpass("Confirm password: ")
    if password != confirmation:
        raise SystemExit("Password was not changed: the two entries did not match.")
    salt = secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)
    value = f"pbkdf2_sha256${ITERATIONS}${salt.hex()}${derived.hex()}"
    print("\nSet this environment variable for the web server account:")
    print(f"POS_ADMIN_PASSWORD_HASH={value}")
    print("\nKeep the original password in your password manager. The hash can be stored in server configuration.")


if __name__ == "__main__":
    main()
