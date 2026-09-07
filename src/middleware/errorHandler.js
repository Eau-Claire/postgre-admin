const { sendLogin } = require("../views/login");
module.exports = (err, req, res, next) => {
  const messages = {
    23505: "A unique value already exists.",
    23503: "A foreign-key relationship prevents this change.",
    23502: "A required field is missing.",
    23514: "A database check constraint rejected this change.",
    "22P02": "A field has an invalid value or format.",
    22007: "Invalid date or timestamp.",
    22008: "Date or timestamp is out of range.",
    22003: "A number is out of range.",
    42501: "The database account does not have permission.",
    57014: "Query timed out. Narrow the filter and retry.",
  };
  const trusted =
    Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
  console.error(
    JSON.stringify({
      event: "request_failed",
      code: /^[A-Z0-9]{5}$/.test(err.code || "") ? err.code : "INTERNAL",
      timestamp: new Date().toISOString(),
    }),
  );
  if (res.headersSent) return next(err);
  if (req.path === "/login") return sendLogin(req, res, 503, "unavailable");
  res
    .status(trusted ? err.status : messages[err.code] ? 400 : 500)
    .json({
      error: trusted
        ? err.message
        : messages[err.code] ||
          "Request failed. Please retry or contact the administrator.",
    });
};
