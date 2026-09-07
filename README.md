# Geo-Lo Attendance System

A geofencing-based attendance system for businesses that need trusted check-in and check-out times.

Geo-Lo is multi-tenant. The **Geo-Lo owner** (super admin) hooks organizations onto the product. Each **organization admin** then tracks only that company's workers.

## Features

- Super admin console for onboarding organizations and their admins
- Organization admin console for workers, locations, shifts, and payroll
- Worker PIN login with device binding
- Geofenced check-in, GPS accuracy and travel checks
- Server-side face capture on check-in (when enrolled or required)
- Shifts with lateness, absence, overtime, and grace periods
- Multiple punches per day, missed-checkout auto-close, manager corrections + audit log
- Live “who’s at work” dashboard and exception alerts
- Payroll export (CSV / Excel)
- Multiple work locations per organization

## Access

Apache on this machine is typically `http://localhost:8080`.

- Worker app: `http://localhost:8080/Geo-lo/frontend/login.html`
- Organization admin login: `http://localhost:8080/Geo-lo/frontend/admin-login.html` → `admin.php`
- Geo-Lo owner login: `http://localhost:8080/Geo-lo/frontend/super-login.html` → `super.php`

**Geo-Lo owner:** `boss@geo-lo` / `boss1234`  
Organization admins sign in with the account created when their company was hooked on.

Existing installs keep current workers under “Existing organization” until you assign an org admin.

## Installation

1. Create MySQL database `geo_lo` and import `database/schema.sql` (optional if tables already exist — the API also creates missing tables on first request).
2. Copy `env.example` to `.env` in the project root. Local XAMPP often uses `root` with a blank password. If you set a MySQL password, put the **same** value in `.env` as `DB_PASSWORD`. That is the app setting — it is not a column inside the `geo_lo` tables.
3. Use HTTPS in production so the browser can access GPS and camera.

## Run live on Render

Render does not have a native PHP runtime, so this repo ships a Docker image (`php:8.2-apache`) plus a MySQL private service.

1. Push this project to a GitHub repository.
2. In [Render](https://dashboard.render.com), click **New** → **Blueprint** and point it at that repo (`render.yaml`).  
   Or create the two services by hand:
   - **Private Service** named `geo-lo-mysql`, Docker image `mysql:8.4`, disk mounted at `/var/lib/mysql` (10 GB). Set `MYSQL_DATABASE=geo_lo`, `MYSQL_USER=geolo`, `MYSQL_PASSWORD`, and `MYSQL_ROOT_PASSWORD`.
   - **Web Service** from the same GitHub repo, runtime **Docker**, health check `/login.html`.
3. On the web service, set:

   | Variable | Value |
   | --- | --- |
   | `DB_HOST` | Internal hostname of the MySQL service (shown on that service’s page) |
   | `DB_PORT` | `3306` |
   | `DB_NAME` | `geo_lo` |
   | `DB_USER` | `geolo` |
   | `DB_PASSWORD` | The MySQL user password |

   You can also point `DB_*` at any other hosted MySQL. Optional: `APP_URL=https://your-service.onrender.com`.
4. Wait until MySQL is live, then deploy (or redeploy) the web service. The first API request creates tables and the owner account.
5. Open:

   - Worker: `https://your-service.onrender.com/login.html`
   - Organization admin: `https://your-service.onrender.com/admin-login.html`
   - Geo-Lo owner: `https://your-service.onrender.com/super-login.html`

MySQL on Render needs a paid private service with a disk. Change the owner password after the first live login.

## API notes

All operational endpoints require `Authorization: Bearer <token>` or `X-Auth-Token`.  
Login: `POST /api/auth.php` (`role: admin` + password, or worker email + PIN).  
Organization admins only see data for their `organization_id`.  
Super-admin endpoints: `/api/super.php` (Geo-Lo owner only).
