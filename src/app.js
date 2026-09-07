require("dotenv").config();
const path = require("node:path"),
  crypto = require("node:crypto");
const express = require("express"),
  session = require("express-session"),
  bcrypt = require("bcryptjs"),
  helmet = require("helmet"),
  rateLimit = require("express-rate-limit");
const { pool } = require("./db");
const pgSession = require("connect-pg-simple")(session);
function createApp() {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  const app = express();
  if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
  app.use(helmet());
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
  app.use(
    session({
      store: new pgSession({
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
    )
      return res
        .status(403)
        .json({ error: "Security token expired. Refresh the page." });
    next();
  });
  app.get("/login", (req, res) =>
    res
      .type("html")
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · UAV PMS</title><link rel="stylesheet" href="/assets/style.css"></head><body class="login"><form method="post" action="/login" class="login-card"><div class="brand">UAV <span>PMS</span></div><h1>Database workspace</h1><p class="muted">Sign in to manage your team’s data.</p><input type="hidden" name="_csrf" value="${req.session.csrf}"><label>Username<input name="username" autocomplete="username" required autofocus></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button class="primary">Sign in →</button>${req.query.failed ? '<p role="alert">Sign in failed. Check your credentials.</p>' : ""}<p class="muted">Internal access · Restricted database account</p></form></body></html>`,
      ),
  );
  app.post(
    "/login",
    rateLimit({
      windowMs: 15 * 60e3,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    async (req, res, next) => {
      try {
        const ok =
          typeof req.body.password === "string" &&
          req.body.username === process.env.ADMIN_USERNAME &&
          process.env.ADMIN_PASSWORD_HASH &&
          (await bcrypt.compare(
            req.body.password,
            process.env.ADMIN_PASSWORD_HASH,
          ));
        if (!ok) return res.redirect("/login?failed=1");
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
  app.use(require("./middleware/errorHandler"));
  return app;
}
if (require.main === module)
  createApp().listen(process.env.PORT || 3000, "0.0.0.0", () =>
    console.log("UAV PMS DB admin listening"),
  );
module.exports = { createApp };
