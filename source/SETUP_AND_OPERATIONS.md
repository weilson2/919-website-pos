# 919 Web POS — Setup and Operations

This guide is for the Windows computer that owns `pos.db`. The web system uses
the same SQLite database as the Python desktop application.

## 1. Accounts and services you need

For one shop computer, you do **not** need to register a database-server
account. SQLite is built into Python and stores the business data in the local
`pos.db` file.

You need:

- one Windows user account that can read this folder and write `pos.db`,
  `backups`, and `web_prototype\uploads\items`;
- one unique short numeric PIN for each worker in **Admin → Staff & Access**;
- a strong Admin password hash if the server will listen beyond
  `127.0.0.1`;
- optionally, an account with a private-network or HTTPS-gateway provider if
  the owner must connect from outside the shop.

Do not expose port 8000 directly to the public Internet. Worker PINs are short
identity codes for a trusted shop network; they are not Internet passwords.

## 2. Install Python and dependencies

Open PowerShell in this project folder:

```powershell
cd D:\desktop\kopitiam_pos
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Python 3.12 or newer is recommended. The web server itself uses the Python
standard library; `openpyxl` is used for accountant, stock, and rent exports.

## 3. First migration

1. Close the desktop POS and stop any existing web server.
2. Confirm that `pos.db` is the intended live database.
3. Run the migration:

```powershell
$env:POS_DB_PATH = 'D:\desktop\kopitiam_pos\pos.db'
$env:POS_BACKUP_DIR = 'D:\desktop\kopitiam_pos\backups'
.\.venv\Scripts\python.exe tools\migrate_web_admin.py
```

The migration is repeatable. It creates and verifies a pre-migration backup,
applies the web schema, runs SQLite `quick_check`, and prints the resulting
schema version. Do not continue if it reports an error.

## 4. Configure the Admin password

This is required for non-local binding and recommended even on the shop PC.
Generate a PBKDF2 hash without putting the password in source code:

```powershell
.\.venv\Scripts\python.exe tools\generate_admin_password_hash.py
```

Copy the complete value printed after `POS_ADMIN_PASSWORD_HASH=`. Set it for
the current PowerShell window using single quotes because the hash contains
`$` characters:

```powershell
$env:POS_ADMIN_PASSWORD_HASH = 'paste-the-complete-generated-value-here'
```

For an automatic Windows startup task, store the hash as a user environment
variable, or set it in a locked-down launcher owned by the server's Windows
account. Never store the original Admin password in this repository.

The login still asks for the Admin staff PIN; the strong password is an
additional check for the Admin workspace.

## 5. Start the system

Local shop computer only:

```powershell
.\run_web_pos.ps1
```

Then open [http://127.0.0.1:8000/](http://127.0.0.1:8000/).

The launcher defaults to:

- database: `D:\desktop\kopitiam_pos\pos.db`;
- backups: `D:\desktop\kopitiam_pos\backups`;
- address: `127.0.0.1`;
- port: `8000`.

To use a different database or port:

```powershell
.\run_web_pos.ps1 -DatabasePath 'D:\POSData\pos.db' -BackupDirectory 'E:\POSBackups' -Port 8080
```

The terminal window is the server process. Press `Ctrl+C` for a clean stop.
The server claims its address and port exclusively; a second POS instance will
stop with an address-in-use error instead of sharing traffic or writing through
two server processes.

### Optional Windows automatic start

After local testing is complete, create a Task Scheduler task under the same
Windows user that owns the POS files:

- trigger: **At log on** or **At startup**;
- program: `powershell.exe`;
- arguments:
  `-NoProfile -ExecutionPolicy Bypass -File "D:\desktop\kopitiam_pos\run_web_pos.ps1"`;
- start in: `D:\desktop\kopitiam_pos`;
- enable **Restart the task if it fails**;
- do not start a second instance if one is already running.

If the task uses a different Windows account, give that account access only to
the application/data/backup folders it needs, install the Admin password hash
for that account, and test a manual backup from the Admin screen.

## 6. Laptop and tablet access

For devices on a trusted private shop network:

1. Configure `POS_ADMIN_PASSWORD_HASH`.
2. Find the shop computer's private IPv4 address with `ipconfig`.
3. Allow Python/port 8000 only on the Windows **Private** firewall profile.
4. Start with explicit remote permission:

```powershell
.\run_web_pos.ps1 -ListenAddress 0.0.0.0 -Port 8000 -AllowRemote
```

5. On the tablet, open `http://SHOP-PC-IP:8000/`.

