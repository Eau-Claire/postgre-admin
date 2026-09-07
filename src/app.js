require("dotenv").config();
const path = require("node:path"),
  crypto = require("node:crypto");
const express = require("express"),
  session = require("express-session"),
  bcrypt = require("bcryptjs"),
  helmet = require("helmet"),
  rateLimit = require("express-rate-limit");
const { pool } = require("./db");
const { sendLogin } = require("./views/login");
const pgSession = require("connect-pg-simple")(session);
function createApp({ sessionStore } = {}) {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  const app = express();
  if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
  const secureCookies = process.env.COOKIE_SECURE === "true";
  const httpSecurity = helmet({
    contentSecurityPolicy: { directives: { "upgrade-insecure-requests": null } },
    strictTransportSecurity: false,
  });
  const httpsSecurity = helmet();
  // Use the actual transport (including an explicitly trusted proxy), not
  // the cookie preference, to decide whether HTTPS upgrades are appropriate.
  app.use((req, res, next) => (req.secure ? httpsSecurity : httpSecurity)(req, res, next));
  app.get("/health", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "healthy", database: "connected" });
    } catch {
      res.status(503).json({ status: "unhealthy", database: "disconnected" });
    }
  });
  app.use(
    "/assets",
    express.static(path.join(__dirname, "public"), { index: false }),
  );
  app.use(
    express.urlencoded({ extended: false, limit: "1mb" }),
    express.json({ limit: "1mb" }),
  );
  app.use((req, res, next) => {
    if (req.path === "/login" && secureCookies && !req.secure) {
      res.set("Cache-Control", "no-store");
      return sendLogin(req, res, 503, "transport");
    }
    next();
  });
  app.use(
    session({
      store: sessionStore || new pgSession({
        pool,
        schemaName: "public",
        tableName: "session",
        createTableIfMissing: false,
      }),
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.COOKIE_SECURE === "true",
        maxAge: 8 * 3600000,
      },
    }),
  );
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.session.csrf)
      req.session.csrf = crypto.randomBytes(32).toString("hex");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (req.get("X-CSRF-Token") || req.body._csrf) !== req.session.csrf
    ) {
      if (req.path === "/login") return sendLogin(req, res, 403, "expired");
      return res
        .status(403)
        .json({ error: "Security token expired. Refresh the page." });
    }
    next();
  });
  app.get("/login", (req, res) => sendLogin(req, res, 200, req.query.failed ? "credentials" : ""));
  app.post(
    "/login",
    rateLimit({
      windowMs: 15 * 60e3,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => sendLogin(req, res, 429, "limited"),
    }),
    async (req, res, next) => {
      try {
        if (typeof req.body.username !== "string" || !req.body.username.trim() || typeof req.body.password !== "string" || !req.body.password) return sendLogin(req, res, 400, "missing");
        if (!process.env.ADMIN_USERNAME || !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(process.env.ADMIN_PASSWORD_HASH || "")) return sendLogin(req, res, 503, "configuration");
        const ok =
          typeof req.body.password === "string" &&
          req.body.username === process.env.ADMIN_USERNAME &&
          process.env.ADMIN_PASSWORD_HASH &&
          (await bcrypt.compare(
            req.body.password,
            process.env.ADMIN_PASSWORD_HASH,
          ));
        if (!ok) return sendLogin(req, res, 401, "credentials");
        req.session.regenerate((err) => {
          if (err) return next(err);
          req.session.user = req.body.username;
          req.session.csrf = crypto.randomBytes(32).toString("hex");
          req.session.save((err) =>
            err ? next(err) : res.redirect("/tables"),
          );
        });
      } catch (err) {
        next(err);
      }
    },
  );
  app.post("/logout", (req, res, next) =>
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie("connect.sid");
      res.json({ ok: true });
    }),
  );
  app.use("/api", require("./routes/api"));
  app.get(
    ["/", "/tables", "/tables/:table"],
    require("./middleware/auth"),
    (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")),
  );
  app.get("/schema", require("./middleware/auth"), (req,res)=>res.sendFile(path.join(__dirname,"public","schema.html")));
  app.use(require("./middleware/errorHandler"));
  return app;
}
if (require.main === module)
  createApp().listen(process.env.PORT || 3000, "0.0.0.0", () =>
    console.log("UAV PMS DB admin listening"),
  );
module.exports = { createApp };
