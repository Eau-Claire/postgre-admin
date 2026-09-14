const { pool } = require("./db");
const audit = require("./utils/audit");

const FORBIDDEN_PATTERN = /\b(DROP\s+DATABASE|ALTER\s+SYSTEM)\b/i;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

async function execute(sqlText, { user, timeout = 30000 } = {}) {
  if (typeof sqlText !== "string" || !sqlText.trim()) {
    throw fail("SQL query cannot be empty");
  }

  // Block dangerous system-level commands
  if (FORBIDDEN_PATTERN.test(sqlText)) {
    throw fail("System-level administrative command is not permitted", 403);
  }

  const queryTimeout = Math.min(Math.max(1000, Number(timeout) || 30000), 120000);
  const client = await pool.connect();

  try {
    await client.query(`SET statement_timeout = ${queryTimeout}`);
    const startTime = Date.now();
    const result = await client.query(sqlText);
    const durationMs = Date.now() - startTime;

    // pg client returns an array of results when multiple semicolon-separated statements are run
    const results = Array.isArray(result) ? result : [result];
    const formatted = results.map((res) => ({
      command: res.command || "QUERY",
      rowCount: res.rowCount ?? 0,
      fields: (res.fields || []).map((f) => ({
        name: f.name,
        dataTypeID: f.dataTypeID,
      })),
      rows: res.rows || [],
    }));

    const totalAffected = results.reduce((acc, r) => acc + (r.rowCount || 0), 0);
    if (user) {
      audit(user, "sql", "raw_query", totalAffected);
    }

    return {
      success: true,
      durationMs,
      multiple: results.length > 1,
      results: formatted,
      // For single query convenience:
      command: formatted[formatted.length - 1].command,
      rowCount: formatted[formatted.length - 1].rowCount,
      fields: formatted[formatted.length - 1].fields,
      rows: formatted[formatted.length - 1].rows,
    };
  } catch (err) {
    // Sanitize and provide helpful error details for SQL Editor
    const errObj = {
      message: err.message || "Query execution failed",
      position: err.position ? Number(err.position) : undefined,
      hint: err.hint || undefined,
      detail: err.detail || undefined,
      code: err.code || undefined,
    };
    const error = fail(errObj.message, 400);
    error.sqlDetails = errObj;
    throw error;
  } finally {
    try {
      await client.query("RESET statement_timeout");
    } catch {
      // Ignore reset error
    }
    client.release();
  }
}

module.exports = { execute };