Use a reserved DHCP address for the shop computer so the URL does not change.
For access from outside the shop, use an encrypted private network or an HTTPS
reverse proxy. Do not add a router port-forward directly to this server.

The concrete Muar-shop/KL-owner sequence is in `DEPLOYMENT_CHECKLIST.md`. Keep
the database on the Muar server PC for the first deployment; private-network
access lets the KL owner read the same live records without synchronising the
live SQLite files through a cloud drive.

If an HTTPS reverse proxy supplies `X-Forwarded-Proto` and
`X-Forwarded-For`, set `POS_TRUST_HTTPS_PROXY=1` only when that proxy is the
only path to the server.

## 7. The three workspaces

| Workspace | Intended station | Access |
| --- | --- | --- |
| Order Only | waiter/order tablet | tables, items, notes, discounts, hold, check bill; no payment |
| Cashier | payment counter | Order Only features plus Cash/QR checkout, recent receipts, Cash Center, rent collection, and read-only stock |
| Admin | owner/remote management | accounting, cash review, rent control, stock/items, refunds, payroll, reports, staff, tables, settings, backup, audit; no order screen |

The top bar always displays the active workspace. A Cashier account may switch
between Cashier and Order Only. An Admin account is deliberately isolated from
the table/order screen.

In the Cashier workspace, **Cash**, **Rent**, and **Stock** open in a centered
window over the POS. The current table and unpaid order remain in place behind
the window. Use the three window tabs to move between cashier tools, then close
the window to return to the same order; the POS refreshes live data on close.

At each sale or rent collection, the receiving worker enters their short PIN.
The saved receipt, stock movement, cashflow row, and audit record use that
worker's identity—not merely the person who opened the browser session.

## 8. Daily cashier workflow

1. Open the **Cash** window, choose **Opening**, and record the drawer float once.
2. Select a free table, add products, and add an order note if needed.
3. If an item must be replaced without another charge, select **FOC
   replacement** on the original line, enter the replacement quantity, and
   choose a reason such as **not fresh / spoiled**. The original item remains
   charged while the separate FOC line is RM0. The replacement still deducts
   stock and is approved by the cashier PIN at checkout.
4. Use **Hold** to leave the table unpaid.
5. Use **Print bill** (or `F3`) when the customer wants to check the bill.
6. Choose **Cash** or **QR**:
   - Cash asks for the receiving PIN and cash received, then calculates change.
   - QR asks for the receiving PIN and confirmation only; it never asks for
     cash received.
   - An order containing only FOC lines closes as **FOC** after PIN approval
     and creates no sales or cashflow amount.
7. Print the paid receipt. It remains available under **Recent orders** for
reprinting.
8. Review the red rent reminder and collect due stall rent from **Rent**.
9. Record other cash income/expense in **Cash → Other Income & Expense**.
10. Count the drawer in **Cash → End of Day** and save the variance.

An unpaid order is saved in `pos.db` after every change. It survives browser
refreshes and server restarts. If two terminals edit the same table, the stale
terminal is stopped and shown the newest saved order instead of overwriting it.

## 9. Admin workflow

- **Overview:** daily sales, expected cash, monthly profit, low stock, overdue
  rent, and recent audit activity.
