# uavpms-db-admin

Standalone, read/write internal PostgreSQL administration UI for UAV PMS. It is intentionally separate from the main backend Compose lifecycle and discovers public tables and columns dynamically.

## Configuration
Copy `.env.example` to `.env` and set `DB_PASSWORD`, `ADMIN_PASSWORD_HASH`, and a strong `SESSION_SECRET`. The app uses `uavpms-db:5432`; credentials are never sent to the browser.

Generate credentials:
```sh
node -e "console.log(require('bcryptjs').hashSync('CHANGE_ME', 12))"
openssl rand -hex 32
```

## Development and deployment
```sh
npm install
node src/app.js
docker network create uavpms-infra # only if it does not already exist
docker compose up -d --build
```
The host binds to `127.0.0.1:3001`; put Nginx/HTTPS in front if remote access is needed. Health is available without login at `/health`.

## Database permissions
Use a non-owner, non-superuser account. Example (adjust ownership/table scope to your deployment):
```sql
CREATE USER uav_admin PASSWORD 'use-a-secret';
GRANT CONNECT ON DATABASE uavpms TO uav_admin;
GRANT USAGE ON SCHEMA public TO uav_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uav_admin;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO uav_admin;
```
No migrations, role management, extension creation, schema changes, or arbitrary SQL endpoint are implemented. PostGIS fields are displayed by PostgreSQL's normal text representation and are not editable in v1. Changes are logged as structured audit records without sensitive field values.

## Security and backups
Use a strong password hash and session secret, keep `.env` private, restrict network access, and back up PostgreSQL before edits. This is a database tool, not the official UAV PMS business/user-management UI; direct edits can bypass validation, hashing, role assignment, and audit logic.
