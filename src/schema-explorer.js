const { pool, qi } = require("./db");
const { tables, schema } = require("./schema");

async function overview() {
  const visible = await tables(),
    names = visible.map((t) => t.name);
  if (!names.length) return { tables: [], relationships: [] };
  const { rows: columns } = await pool.query(
    `SELECT r.relname AS table, a.attname AS name,
    format_type(a.atttypid,a.atttypmod) AS type, NOT a.attnotnull AS nullable,
    EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=r.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS pk
    FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace JOIN pg_attribute a ON a.attrelid=r.oid
    WHERE n.nspname='public' AND r.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY r.relname,a.attnum`,
    [names],
  );
  const { rows: relationships } = await pool.query(
    `SELECT c.conname AS name, r.relname AS source, rr.relname AS target,
    rn.nspname AS "targetSchema", array_agg(a.attname::text ORDER BY k.position) AS columns,
    array_agg(ra.attname::text ORDER BY k.position) AS "targetColumns"
    FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    JOIN pg_class rr ON rr.oid=c.confrelid JOIN pg_namespace rn ON rn.oid=rr.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY AS k(local,remote,position)
    JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.local
    JOIN pg_attribute ra ON ra.attrelid=rr.oid AND ra.attnum=k.remote
    WHERE c.contype='f' AND n.nspname='public' AND r.relname=ANY($1::text[])
    AND rn.nspname='public' AND rr.relname=ANY($1::text[])
    GROUP BY c.oid,c.conname,r.relname,rr.relname,rn.nspname ORDER BY r.relname,c.conname`,
    [names],
  );
  return {
    tables: visible.map((t) => ({
      ...t,
      columns: columns.filter((c) => c.table === t.name),
    })),
    relationships,
  };
}
function tableDefinition(meta, details, constraints) {
  const fields = meta.columns.map((c) => {
    const detail = details.find((d) => d.name === c.name);
    let sql = `  ${qi(c.name)} ${c.description}`;
    if (c.generated) sql += ` GENERATED ALWAYS AS (${c.default}) STORED`;
    else if (c.identity)
      sql += ` GENERATED ${detail?.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
    else if (c.default !== null) sql += ` DEFAULT ${c.default}`;
    if (!c.nullable) sql += " NOT NULL";
    return sql;
  });
  fields.push(
    ...constraints.map((c) => `  CONSTRAINT ${qi(c.name)} ${c.definition}`),
  );
  return `-- Read-only catalog reference; not a complete migration or backup.\n-- Dependent types, sequences, partitions, policies, grants and storage options are not included.\nCREATE TABLE "public".${qi(meta.name)} (\n${fields.join(",\n")}\n);`;
}
async function definition(name) {
  const meta = await schema(name);
  const { rows: details } = await pool.query(
    `SELECT a.attname AS name,a.attidentity AS identity FROM pg_attribute a
    JOIN pg_class r ON r.oid=a.attrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND r.relname=$1 AND a.attnum>0 AND NOT a.attisdropped`,
    [name],
  );
  const { rows: constraints } = await pool.query(
    `SELECT c.conname AS name,pg_get_constraintdef(c.oid,true) AS definition
    FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND r.relname=$1 AND c.contype IN ('p','u','f','c','x') ORDER BY c.contype,c.conname`,
    [name],
  );
  const { rows: indexes } = await pool.query(
    `SELECT indexname AS name,indexdef AS definition FROM pg_indexes
    WHERE schemaname='public' AND tablename=$1 ORDER BY indexname`,
    [name],
  );
  return {
    name,
    sql: tableDefinition(meta, details, constraints),
    indexes,
    columns: meta.columns,
  };
}
module.exports = { overview, definition, tableDefinition };
