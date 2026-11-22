# Geo-Lo Attendance System

A geofencing-based attendance system for businesses that need trusted check-in and check-out times.

Geo-Lo is multi-tenant. The **Geo-Lo owner** (super admin) hooks organizations onto the product. Each **organization admin** then tracks only that company's workers.

## Features

- Super admin console for onboarding organizations and their admins
- Organization admin console for workers, locations, shifts, and payroll
- Worker login with organization name, email and PIN, plus device binding
- Geofenced check-in and check-out (both refused outside the work area), with a per-shift cut-off that closes check-in once the day's period has ended, plus GPS accuracy and travel checks
- Server-side face capture on check-in (when enrolled or required)
- Shifts with lateness, absence, overtime, and grace periods
- Multiple punches per day, missed-checkout auto-close, manager corrections + audit log
- Live “who’s at work” dashboard and exception alerts
- Payroll export (CSV / Excel)
- Multiple work locations per organization

## Access

Apache on this machine is typically `http://localhost:8080`.

- Website (landing page + "Get Started" form): `http://localhost:8080/Geo-lo/website/index.html`
- Geo-Lo owner console: `http://localhost:8080/Geo-lo/website/owner.php`
- Worker app: `http://localhost:8080/Geo-lo/frontend/login.html`
- Organization admin login: `http://localhost:8080/Geo-lo/frontend/admin-login.html` → `admin.php`
- Geo-Lo owner login: `http://localhost:8080/Geo-lo/website/owner-login.html` → `owner.php`

On the Docker/Render deployment the website is the site root and the app is mounted at `/app`:

- Website: `/`
- Worker app: `/app/login.html`
- Organization admin: `/app/admin-login.html`
- Geo-Lo owner: `/owner-login.html`

**Geo-Lo owner:** `boss@geo-lo` / `boss1234`  
Organization admins sign in with the account created when their company was hooked on.

Existing installs keep current workers under “Existing organization” until you assign an org admin.

## Onboarding a company

Companies request access through the website's "Get Started" form, which verifies
payment with Paystack and stores the request in `onboarding_requests` (same
database as the app). The Geo-Lo owner opens **Onboarding** in the owner console,
picks a company and registers it — the organization is created with the plan that
company chose, and the request is linked to the new organization.

## Installation

1. Create MySQL database `geo_lo` and import `database/schema.sql` (optional if tables already exist — the API also creates missing tables on first request).
2. Copy `env.example` to `.env` in the project root. Local XAMPP often uses `root` with a blank password. If you set a MySQL password, put the **same** value in `.env` as `DB_PASSWORD`. That is the app setting — it is not a column inside the `geo_lo` tables.
3. Website settings in the same `.env`: `PAYSTACK_SECRET_KEY`, `RESEND_API_KEY`, `MAIL_FROM` and `OWNER_PASSWORD`. Without a Paystack key the "Get Started" form cannot verify payments.
4. Use HTTPS in production so the browser can access GPS and camera.

## Run live on Render (free)

Render has **no free MySQL**. A MySQL private service on Render needs a paid disk, so this project does not create one.

Free setup = **Render free web service** (this PHP app) + a **free MySQL somewhere else**. [TiDB Cloud Starter](https://tidbcloud.com/) is MySQL-compatible and has a free quota. Do not put the database on the Render web instance: free web disks are wiped when the app sleeps or redeploys.

1. Create a free [TiDB Cloud](https://tidbcloud.com/) account (no credit card required for the Starter free quota).
2. Create a **Starter** cluster. Open **Connect**, choose **Public**, and copy host, port, user, password. Port is usually **`4000`**, not 3306. Create a database named `geo_lo` (or use the default `test` name and put that in `DB_NAME`).
3. Push this project to GitHub, then in [Render](https://dashboard.render.com) click **New** → **Blueprint** and select the repo. Choose the **Free** plan for `geo-lo`. When prompted, paste:

   | Variable | Value |
   | --- | --- |
   | `DB_HOST` | TiDB public host |
   | `DB_PORT` | `4000` |
   | `DB_NAME` | `geo_lo` (or `test`) |
   | `DB_USER` | TiDB user |
   | `DB_PASSWORD` | TiDB password |
   | `PAYSTACK_SECRET_KEY` | Paystack secret key |
   | `RESEND_API_KEY` | Resend API key |
   | `MAIL_FROM` | `Geo-Lo <onboarding@resend.dev>` |
   | `OWNER_PASSWORD` | Owner console password |

   `DB_SSL=1` is set automatically. Optional: `APP_URL=https://your-service.onrender.com`.
4. Wait until the web service is live. The first API request creates tables and the owner account.
5. Open:

   - Website: `https://your-service.onrender.com/`
   - Worker: `https://your-service.onrender.com/app/login.html`
   - Organization admin: `https://your-service.onrender.com/app/admin-login.html`
   - Geo-Lo owner: `https://your-service.onrender.com/owner-login.html`

Free Render apps sleep after idle time; the first request can take about a minute. Change the owner password after the first live login.

## API notes

All operational endpoints require `Authorization: Bearer <token>` or `X-Auth-Token`.  
Login: `POST /api/auth.php` (`role: admin` + password, or worker email + PIN).  
Organization admins only see data for their `organization_id`.  
Super-admin endpoints: `/api/super.php` (Geo-Lo owner only).
