// Never include row values, keys, request bodies or database error details.
module.exports = (admin, action, table, affected) =>
  console.log(
    JSON.stringify({
      admin,
      action,
      table,
      affected,
      timestamp: new Date().toISOString(),
    }),
  );
