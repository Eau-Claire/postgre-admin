const { pool } = require("./db");
const excluded = ["spatial_ref_sys", "__EFMigrationsHistory", "session"];
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
async function tables() {
  const { rows } = await pool.query(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> ALL($1) AND has_table_privilege(format('%I.%I',table_schema,table_name),'SELECT') ORDER BY table_name`,
    [excluded],
  );
  return rows;
}
async function schema(name) {
  if (!(await tables()).some((t) => t.name === name))
    throw fail("Table not found", 404);
  const { rows: columns } = await pool.query(
    `SELECT a.attname AS name, t.typname AS type, format_type(a.atttypid,a.atttypmod) AS description,
    NOT a.attnotnull AS nullable, pg_get_expr(d.adbin,d.adrelid) AS default,
    a.attidentity <> '' AS identity, a.attgenerated <> '' AS generated,
    EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=r.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS pk,
    ARRAY(SELECT enumlabel::text FROM pg_enum WHERE enumtypid=t.oid ORDER BY enumsortorder) AS options
    FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace JOIN pg_attribute a ON a.attrelid=r.oid
    JOIN pg_type t ON t.oid=a.atttypid LEFT JOIN pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND r.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [name],
  );
  const { rows: fks } = await pool.query(
    `SELECT a.attname AS column, rn.nspname AS schema, rr.relname AS table, ra.attname AS target,
    cardinality(c.conkey) AS width FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    JOIN pg_class rr ON rr.oid=c.confrelid JOIN pg_namespace rn ON rn.oid=rr.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey,c.confkey) AS k(local,remote)
    JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.local JOIN pg_attribute ra ON ra.attrelid=rr.oid AND ra.attnum=k.remote
    WHERE c.contype='f' AND n.nspname='public' AND r.relname=$1`,
    [name],
  );
  const {
    rows: [permissions],
  } = await pool.query(
    `SELECT has_table_privilege(format('public.%I',$1::text),'INSERT') AS insert, has_table_privilege(format('public.%I',$1::text),'UPDATE') AS update, has_table_privilege(format('public.%I',$1::text),'DELETE') AS delete`,
    [name],
  );
  for (const c of columns) {
    c.spatial = ["geometry", "geography", "raster"].includes(c.type);
    c.readonly = c.spatial || c.generated || c.identity;
    c.fk = fks.find((f) => f.column === c.name) || null;
  }
  return { name, columns, permissions };
}
module.exports = { tables, schema, fail };