- **Accounting:** full income/expense ledger and categories, plus an FOC
  replacement register. FOC normal retail value is shown for management review
  but is not counted as sales revenue or an operating expense.
- **Cash Center:** opening, other cash movements, and end-of-day history.
- **Rent & Stalls:** tenant setup, collection, due dates, and Admin voids.
- **Stock & Items:** products, prices, stock tracking, adjustments, barcode,
  active status, item photos, and the **Options** manager for variants and
  quantity sets. A variant price is the base item price plus its adjustment; a
  quantity set has its own selling price and deducts the full set quantity from
  tracked stock. An option in an unpaid table order is protected from editing
  or deletion until that bill is completed or cleared.
- **Sales & Refunds:** receipt detail, payment-method correction, controlled
  paid-order correction, partial refund, and optional stock return. Use
  **Payment** only when CASH/QR/CARD was recorded incorrectly. Use **Correct**
  when paid items were wrong or missing: select items to refund, add current
  catalog items for a new charge, enter a reason and Admin PIN, then save. The
  original receipt is never overwritten; the system creates separate linked
  refund and adjustment records and updates money, stock, summaries, and audit
  history together. Use **Refund** for a return that has no replacement sale.
- **Reports & Exports:** daily results and `.xlsx` files for accounting, stock,
  and rent.
- **Payroll:** independent employee records, employment/citizenship and foreign
  document controls, EPF-treatment review, monthly draft salary slips,
  earnings, employee deductions, employer contribution references, three safe
  payment-record modes, paid/void control, and A4 print/PDF output. Payroll
  employees do not automatically get a POS login.
- **Staff & Access:** unique staff IDs, names, 1–8 digit PINs, roles, and active
  status. Editing/deactivating a worker immediately revokes their web sessions.
- **Menu & Tables:** categories and table maintenance. A table with an unpaid
  order cannot be deactivated; renaming it moves the bill safely.
- **System & Audit:** active database path, WAL status, integrity, schema,
  backups, settings, and activity history.

### Payroll and salary slips

1. Open **Admin → Payroll → Payroll setup** and enter the registered business
   address and employer EPF/SOCSO references.
2. Add each employee. Record full-time/part-time/temporary/probationary status,
   Malaysian/non-Malaysian status, and EPF treatment. This list is separate
   from **Staff & Access** because an employee does not need a POS account to
   receive a salary slip. Do not add a contractor merely to avoid employee
   obligations; genuine contractors belong in Accounting with an invoice or
   payment voucher.
3. For a non-Malaysian employee, record the passport number/expiry and work-pass
   number/expiry. Missing or expired documents block a new or linked salary
   payment. A historical record can still be preserved with an explicit audit
   note, but that does not authorise ongoing employment.
4. Choose the payroll month and create a draft. Enter basic pay, overtime,
   allowances, deductions, and both employee/employer contribution shares.
   If an employee marked **EPF required** has a zero employee or employer share,
   enter the reason; the system will not silently treat part-time work or an
   employee request as an exemption.
5. Review the server-calculated gross pay, deductions, and net pay. Preview the
   complete slip before payment.
6. After payment actually occurs, choose **Record payment**, enter the actual
   date/method and an Admin PIN, then choose exactly one Accounting treatment:
   - **Post a new Salary Payment expense** for a payment not yet in Accounting;
   - **Link an existing expense** when an exact matching Expense row already
     exists; or
   - **Historical payment only** when preserving an old paid record and no new
     expense should be posted. This requires a bank/voucher/legacy reference.
7. Use **Print / Save PDF**. Choose A4 paper or the browser's **Save as PDF**
   destination. Keep the final slip with the payroll records.

Employer EPF/SOCSO/EIS contributions are displayed on the slip but are not
deducted from employee net pay and are not automatically posted as paid. Record
those employer payments in Accounting when they are actually remitted.

