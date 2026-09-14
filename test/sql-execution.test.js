const { test } = require("node:test");
const assert = require("node:assert/strict");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { createApp } = require("../src/app");
const { pool } = require("../src/db");
const sqlExecutor = require("../src/sql");

test("SQL execution engine supports SELECT, DML, multiple statements, and error details", async () => {
  const originalConnect = pool.connect;

  // Mock pool client
  let clientQueryCalls = [];
  const mockClient = {
    query: async (sql, params) => {
      clientQueryCalls.push({ sql, params });
      if (sql.startsWith("SET statement_timeout") || sql.startsWith("RESET statement_timeout")) {
        return { rowCount: 0 };
      }
      if (sql.includes("SYNTAX ERROR")) {
        const err = new Error("syntax error at or near \"SYNTAX\"");
        err.position = "15";
        err.code = "42601";
        throw err;
      }
      if (sql.includes("SELECT")) {
        return {
          command: "SELECT",
          rowCount: 2,
          fields: [
            { name: "id", dataTypeID: 23 },
            { name: "name", dataTypeID: 25 },
          ],
          rows: [
            { id: 1, name: "Drone A" },
            { id: 2, name: "Drone B" },
          ],
        };
      }
      if (sql.includes("UPDATE")) {
        return { command: "UPDATE", rowCount: 3, fields: [], rows: [] };
      }
      return { command: "OK", rowCount: 1, fields: [], rows: [] };
    },
    release: () => {},
  };

  pool.connect = async () => mockClient;

  try {
    // 1. SELECT query
    const selectRes = await sqlExecutor.execute("SELECT id, name FROM drones;", { user: "admin" });
    assert.equal(selectRes.success, true);
    assert.equal(selectRes.command, "SELECT");
    assert.equal(selectRes.rowCount, 2);
    assert.equal(selectRes.rows.length, 2);
    assert.equal(selectRes.fields[0].name, "id");
    assert.equal(selectRes.rows[0].name, "Drone A");
    assert.ok(typeof selectRes.durationMs === "number");

    // 2. DML query (UPDATE)
    const updateRes = await sqlExecutor.execute("UPDATE drones SET status = 'active' WHERE active = false;", { user: "admin" });
    assert.equal(updateRes.success, true);
    assert.equal(updateRes.command, "UPDATE");
    assert.equal(updateRes.rowCount, 3);
    assert.equal(updateRes.rows.length, 0);

    // 3. Syntax error provides helpful message and details
    await assert.rejects(
      sqlExecutor.execute("SELECT * FROM SYNTAX ERROR;", { user: "admin" }),
      (err) => {
        assert.match(err.message, /syntax error/i);
        assert.equal(err.status, 400);
        return true;
      }
    );

    // 4. Multiple statements
    mockClient.query = async (sql) => {
      if (sql.startsWith("SET") || sql.startsWith("RESET")) return {};
      return [
        { command: "INSERT", rowCount: 1, fields: [], rows: [] },
        { command: "SELECT", rowCount: 1, fields: [{ name: "count" }], rows: [{ count: "10" }] },
      ];
    };
    const multiRes = await sqlExecutor.execute("INSERT INTO logs VALUES (1); SELECT count(*) FROM logs;", { user: "admin" });
    assert.equal(multiRes.success, true);
    assert.equal(multiRes.multiple, true);
    assert.equal(multiRes.results.length, 2);
    assert.equal(multiRes.results[0].command, "INSERT");
    assert.equal(multiRes.results[1].command, "SELECT");
  } finally {
    pool.connect = originalConnect;
  }
});
