# Migration Repair — Operator Guide

If your DB ever shows runtime errors like `NOT NULL constraint failed: cloud_files.local_path`,
or AI Chat throws an error parsing scopes, your DB likely has silently-skipped migrations.
This guide walks you through repairing.

## Step 1: Check whether `cloud_files.local_path` still exists

```bash
sqlite3 /opt/darkride/data/darkride.db "SELECT name FROM pragma_table_info('cloud_files') WHERE name = 'local_path'"
```

- Output `local_path` → the column is still present. **You need both scripts.**
- Empty output → the column is already dropped. **You only need the always-safe script.**

## Step 2: Run the always-safe repair script

Linux / macOS:

```bash
sqlite3 /opt/darkride/data/darkride.db < scripts/repair-skipped-migrations.sql
```

Windows PowerShell:

```powershell
Get-Content scripts\repair-skipped-migrations.sql | sqlite3.exe C:\darkride\data\darkride.db
```

This is idempotent — safe to re-run.

## Step 3 (only if Step 1 showed `local_path`): Run the column-drop repair script

Linux / macOS:

```bash
sqlite3 /opt/darkride/data/darkride.db < scripts/repair-cloud-files-local-path.sql
```

Windows PowerShell:

```powershell
Get-Content scripts\repair-cloud-files-local-path.sql | sqlite3.exe C:\darkride\data\darkride.db
```

## Step 4: Restart the DarkRide server

The migrator now sees the at-risk migrations as applied and continues with any newer ones.
