# 919 Web POS Delivery Status

The original prototype checkpoints are now implemented against the SQLite
database. This file records delivered scope and the boundary of the current
system.

## Delivered

- Persistent Free/Unpaid tables and recoverable held orders
- Optimistic multi-terminal editing and idempotent transactional checkout
- Cash and QR flows with receiving-staff attribution
- Check bill, paid receipt, receipt history, and reprint
- Stock deduction for items, variants, and quantity sets
- Stock movement ledger, manual adjustments, low-stock visibility, and photos
- Opening cash, other income/expense, and end-of-day reconciliation
- Stall tenants, due reminders, collections, history, synchronization, and void
- Accounting ledger/categories, sales correction, partial refunds, and exports
- Staff roles, unique PINs, session revocation, menu/category/table maintenance
- Admin settings, audit history, SQLite integrity/WAL status, verified database
  backups, and companion product-photo archives
- Responsive Order Only, Cashier, and Admin workspaces
- Automated API, browser UI, concurrency, restart-recovery, and security checks

## Current deployment boundary

- The built-in server is intended for one shop computer and trusted local or
  private-network devices.
- Public Internet access requires an external private network or HTTPS access
  gateway; direct router port-forwarding is unsupported.
- Printing uses the browser/Windows print dialog. Silent vendor-specific
  thermal printing is outside the browser implementation.
- SQLite is the source of truth. There is no cloud database or offline
  multi-location synchronization in this version.

Operational instructions are in `SETUP_AND_OPERATIONS.md` at the project root.
