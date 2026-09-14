const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fastCount, bulkDelete, cloneRow, exportData } = require("../src/rows");
const sqlExecutor = require("../src/sql");
const { pool } = require("../src/db");

const schema = {
  name: "Users",
  permissions: { insert: true, update: true, delete: true },
  columns: [
    { name: "Id", type: "uuid", pk: true, nullable: false },
    { name: "Email", type: "text", pk: false, nullable: false },
    { name: "Role", type: "text", pk: false, nullable: true },
  ],
};

test("sql executor blocks dangerous system commands", async () => {
  await assert.rejects(
    sqlExecutor.execute("DROP DATABASE postgres"),
    /System-level/
  );
  await assert.rejects(
    sqlExecutor.execute("ALTER SYSTEM SET max_connections = 100"),
    /System-level/
  );
  await assert.rejects(
    sqlExecutor.execute(""),
    /cannot be empty/
  );
});

test("bulkDelete requires delete permissions and handles empty keys", async () => {
  await assert.rejects(
    bulkDelete({ ...schema, permissions: { delete: false } }, [{ Id: "1" }]),
    /permission/
  );
  await assert.rejects(
    bulkDelete(schema, []),
    /No rows specified/
  );
});

test("cloneRow requires insert permissions and copies non-pk fields", async () => {
  await assert.rejects(
    cloneRow({ ...schema, permissions: { insert: false } }, { Id: "1" }),
    /permission/
  );
});

test("exportData formats rows as CSV and JSON", async () => {
  const oldQuery = pool.query;
  try {
    pool.query = async () => ({
      rows: [
        { Id: "u1", Email: "test@example.com", Role: "Admin" },
        { Id: "u2", Email: "commas, and \"quotes\"", Role: "User" },
      ],
    });

    const csvResult = await exportData(schema, { format: "csv" });
    assert.equal(csvResult.contentType, "text/csv; charset=utf-8");
    assert.match(csvResult.content, /Id,Email,Role/);
    assert.match(csvResult.content, /"commas, and ""quotes"""/);

    const jsonResult = await exportData(schema, { format: "json" });
    assert.equal(jsonResult.contentType, "application/json");
    const parsed = JSON.parse(jsonResult.content);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].Email, "test@example.com");
  } finally {
    pool.query = oldQuery;
  }
});
