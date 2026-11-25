# 919 Website POS

Open `START_WEB_POS_LOCAL.cmd`, then visit http://127.0.0.1:8000/.
For dependency setup on a new computer, run `SETUP_WEB_ON_NEW_PC.cmd` first.

- `source\web_server.py`: website backend.
- `source\web_prototype`: browser interface and assets.
- `source\category_list_prices.py`: pricing helper, also present in Desktop POS.
- `source\tools`: migration, readiness, password-hash, and web integration tools.
- `source\tests`: web unit tests.
- `source\.venv`: preserved Python environment.

The launcher passes the sibling `Desktop POS\app\pos.db` and
`Desktop POS\Backups` paths explicitly. Both POS interfaces continue to use the
same live data; the database has not been duplicated. Keep both projects inside
the same parent folder for these launchers.

## Development and checks

Run from the `source` folder:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe tools\generate_admin_password_hash.py
.\.venv\Scripts\python.exe tools\check_live_readiness.py --database "..\..\Desktop POS\app\pos.db" --backup-dir "..\..\Desktop POS\Backups"
```

Use `python.exe -m pip` to manage this environment. Direct use of
`source\run_web_pos.ps1` or `web_server.py` still defaults to a database in
`source`; use the project launchers for the existing live database. Migration
tools also require explicit `POS_DB_PATH` and `POS_BACKUP_DIR` values for live
data. Review `source\SETUP_AND_OPERATIONS.md` and
`source\DEPLOYMENT_CHECKLIST.md` before migrations, remote access, or deployment.

For authorized LAN/private-network access, use `START_WEB_POS.ps1` with
`-ListenAddress 0.0.0.0 -Port 8000 -AllowRemote` after configuring the Admin
password hash. Keep the server on the trusted shop LAN or a properly configured
private encrypted network.

Web integration tools change records and must only target a disposable test
database. Never run them against the live shop database.

The `.gitignore` excludes environments, databases, backups, and uploaded item
images. Review source before publishing to GitHub; uploading the code does not
deploy an online website.
