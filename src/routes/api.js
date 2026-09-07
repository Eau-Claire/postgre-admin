const router = require("express").Router();
const { tables, schema, fail } = require("../schema");
const { list, mutate, column, tableSQL } = require("../rows");
const { pool, qi } = require("../db");
const audit = require("../utils/audit");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
router.use((req, res, next) =>
  req.session.user
    ? next()
    : res.status(401).json({ error: "Session expired. Please sign in again." }),
);
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
router.get(
  "/tables",
  wrap(async (req, res) =>
    res.json({ tables: await tables(), csrf: req.session.csrf }),
  ),
);
router.get(
  "/tables/:table",
  wrap(async (req, res) => res.json(await schema(req.params.table))),
);
router.get(
  "/tables/:table/rows",
  wrap(async (req, res) =>
    res.json(await list(await schema(req.params.table), req.query)),
  ),
);
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
