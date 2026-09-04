module.exports = (admin, action, table, primaryKey) => console.log(JSON.stringify({ admin, action, table, primaryKey, timestamp: new Date().toISOString() }));
