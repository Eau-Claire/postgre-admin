// Explicit opt-in: synthetic tables are created ONLY in the disposable local test DB.
const assert = require("node:assert/strict");
if (
  process.env.DB_PORT !== "55439" ||
  process.env.DB_NAME !== "postgres" ||
  process.env.DB_HOST !== "127.0.0.1"
)
  throw Error("Use the disposable test database on localhost:55439");
const { Client } = require("pg");
const { pool } = require("../src/db");
const { schema, tables } = require("../src/schema");
const { list, mutate } = require("../src/rows");
(async () => {
  const owner = new Client({
    host: "127.0.0.1",
    port: 55439,
    database: "postgres",
    user: "postgres",
    password: "isolated-test-only",
  });
  await owner.connect();
  let server;
  try {
    await owner
      .query(
        `DROP TABLE IF EXISTS public."FixtureRows",public."FixtureParents",public."FixtureComposite",public.session CASCADE; DROP TYPE IF EXISTS public.fixture_status; DROP OWNED BY fixture_admin; DROP ROLE fixture_admin;`,
      )
      .catch((e) => {
        if (e.code !== "42704") throw e;
      });
    await owner.query(`CREATE ROLE fixture_admin LOGIN PASSWORD 'fixture-only'; GRANT USAGE ON SCHEMA public TO fixture_admin;
CREATE TYPE public.fixture_status AS ENUM ('draft','ready');
CREATE TABLE public."FixtureParents" ("Id" bigint PRIMARY KEY, "Name" text);
INSERT INTO public."FixtureParents" VALUES (9007199254740993,'Reference label');
CREATE TABLE public."FixtureRows" ("Id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "ParentId" bigint REFERENCES public."FixtureParents"("Id"), "Name" text NOT NULL DEFAULT 'default name', "Enabled" boolean DEFAULT true, "Status" fixture_status DEFAULT 'draft', "Data" jsonb, "Amount" numeric, "At" timestamptz, "Geom" geometry, "Computed" text GENERATED ALWAYS AS ("Name" || '!') STORED);
CREATE TABLE public."FixtureComposite" ("A" text, "B" text, "Value" text, PRIMARY KEY ("A","B"));
CREATE TABLE public.session (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp NOT NULL);
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO fixture_admin; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO fixture_admin;`);
    const meta = await schema("FixtureRows");
    assert.equal(meta.columns.length, 10);
    assert.equal(
      meta.columns.find((c) => c.name === "ParentId").fk.target,
      "Id",
    );
    assert.deepEqual(meta.columns.find((c) => c.name === "Status").options, [
      "draft",
      "ready",
    ]);
    assert.equal(meta.columns.find((c) => c.name === "Geom").readonly, true);
    assert.equal(
      meta.columns.find((c) => c.name === "Computed").readonly,
      true,
    );
    assert.ok(!(await tables()).some((t) => t.name === "session"));
    await mutate(meta, "insert", {
      values: {
        ParentId: "9007199254740993",
        Amount: "12345678901234567890.123456",
        Data: "null",
        At: "2026-09-07T12:34:56.123456Z",
      },
    });
    let rows = (await list(meta, {})).rows;
    assert.equal(rows[0].Name, "default name");
    assert.equal(rows[0].ParentId, "9007199254740993");
    assert.equal(rows[0].Amount, "12345678901234567890.123456");
    assert.equal(rows[0].Data, "null");
    assert.equal(rows[0].Computed, "default name!");
    await mutate(meta, "update", {
      key: { Id: rows[0].Id },
      values: { Name: "Robert'); DROP TABLE x; --", Data: null },
    });
    rows = (
      await list(meta, { column: "Name", op: "contains", value: "DROP TABLE" })
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Data, null);
    await assert.rejects(
      mutate(meta, "update", {
        key: { Id: rows[0].Id },
        values: { Geom: "POINT(1 2)" },
      }),
    );
    await owner.query(
      `INSERT INTO public."FixtureRows" ("Name","Geom") SELECT 'row ' || i,ST_Point(1,2) FROM generate_series(1,30) i`,
    );
    const page = await list(meta, { size: 25 });
    assert.equal(page.rows.length, 25);
    assert.deepEqual(
      page.rows.slice(0, 3).map((r) => r.Id),
      ["1", "2", "3"],
    );
    assert.equal(page.hasNext, true);
    assert.equal((await list(meta, { size: 25, page: 2 })).rows.length, 6);
    assert.equal(typeof page.rows[1].Geom, "string");
    const composite = await schema("FixtureComposite");
    await mutate(composite, "insert", {
      values: { A: "a", B: "b", Value: "first" },
    });
    await mutate(composite, "insert", {
      values: { A: "a", B: "c", Value: "second" },
    });
    await mutate(composite, "update", {
      key: { A: "a", B: "b" },
      values: { Value: "changed" },
    });
    await mutate(composite, "delete", {
      key: { A: "a", B: "b" },
      confirm: true,
    });
    assert.equal((await list(composite, {})).rows[0].Value, "second");
    process.env.SESSION_SECRET =
      "test-session-secret-with-at-least-32-characters";
    process.env.ADMIN_USERNAME = "testadmin";
    process.env.ADMIN_PASSWORD_HASH = require("bcryptjs").hashSync(
      "test-login-only",
      4,
    );
    const app = require("../src/app").createApp();
    server = await new Promise((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
    const root = "http://127.0.0.1:" + server.address().port;
    let r = await fetch(root + "/health");
    assert.equal(r.status, 200);
    r = await fetch(root + "/api/tables");
    assert.equal(r.status, 401);
    r = await fetch(root + "/login");
    let cookie = r.headers.get("set-cookie").split(";")[0];
    const html = await r.text();
    let csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
    r = await fetch(root + "/login", {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        _csrf: csrf,
        username: "testadmin",
        password: "test-login-only",
      }),
    });
    assert.equal(r.status, 302);
    const oldCookie = cookie;
    cookie = r.headers.get("set-cookie").split(";")[0];
    assert.notEqual(cookie, oldCookie);
    r = await fetch(root + "/api/tables", { headers: { Cookie: cookie } });
    csrf = (await r.json()).csrf;
    r = await fetch(root + "/api/tables/FixtureRows/rows", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: '{"values":{}}',
    });
    assert.equal(r.status, 403);
    r = await fetch(
      root + "/api/tables/FixtureRows/references/ParentId?q=label",
      { headers: { Cookie: cookie } },
    );
    const refs = await r.json();
    assert.equal(refs.options[0].value, "9007199254740993");
    r = await fetch(root + "/api/tables/FixtureRows/rows", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: '{"values":{}}',
    });
    assert.equal(r.status, 200);
    r = await fetch(root + "/tables", { headers: { Cookie: cookie } });
    assert.match(r.headers.get("content-security-policy"), /script-src 'self'/);
    assert.match(await r.text(), /Table Editor/);
    console.log(
      "PASS: restricted-account metadata, types/defaults, PostGIS, FK lookup, pagination, composite CRUD, sessions, CSRF and HTTP routes",
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await owner.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