This module intentionally does not guess statutory rates. EPF contributions
can depend on the current wage band and employee circumstances, so confirm the
amounts using the current [KWSP employer contribution guidance](https://www.kwsp.gov.my/en/employer/responsibilities/mandatory-contribution),
PERKESO/PCB sources, or the shop's accountant before marking a slip paid. KWSP
also states that the monthly payslip should show both employee and employer EPF
shares; the generator prints both. The wage fields retained by the system align
with the normal wages, overtime, allowances, deductions, balance, and payment
date described in the official [Employment Regulations 1957](https://jtksm.mohr.gov.my/sites/default/files/2023-03/1.%20EMPLOYMENT%20REGULATIONS%201957_0.pdf).

KWSP lists permanent, contract, part-time, temporary, and probationary
employees among those generally liable to contribute, and specifically says a
part-time worker is subject to contribution. For non-Malaysian employees,
current KWSP guidance requires valid passport/work-pass and mandatory
contributions from October 2025 wages for covered employees. Verify the current
[KWSP employer overview](https://www.kwsp.gov.my/en/employer/introduction) and
[non-Malaysian employee guidance](https://www.kwsp.gov.my/en/employer/responsibilities/non-malaysian-citizen-employees)
before processing payroll.

If a paid slip is wrong, do not edit or delete its Accounting row. Void the
slip in Payroll with a reason and Admin PIN; the linked salary expense is
reversed safely and the void record remains in history. Then create the correct
replacement slip.

## 10. Product photos

Open **Admin → Stock & Items → Add item/Edit** and choose a JPEG, PNG, or WebP
file. The browser resizes the image before upload. Managed images are stored in:

```text
web_prototype\uploads\items
```

When product photos exist, every verified database backup also creates a
companion `*-item-images.zip` in the backup directory.

### Variants and quantity sets

Open **Admin → Stock & Items → Options** beside an item:

- Add every selectable variant, including the regular choice when the item has
  variants. Example: `Hot + RM 0.00`, `Ice + RM 0.50`.
- Add quantity sets for fixed bundles. Example: quantity `24`, set price
  `RM 238.00`.
- The POS then displays **OPTIONS** on that item card and requires the cashier
  to choose before adding it.

Changing the catalog never changes item names or prices already saved on paid
receipts.

## 11. Receipt printer setup

The system uses the browser print dialog so it works with ordinary Windows
and thermal printers. Salary slips use A4 portrait; check bills and receipts
use the thermal-printer settings below.

Recommended thermal-printer settings:

- paper: 80 mm receipt roll;
- margins: none or minimum;
- scale: 100%;
- headers and footers: off;
- background graphics: on if the driver supports it.

Print one check bill and one paid receipt before the first live shift. Browser
printing cannot silently bypass the print dialog without vendor-specific kiosk
or printer software.

## 12. Backups and restore

Automatic startup backups are enabled by default. A new verified automatic
backup is created when the newest one is older than 12 hours. The Admin setting
controls automatic-backup retention; environment variables can override it.
Use **Admin → System & Audit → Backup now** before upgrades or large data edits.

Keep another copy of the entire `backups` directory on a different physical
disk or encrypted cloud backup. A backup on the same failed PC is not enough.

To restore:

1. Stop the desktop POS and web server.
2. Copy the current `pos.db` to a clearly named recovery folder; do not delete
   it.
3. Copy the chosen verified `.db` backup into the configured live database
   path as `pos.db`.
4. If the matching `*-item-images.zip` exists, extract it into
   `web_prototype\uploads\items`.
5. Run the migration command again; it is idempotent.
6. Start locally and verify **System & Audit** shows `OK`, schema version 9,
   and the expected database path.

## 13. Safe update procedure

1. Finish or hold all table orders.
2. Create a verified backup.
3. Stop the desktop app and web server.
4. Replace application files without deleting `pos.db`, `backups`, or
   `web_prototype\uploads\items`.
5. Install changed requirements.
6. Run `tools\migrate_web_admin.py`.
7. Start on `127.0.0.1` first and check login, System & Audit, one test order,
   check-bill printing, and receipt printing.
8. Re-enable tablet/private-network access only after the local check passes.

## 14. Environment reference

| Variable | Purpose | Default |
| --- | --- | --- |
| `POS_DB_PATH` | active SQLite database | `pos.db` beside server |
| `POS_BACKUP_DIR` | verified backup folder | `backups` |
| `POS_WEB_HOST` | listen address | `127.0.0.1` |
| `POS_WEB_PORT` | listen port | `8000` |
| `POS_ALLOW_REMOTE` | must be `1` for non-loopback binding | unset |
| `POS_ADMIN_PASSWORD_HASH` | PBKDF2 Admin password hash | unset |
| `POS_ADMIN_PASSWORD` | plaintext fallback; avoid in production | unset |
| `POS_AUTO_BACKUP` | `0` disables startup backup | `1` |
| `POS_BACKUP_INTERVAL_HOURS` | automatic backup interval | `12` |
| `POS_BACKUP_RETENTION_DAYS` | environment retention override | Admin setting |
| `POS_BUSINESS_DAY_START` | environment business-day override | Admin setting (`06:00`) |
| `POS_ADMIN_IDLE_SECONDS` | Admin idle timeout | `1800` |
| `POS_SESSION_IDLE_SECONDS` | Order/Cashier idle timeout | `43200` |
| `POS_SESSION_MAX_AGE_SECONDS` | absolute session lifetime | `86400` |
| `POS_TRUST_HTTPS_PROXY` | trust HTTPS/forwarded headers from a controlled proxy | unset |
| `POS_WEB_DEBUG` | include internal errors in API replies; development only | unset |
| `POS_PYTHON_EXE` | Python used by `run_web_pos.ps1` | `.venv`, then `python` |

## 15. Automated verification (developers only)

For a non-destructive operator check, use:

```powershell
.\.venv\Scripts\python.exe tools\check_live_readiness.py
.\.venv\Scripts\python.exe tools\check_live_readiness.py --remote
```

The second command treats a missing Admin password as a failure. Both commands
read the database, latest backup, and public status only; they never change a
business record.

### Destructive developer suites

The integration suites create/edit sales, paid-order corrections, variants,
quantity sets, rent, staff, payroll, stock, cash, refunds, and settings. Never point
them at the live `pos.db`.

Use an explicit disposable copy and port. The main suites are:

```text
tools\test_web_api.py
tools\test_web_ui.js
tools\test_web_concurrency.py
tools\test_web_restart_recovery.py
tools\test_web_security.py
```

## 16. Troubleshooting

- **Port already in use:** choose another `-Port`, or stop only the known old
  server process.
- **Database unavailable:** check `POS_DB_PATH`, file permissions, free disk
  space, and whether **System & Audit** names the intended database.
- **PIN not recognised:** confirm the worker is active and that active PINs are
  unique numeric values of 1–8 digits.
- **Admin cannot open POS:** this is intentional. Use a Cashier account at the
  counter.
- **Cashier cannot edit stock:** this is intentional; Cashier stock is
  read-only. Use Admin for adjustments.
- **Checkout reports stale order:** another terminal changed the bill. Review
  the newest version shown, then retry.
- **Checkout reports insufficient stock:** correct the order or have Admin
  adjust the verified physical stock count.
- **Tablet cannot connect:** confirm private Wi-Fi, private firewall rule,
  correct shop-PC IP, `-AllowRemote`, and a configured Admin password hash.
- **Receipt layout is wrong:** verify 80 mm paper, scale, margins, headers, and
  the Windows printer driver.
- **Salary slip amount is wrong:** correct the draft before payment. If it was
  already paid, use Payroll **Void** and create a replacement; never alter its
  linked Accounting row directly.
