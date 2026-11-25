# 919 Web POS Interface

This folder contains the responsive browser client served by `web_server.py`.
It is not a standalone static demo: authentication, products, tables, active
orders, payments, stock, cashflow, rent, reports, settings, and audit data are
read from and written to the configured SQLite database.

Start the application from the project root:

```powershell
.\.venv\Scripts\python.exe tools\migrate_web_admin.py
.\run_web_pos.ps1
```

Open `http://127.0.0.1:8000/`; do not open these HTML files directly from the
filesystem because the UI requires the authenticated API.

Main capabilities:

- Free/Unpaid table layout with any configured number of active tables
- Persistent table-specific orders with notes and fixed-amount discounts
- Product search, categories, Admin-managed variants/sets, fixed-height cards,
  and photos
- Customer check-bill printing before checkout
- Cash checkout with cash received/change and QR checkout without cash input
- Receiving-cashier PIN on every payment and rent collection
- Atomic sale, stock, cashflow, daily totals, receipt, and table release
- Saved receipt history and reprint
- Cash Center with opening, other income/expense, and end-of-day reconciliation
- Rent stall list, due reminders, collection, history, and Admin void
- Admin accounting, stock/items/options, immutable paid-receipt corrections,
  sales/refunds, payroll employees and printable salary slips, reports/exports,
  staff, tables, settings, database integrity, verified backup, and audit
- Separate Order Only, Cashier, and Admin workspaces
- Responsive desktop, laptop, tablet landscape, and tablet portrait layouts

See the project-level [setup and operations guide](../SETUP_AND_OPERATIONS.md)
for deployment, security, printing, backups, and recovery.
