const { pool, qi } = require("./db");
const { fail } = require("./schema");
const tableSQL = (s) => `"public".${qi(s.name)}`;
// Text casts preserve numeric precision, timestamp precision and PostGIS output.
const projection = (s) =>
  s.columns.map((c) => `${qi(c.name)}::text AS ${qi(c.name)}`).join(",");
const column = (s, n) => {
  const c = s.columns.find((c) => c.name === n);
  if (!c) throw fail("Unknown column");
  return c;
};
function pageQuery(s, q = {}) {
  const size = Number(q.size || 25),
    page = Number(q.page || 1);
  if (
    ![25, 50, 100].includes(size) ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1000000
  )
    throw fail("Invalid pagination");
  const params = [];
  let where = "";
  if (q.column) {
    const c = column(s, q.column),
      op = q.op || "contains";
    if (op === "null") where = ` WHERE ${qi(c.name)} IS NULL`;
    else if (op === "notnull") where = ` WHERE ${qi(c.name)} IS NOT NULL`;
    else if (["contains", "eq", "neq", "gt", "gte", "lt", "lte"].includes(op)) {
      if (typeof q.value !== "string" || q.value.length > 1000)
        throw fail("Invalid filter");
      if (op === "contains") {
        params.push(`%${q.value.replace(/[\\%_]/g, "\\$&")}%`);
        where = ` WHERE ${qi(c.name)}::text ILIKE $1`;
      } else {
        params.push(q.value);
        const opSymbol = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" }[op];
        const isNum = ["int2", "int4", "int8", "numeric", "float4", "float8"].includes(c.type);
        const isDate = ["timestamp", "timestamptz", "date"].includes(c.type);
        if (isNum && !isNaN(Number(q.value))) {
          where = ` WHERE ${qi(c.name)} ${opSymbol} $1::numeric`;
        } else if (isDate) {
          where = ` WHERE ${qi(c.name)} ${opSymbol} $1::timestamptz`;
        } else {
          where = ` WHERE ${qi(c.name)}::text ${opSymbol} $1`;
        }
      }
    } else throw fail("Invalid filter operator");
  }
  const order = [];
  if (q.sort) {
    const c = column(s, q.sort);
    if (!["asc", "desc", undefined].includes(q.direction))
      throw fail("Invalid sort direction");
    const cast = ["json", "geometry", "geography", "raster"].includes(c.type)
      ? "::text"
      : "";
    order.push(
      `data.${qi(c.name)}${cast} ${q.direction === "desc" ? "DESC" : "ASC"}`,
    );
  }
  for (const c of s.columns.filter((c) => c.pk && c.name !== q.sort))
    order.push(`data.${qi(c.name)} ASC`);
  const sql = `SELECT ${projection(s)} FROM ${tableSQL(s)} AS data${where}${order.length ? " ORDER BY " + order.join(",") : ""} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  return { sql, params: [...params, size + 1, (page - 1) * size], size, page };
}
async function list(s, q) {
  const p = pageQuery(s, q),
    { rows } = await pool.query(p.sql, p.params);
  return {
    rows: rows.slice(0, p.size),
    hasNext: rows.length > p.size,
    page: p.page,
    size: p.size,
  };
}
function values(s, data, editing) {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw fail("Expected field values");
  return Object.entries(data).map(([name, value]) => {
    const c = column(s, name);
    if (c.readonly || (editing && c.pk)) throw fail("Field is read-only");
    if (value === null) {
      if (!c.nullable) throw fail("A required field cannot be NULL");
    } else {
      if (typeof value !== "string" && typeof value !== "boolean")
        throw fail("Invalid field value");
      if (["json", "jsonb"].includes(c.type)) {
        try {
          JSON.parse(value);
        } catch {
          throw fail("Invalid JSON");
        }
      }
      if (c.options.length && !c.options.includes(value))
        throw fail("Invalid enum option");
    }
    return [c, value];
  });
}
function keyWhere(s, key, params) {
  const keys = s.columns.filter((c) => c.pk);
  if (!keys.length) throw fail("This table has no primary key");
  if (
    !key ||
    typeof key !== "object" ||
    Array.isArray(key) ||
    Object.keys(key).length !== keys.length
  )
    throw fail("Complete primary key required");
  return keys
    .map((c) => {
      if (!Object.hasOwn(key, c.name) || typeof key[c.name] !== "string")
        throw fail("Invalid primary key");
      params.push(key[c.name]);
      return `${qi(c.name)}=$${params.length}`;
    })
    .join(" AND ");
}
async function mutate(s, action, body) {
  if (!s.permissions[action])
    throw fail("Database account does not have permission", 403);
  const params = [];
  let sql;
  if (action === "insert") {
    const entries = values(s, body.values, false);
    for (const c of s.columns)
      if (
        !c.readonly &&
        !c.nullable &&
        !c.default &&
        !entries.some(([v]) => v.name === c.name)
      )
        throw fail("Missing required field");
    params.push(...entries.map(([, v]) => v));
    sql = `INSERT INTO ${tableSQL(s)} ${entries.length ? `(${entries.map(([c]) => qi(c.name)).join(",")}) VALUES (${params.map((_, i) => "$" + (i + 1)).join(",")})` : "DEFAULT VALUES"}`;
  } else if (action === "update") {
    const entries = values(s, body.values, true);
    if (!entries.length) throw fail("No changes to save");
    params.push(...entries.map(([, v]) => v));
    sql = `UPDATE ${tableSQL(s)} SET ${entries.map(([c], i) => `${qi(c.name)}=$${i + 1}`).join(",")} WHERE ${keyWhere(s, body.key, params)}`;
  } else if (action === "delete") {
    if (body.confirm !== true) throw fail("Delete confirmation required");
    sql = `DELETE FROM ${tableSQL(s)} WHERE ${keyWhere(s, body.key, params)}`;
  } else throw fail("Invalid action");
  const result = await pool.query(sql, params);
  if (action !== "insert" && result.rowCount === 0)
    throw fail("Row no longer exists. Refresh the table.", 409);
  return { affected: result.rowCount };
}

async function fastCount(s) {
  const { rows } = await pool.query(
    `SELECT count(*)::text AS count FROM ${tableSQL(s)}`
  );
  return { count: Number(rows[0]?.count || 0) };
}

async function bulkDelete(s, keys) {
  if (!s.permissions.delete)
    throw fail("Database account does not have delete permission", 403);
  if (!Array.isArray(keys) || keys.length === 0)
    throw fail("No rows specified for deletion");
  if (keys.length > 500)
    throw fail("Maximum 500 rows can be deleted in a single batch");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let affected = 0;
    for (const k of keys) {
      const params = [];
      const where = keyWhere(s, k, params);
      const res = await client.query(`DELETE FROM ${tableSQL(s)} WHERE ${where}`, params);
      affected += res.rowCount;
    }
    await client.query("COMMIT");
    return { affected };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function cloneRow(s, sourceKey) {
  if (!s.permissions.insert)
    throw fail("Database account does not have insert permission", 403);
  const params = [];
  const where = keyWhere(s, sourceKey, params);
  const { rows } = await pool.query(`SELECT * FROM ${tableSQL(s)} WHERE ${where} LIMIT 1`, params);
  if (!rows.length) throw fail("Source row not found", 404);
  const source = rows[0];

  const insertCols = s.columns.filter(
    (c) => !c.pk && !c.identity && !c.generated && !c.readonly
  );

  let sql;
  let insertParams = [];
  if (insertCols.length > 0) {
    const colNames = insertCols.map((c) => qi(c.name)).join(", ");
    insertParams = insertCols.map((c) => source[c.name]);
    const placeholders = insertParams.map((_, i) => `$${i + 1}`).join(", ");
    sql = `INSERT INTO ${tableSQL(s)} (${colNames}) VALUES (${placeholders}) RETURNING *`;
  } else {
    sql = `INSERT INTO ${tableSQL(s)} DEFAULT VALUES RETURNING *`;
  }

  const result = await pool.query(sql, insertParams);
  return { affected: result.rowCount, row: result.rows[0] };
}

function escapeCsvValue(val) {
  if (val === null || val === undefined) return "";
  const str = typeof val === "object" ? JSON.stringify(val) : String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return '"' + str.replaceAll('"', '""') + '"';
  }
  return str;
}

async function exportData(s, { format = "csv", keys, column: col, op, value, sort, direction } = {}) {
  let rows;
  if (Array.isArray(keys) && keys.length > 0) {
    const client = await pool.connect();
    try {
      rows = [];
      for (const k of keys.slice(0, 5000)) {
        const params = [];
        const where = keyWhere(s, k, params);
        const res = await client.query(`SELECT ${projection(s)} FROM ${tableSQL(s)} WHERE ${where}`, params);
        if (res.rows[0]) rows.push(res.rows[0]);
      }
    } finally {
      client.release();
    }
  } else {
    const params = [];
    let where = "";
    if (col) {
      const c = column(s, col);
      const filterOp = op || "contains";
      if (filterOp === "null") where = ` WHERE ${qi(c.name)} IS NULL`;
      else if (filterOp === "notnull") where = ` WHERE ${qi(c.name)} IS NOT NULL`;
      else if (["contains", "eq", "neq", "gt", "gte", "lt", "lte"].includes(filterOp)) {
        if (filterOp === "contains") {
          params.push(`%${value.replace(/[\\%_]/g, "\\$&")}%`);
          where = ` WHERE ${qi(c.name)}::text ILIKE $1`;
        } else {
          params.push(value);
          const opSymbol = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" }[filterOp];
          where = ` WHERE ${qi(c.name)}::text ${opSymbol} $1`;
        }
      }
    }
    const order = [];
    if (sort) {
      const c = column(s, sort);
      const cast = ["json", "geometry", "geography", "raster"].includes(c.type) ? "::text" : "";
      order.push(`data.${qi(c.name)}${cast} ${direction === "desc" ? "DESC" : "ASC"}`);
    }
    for (const c of s.columns.filter((c) => c.pk && c.name !== sort))
      order.push(`data.${qi(c.name)} ASC`);

    const sql = `SELECT ${projection(s)} FROM ${tableSQL(s)} AS data${where}${order.length ? " ORDER BY " + order.join(",") : ""} LIMIT 10000`;
    const res = await pool.query(sql, params);
    rows = res.rows;
  }

  if (format === "json") {
    return {
      contentType: "application/json",
      filename: `${s.name}_export.json`,
      content: JSON.stringify(rows, null, 2),
    };
  }

  const activeCols = s.columns.map((c) => c.name);
  const header = activeCols.map(escapeCsvValue).join(",");
  const csvLines = [header];
  for (const row of rows) {
    csvLines.push(activeCols.map((colName) => escapeCsvValue(row[colName])).join(","));
  }

  return {
    contentType: "text/csv; charset=utf-8",
    filename: `${s.name}_export.csv`,
    content: csvLines.join("\r\n"),
  };
}

module.exports = {
  list,
  mutate,
  pageQuery,
  values,
  keyWhere,
  column,
  tableSQL,
  fastCount,
  bulkDelete,
  cloneRow,
  exportData,
};
