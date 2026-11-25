# 919 POS — Muar Shop and KL Owner Rollout

This is the recommended first production shape for one shop. The Muar Windows
PC remains the only application and database owner. Shop tablets connect over
the private shop Wi-Fi; the owner in Kuala Lumpur connects through a private
encrypted network. Do not place `pos.db` on Google Drive/Dropbox and do not
open router port 8000 to the Internet.

## Why this shape

- Checkout keeps working on the shop LAN even if the Internet connection is
  temporarily down.
- Only one POS process writes the SQLite database.
- There is no database-server account or monthly database bill in phase 1.
- The KL owner reaches the same live records without making the POS public.

## Before the first live shift

1. Test every function locally at `http://127.0.0.1:8000/`.
2. In **Admin → Staff & Access**, give every worker a unique short PIN and the
   minimum role they need.
3. In **Admin → Settings**, complete the business name/address, receipt footer,
   business-day start, and employer reference numbers.
4. Print one 80 mm check bill and one paid receipt.
5. Create one test cash sale and one test QR sale, confirm receiver names,
   stock, cashflow, and recent receipts, then correct/refund them using the
   audited workflow if necessary.
6. Test Cash opening/expense/end-of-day, rent collection/void, a stock
   adjustment, accountant export, and a draft salary slip.
7. Run the read-only local readiness report:

   ```powershell
   .\.venv\Scripts\python.exe tools\check_live_readiness.py
   ```

8. Copy the `backups` folder to a second encrypted device/location and perform
   one restore rehearsal on a disposable copy.

## Shop tablets on the Muar Wi-Fi

1. Create the strong Admin password hash described in
   `SETUP_AND_OPERATIONS.md`.
2. Reserve the shop PC's IP address in the router, for example
   `192.168.1.20`.
3. Allow TCP port 8000 only on the Windows **Private** firewall profile.
4. Start the POS with:

   ```powershell
   .\run_web_pos.ps1 -ListenAddress 0.0.0.0 -Port 8000 -AllowRemote
   ```

5. Open `http://SHOP-PC-IP:8000/` from each tablet. Save it to the home screen.
6. Use **Order Only** for ordering tablets and **Cashier** only at trusted
   payment stations.
7. Run the stricter check before leaving remote listening enabled:

   ```powershell
   .\.venv\Scripts\python.exe tools\check_live_readiness.py --remote
   ```

## Owner access from Kuala Lumpur

Use a business-appropriate private-network plan such as Tailscale Standard.
Install the client on the Muar server PC and the owner's KL laptop/tablet, sign
both into the same organisation, and permit only the owner device/user to reach
the Muar PC on TCP 8000. Open the server by its private network name or 100.x
address. Use **Admin** mode; Admin intentionally has reports/records but no
table-order workspace.

Do not use Tailscale Funnel or any public-sharing feature for this POS. Do not
configure router port forwarding. The strong POS Admin password remains
required even inside the private network.

Tailscale's published Standard price was USD 8 per user/month when this guide
was checked on 1 September 2026. Confirm current commercial pricing before
sign-up. The Personal plan is described by Tailscale as non-commercial, so it
is not the correct production plan for a shop.

## Backups and capacity

- Current live database size is about 11 MB; product photos are stored beside
  the application and included in companion backup ZIP files when present.
- Start with at least 10 GB for POS data/backups. This is far above the current
  requirement and leaves room for years of records and compressed item photos.
- Keep the automatic local backups for fast recovery and copy them daily to a
  separate encrypted drive or reputable cloud-backup folder.
- Never allow a sync program to work directly on the live `pos.db`, `-wal`, or
  `-shm` files. Sync only verified files from the `backups` directory.
- Keep at least 30 days locally, monthly copies for the period agreed with the
  accountant, and test a restore at least quarterly.

## Automatic startup

After manual testing passes, configure Windows Task Scheduler exactly as
described in `SETUP_AND_OPERATIONS.md`. Use the Windows account that owns the
POS files, enable restart on failure, and verify there is exactly one listener
on port 8000. Re-run the readiness report after rebooting the Muar PC.

## Go-live decision

Go live only when all of these are true:

- the local and `--remote` readiness reports have no failures;
- the strong Admin password is stored in a password manager and its hash is
  configured for the server account;
- all staff have their own PINs and understand their workspace;
- the printer and cash/QR flows were tested;
- a verified off-device backup and restore rehearsal succeeded;
- the Muar PC has reliable power, Windows auto-start, and a known support
  contact/process.

If the shop later grows to multiple branches or needs the server to remain
available while the Muar PC is off, plan a separate phase to replace SQLite
with a managed server database and deploy the application behind HTTPS. That
is an architectural migration, not a safe first-day configuration switch.
