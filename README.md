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

## Table editor

The standalone Express app now provides a responsive table workspace with a searchable `public` table sidebar, sticky grid headers, column visibility, and 25/50/100-row server-side pages. Click a column header to sort; use the filter toolbar for literal text contains, text equality, NULL, or not-NULL filtering. Only one page plus one lookahead row is fetched. The footer reports displayed rows and whether another page exists; it deliberately avoids full-table counts.

Use **Add row** or **Open** to open the shared drawer. Each editable field has an explicit value mode:
- **Use database default / Leave unset**: omit the column from INSERT.
- **Keep current value**: omit the column from UPDATE.
- **Set value**: send the entered value (including an intentional empty string for text).
- **NULL**: send SQL NULL for a nullable column. JSON `null` entered in the JSON editor is distinct from SQL NULL.

Forms discover numeric, boolean, date, timestamp, enum, JSON and foreign-key metadata. Timestamptz inputs use UTC. Numeric and timestamp values travel as text to preserve database precision; unchanged timestamps are never rewritten. Primary keys are immutable during editing, while manually assigned keys can be entered on insert. Identity/generated columns and PostGIS geometry/geography/raster columns are read-only on both client and server. PostGIS values use PostgreSQL's text representation.

Single-column foreign keys referencing accessible public tables have a debounced search and selector (up to 30 matches). Choosing an option writes its actual referenced key; the name/title/code is only a display label. Manual key entry remains available. Composite primary keys work for edits and deletion. Tables without primary keys support browsing and insertion only. Deletion requires a confirmation dialog and respects database cascade/restrict rules.

## Sessions and security details

Existing PostgreSQL-backed sessions and `/health` are preserved. The existing `public.session` table must already exist and the restricted account must have the permissions needed by the session store. Automatic session-table creation is disabled: this app never performs schema DDL. For a fresh installation, have the database owner provision the session table using the schema supplied by `connect-pg-simple` before starting the app. An existing installation with the original admin normally already has this table.

`SESSION_SECRET` must be at least 32 characters; there is no insecure fallback. Login regenerates the session. Forms and API mutations require a session CSRF token. Helmet CSP is enabled, assets are local, cookies are HttpOnly/SameSite=Lax, and login remains rate limited. Set `COOKIE_SECURE=true` and `TRUST_PROXY=1` only behind your trusted HTTPS reverse proxy. Local HTTP keeps both disabled. Database and login credentials stay server-side.

Identifiers are validated against fresh discovered metadata and quoted; values, filters, pagination and keys use query parameters. Queries have a 15-second timeout. Session, migration and PostGIS metadata tables are excluded. The app does not expose SQL execution or PostgreSQL role/extension/schema management. The configured account must remain a restricted non-owner, non-superuser.

Successful writes produce structured audit records with admin, action, table, affected count and timestamp. Row values and primary-key values are deliberately excluded because even keys may be sensitive. Error logs include only a safe code and timestamp, never PostgreSQL error detail, SQL, passwords, tokens or request bodies. Database audit tables are ordinary data; the app's operational audit trail is its container stdout.

## Validation and maintenance

```sh
npm ci
npm test
# Run only the admin lifecycle from this directory:
docker compose up -d --build
```

The root database Compose and the BE Compose are unchanged. No frontend build tool or external asset service is required; Docker copies the server and static UI together.

Main modules: `src/schema.js` (metadata), `src/rows.js` (validated row queries), `src/routes/api.js` (API), `src/app.js` (sessions/login/health), `src/public/` (grid, drawer, styling), and `src/utils/audit.js` (safe structured logging).

Limitations: FK pickers handle single-column public references only; composite/cross-schema references use manual inputs. Custom/domain/array types use PostgreSQL text input; spatial fields cannot be created or edited here, so tables with mandatory spatial columns and no default need application tooling for inserts. Filtering casts values to text and may scan large tables; offset pagination can slow down at deep pages and concurrent writes can shift page boundaries. There is no optimistic concurrency check: overlapping edits to the same field use the last successful write. No exact row totals, bulk editing, saved views, or persistent column preferences yet. Permissions shown are table-level; column grants and RLS may further restrict results or writes. Application enums stored as integers cannot expose labels through PostgreSQL enum introspection. Use the backend for business workflows such as password hashing and application role assignment.

For the opt-in integration suite, start a **disposable** `postgis/postgis:16-3.4` container on `127.0.0.1:55439` with `POSTGRES_PASSWORD=isolated-test-only`, then run:
```sh
DB_HOST=127.0.0.1 DB_PORT=55439 DB_NAME=postgres DB_USER=fixture_admin DB_PASSWORD=fixture-only node test/integration.js
```
This creates and resets synthetic `Fixture*` tables, a test session table, and a restricted fixture role. Never point it at an existing database. Stop and remove the disposable container afterward.

Validation in this change: six query/security unit tests, restricted-account integration tests against disposable PostgreSQL 16/PostGIS 3.4, and Docker build plus non-root health/login/static-asset smoke tests passed. Browser visual QA remains pending because no connected browser was available. The existing dependency lockfile currently reports three moderate npm audit findings in the Express/body-parser/qs chain; automatic remediation proposed downgrades and was not retained. Review a compatible patched dependency set as a follow-up.

## SQL Schema explorer

Choose **SQL Schema** in the sidebar to inspect database structure at `/schema`. The read-only diagram shows accessible public tables, primary keys and foreign-key arrows (including composite and self-referencing foreign keys). Select a table to focus on its neighbors, inspect related tables, or switch to all tables and change zoom. The canvas scrolls for larger schemas; the relationship list also exposes the column mappings without relying on the diagram.

The definition panel shows a CREATE TABLE-style catalog reference, constraints, indexes and PostgreSQL enum values, with a link back to the row editor. This is documentation, not a full migration/export: dependent types/sequences, partitions, storage options, policies and grants are not reconstructed. Cross-schema or inaccessible targets are omitted from the diagram; the selected table's constraint definitions may still mention them. The explorer reads catalog metadata only, uses the existing session/account restrictions, and offers no SQL execution or schema modification.
