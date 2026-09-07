const { test } = require("node:test");
const assert = require("node:assert/strict");
const { pageQuery, values, keyWhere, mutate } = require("../src/rows");
const { pool } = require("../src/db");
const c = (name, other = {}) => ({
  name,
  type: "text",
  nullable: false,
  options: [],
  ...other,
});
const schema = {
  name: 'Mixed"Table',
  permissions: { insert: true, update: true, delete: true },
  columns: [
    c("Id", { pk: true, default: "gen_random_uuid()" }),
    c("OtherId", { pk: true }),
    c("Name", { nullable: true, default: "'untitled'" }),
    c("Geom", { readonly: true, spatial: true }),
    c("Data", { type: "jsonb", nullable: true }),
    c("Generated", { readonly: true }),
  ],
};
test("pagination is bounded and values never become SQL", () => {
  const p = pageQuery(schema, {
    column: "Name",
    value: "x%' OR 1=1 --",
    sort: "Id",
    direction: "desc",
    page: "2",
    size: "25",
  });
  assert.match(p.sql, /"public"\."Mixed""Table"/);
  assert.ok(!p.sql.includes("OR 1=1"));
  assert.deepEqual(p.params, ["%x\\%' OR 1=1 --%", 26, 25]);
  assert.match(p.sql, /ORDER BY data\."Id" DESC,data\."OtherId" ASC/);
});
test("rejects unchecked names, directions, pagination and operators", () => {
  for (const q of [
    { sort: "Id; DROP TABLE x" },
    { column: "missing", value: "x" },
    { sort: "Id", direction: "desc;delete" },
    { size: 1000 },
    { page: 1.5 },
    { page: Infinity },
    { column: "Id", op: "sql" },
  ])
    assert.throws(() => pageQuery(schema, q));
});
test("validates values and prevents readonly edits", () => {
  for (const [data, editing] of [
    [{ Geom: "POINT(1 2)" }, false],
    [{ Generated: "x" }, false],
    [{ Id: "new" }, true],
    [{ OtherId: null }, false],
    [{ missing: "x" }, false],
    [{ Data: "{" }, false],
    [{ Name: {} }, false],
  ])
    assert.throws(() => values(schema, data, editing));
  assert.deepEqual(
    values(schema, { Name: null, Data: '{"a":1}' }, true).map((x) => x[1]),
    [null, '{"a":1}'],
  );
});
test("composite keys require exact complete key", () => {
  const p = [];
  assert.equal(
    keyWhere(schema, { Id: "a", OtherId: "b" }, p),
    '"Id"=$1 AND "OtherId"=$2',
  );
  assert.deepEqual(p, ["a", "b"]);
  for (const key of [
    { Id: "a" },
    { Id: "a", OtherId: "b", extra: "x" },
    { Id: null, OtherId: "b" },
  ])
    assert.throws(() => keyWhere(schema, key, []));
});
test("insert omissions, confirmations and key-safe writes", async () => {
  const old = pool.query;
  const calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rowCount: 1 };
  };
  try {
    await mutate(schema, "insert", { values: { OtherId: "b" } });
    assert.match(calls[0].sql, /\("OtherId"\) VALUES \(\$1\)/);
    assert.ok(!calls[0].sql.includes("Name"));
    await mutate(schema, "update", {
      key: { Id: "a", OtherId: "b" },
      values: { Name: "new" },
    });
    assert.deepEqual(calls[1].params, ["new", "a", "b"]);
    await assert.rejects(
      mutate(schema, "delete", { key: { Id: "a", OtherId: "b" } }),
      /confirmation/,
    );
    await mutate(schema, "delete", {
      key: { Id: "a", OtherId: "b" },
      confirm: true,
    });
    assert.match(calls[2].sql, /WHERE "Id"=\$1 AND "OtherId"=\$2/);
    await assert.rejects(
      mutate({ ...schema, permissions: { insert: false } }, "insert", {
        values: {},
      }),
      /permission/,
    );
  } finally {
    pool.query = old;
  }
});
test("database errors never leak row values into logs or responses", () => {
  const handler = require("../src/middleware/errorHandler");
  const old = console.error;
  const logs = [];
  console.error = (x) => logs.push(x);
  let payload;
  try {
    handler(
      Object.assign(new Error("secret-password"), {
        code: "23505",
        detail: "token=secret",
      }),
      {},
      {
        status() {
          return this;
        },
        json(x) {
          payload = x;
        },
      },
      () => {},
    );
    assert.ok(!JSON.stringify({ logs, payload }).includes("secret"));
    assert.match(payload.error, /unique/);
  } finally {
    console.error = old;
  }
});
