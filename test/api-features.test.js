const { test } = require("node:test");
const assert = require("node:assert/strict");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { createApp } = require("../src/app");

test("HTTP API endpoints handle auth, csrf, and routing correctly", async () => {
  const original = Object.fromEntries(
    ["SESSION_SECRET", "ADMIN_USERNAME", "ADMIN_PASSWORD_HASH", "COOKIE_SECURE"].map((k) => [k, process.env[k]])
  );
  process.env.SESSION_SECRET = "test-only-secret-at-least-32-characters";
  process.env.ADMIN_USERNAME = "fixture-admin";
  process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync("fixture-password", 4);
  process.env.COOKIE_SECURE = "false";

  const server = createApp({ sessionStore: new session.MemoryStore() }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;

  try {
    // 1. Unauthenticated requests
    const unauthCount = await fetch(base + "/api/tables/Users/count");
    assert.equal(unauthCount.status, 401);

    const unauthSql = await fetch(base + "/api/sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    // Rejects with 403 (CSRF) or 401
    assert.ok([401, 403].includes(unauthSql.status));

    // 2. Unauthenticated GET /sql redirects to /login
    const unauthSqlPage = await fetch(base + "/sql", { redirect: "manual" });
    assert.equal(unauthSqlPage.status, 302);
    assert.equal(unauthSqlPage.headers.get("location"), "/login");

    // 3. Authenticate via login
    const loginPage = await fetch(base + "/login");
    const cookie = loginPage.headers.get("set-cookie").split(";")[0];
    const html = await loginPage.text();
    const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];

    const loginRes = await fetch(base + "/login", {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrf,
        username: "fixture-admin",
        password: "fixture-password",
      }),
    });
    const authCookie = loginRes.headers.get("set-cookie").split(";")[0];

    // 4. Authenticated GET /sql returns 200 and serves HTML
    const sqlPage = await fetch(base + "/sql", { headers: { Cookie: authCookie } });
    assert.equal(sqlPage.status, 200);
    const sqlPageHtml = await sqlPage.text();
    assert.match(sqlPageHtml, /SQL Editor/);
    assert.match(sqlPageHtml, /sql-input/);

    // 5. Get CSRF token from /api/tables
    const tablesRes = await fetch(base + "/api/tables", { headers: { Cookie: authCookie } });
    const tablesData = await tablesRes.json();
    const userCsrf = tablesData.csrf;

    // 6. Authenticated POST /api/sql with DROP DATABASE fails with 403
    const forbiddenSql = await fetch(base + "/api/sql", {
      method: "POST",
      headers: {
        Cookie: authCookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": userCsrf,
      },
      body: JSON.stringify({ sql: "DROP DATABASE test" }),
    });
    assert.equal(forbiddenSql.status, 403);
  } finally {
    server.close();
    Object.assign(process.env, original);
  }
});
