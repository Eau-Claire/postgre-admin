const router = require("express").Router();
const { tables, schema, fail } = require("../schema");
const { list, mutate, column, tableSQL, fastCount, bulkDelete, cloneRow, exportData } = require("../rows");
const { pool, qi } = require("../db");
const audit = require("../utils/audit");
const sqlExecutor = require("../sql");

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);

router.use((req, res, next) =>
  req.session.user
    ? next()
    : res.status(401).json({ error: "Session expired. Please sign in again." }),
);

// Schema explorer
router.get(
  "/schema",
  wrap(async (req, res) =>
    res.json(await require("../schema-explorer").overview()),
  ),
);
router.get(
  "/tables/:table/definition",
  wrap(async (req, res) =>
    res.json(await require("../schema-explorer").definition(req.params.table)),
  ),
);

// Tables list
router.get(
  "/tables",
  wrap(async (req, res) =>
    res.json({ tables: await tables(), csrf: req.session.csrf }),
  ),
);

// Table row count
router.get(
  "/tables/:table/count",
  wrap(async (req, res) => {
    const s = await schema(req.params.table);
    res.json(await fastCount(s));
  }),
);

// Table schema
router.get(
  "/tables/:table",
  wrap(async (req, res) => res.json(await schema(req.params.table))),
);

// Table rows list
router.get(
  "/tables/:table/rows",
  wrap(async (req, res) =>
    res.json(await list(await schema(req.params.table), req.query)),
  ),
);

// Export rows (CSV or JSON)
const handleExport = async (req, res) => {
  const s = await schema(req.params.table);
  const options = {
    format: req.query.format || req.body.format || "csv",
    keys: req.body.keys,
    column: req.query.column || req.body.column,
    op: req.query.op || req.body.op,
    value: req.query.value || req.body.value,
    sort: req.query.sort || req.body.sort,
    direction: req.query.direction || req.body.direction,
  };
  const exp = await exportData(s, options);
  res.setHeader("Content-Type", exp.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${exp.filename}"`);
  res.send(exp.content);
};
router.get("/tables/:table/export", wrap(handleExport));
router.post("/tables/:table/export", wrap(handleExport));

// Bulk delete rows
const handleBulkDelete = async (req, res) => {
  const s = await schema(req.params.table);
  const result = await bulkDelete(s, req.body.keys);
  audit(req.session.user, "bulk_delete", req.params.table, result.affected);
  res.json(result);
};
router.post("/tables/:table/rows/bulk-delete", wrap(handleBulkDelete));
router.delete("/tables/:table/rows/bulk", wrap(handleBulkDelete));

// Clone row
router.post(
  "/tables/:table/rows/clone",
  wrap(async (req, res) => {
    const s = await schema(req.params.table);
    const result = await cloneRow(s, req.body.key);
    audit(req.session.user, "clone", req.params.table, result.affected);
    res.json(result);
  }),
);

// Foreign key references lookup
router.get(
  "/tables/:table/references/:column",
  wrap(async (req, res) => {
    const source = await schema(req.params.table),
      c = column(source, req.params.column),
      fk = c.fk;
    if (!fk || fk.width !== 1 || fk.schema !== "public")
      throw fail("Reference lookup unavailable");
    const target = await schema(fk.table),
      key = column(target, fk.target);
    const label =
      target.columns.find(
        (c) =>
          /^(name|title|code|displayname)$/i.test(c.name) &&
          ["text", "varchar", "bpchar"].includes(c.type),
      ) || key;
    const search = req.query.q || "";
    if (typeof search !== "string" || search.length > 200)
      throw fail("Invalid search");
    const { rows } = await pool.query(
      `SELECT ${qi(key.name)}::text AS value, ${qi(label.name)}::text AS label FROM ${tableSQL(target)} WHERE ${qi(key.name)}::text ILIKE $1 OR ${qi(label.name)}::text ILIKE $1 ORDER BY ${qi(key.name)} LIMIT $2`,
      [`%${search.replace(/[\\%_]/g, "\\$&")}%`, 30],
    );
    res.json({ options: rows });
  }),
);

// Raw SQL execution
router.post(
  "/sql",
  wrap(async (req, res) => {
    const result = await sqlExecutor.execute(req.body.sql, {
      user: req.session.user,
      timeout: req.body.timeout,
    });
    res.json(result);
  }),
);

// Standard single row CRUD mutations
for (const [method, action] of [
  ["post", "insert"],
  ["patch", "update"],
  ["delete", "delete"],
])
  router[method](
    "/tables/:table/rows",
    wrap(async (req, res) => {
      const result = await mutate(
        await schema(req.params.table),
        action,
        req.body,
      );
      audit(req.session.user, action, req.params.table, result.affected);
      res.json(result);
    }),
  );

module.exports = router;
