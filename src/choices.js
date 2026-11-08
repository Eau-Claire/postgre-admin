const { pool, qi } = require("./db");
const { schema } = require("./schema");

// Small referenced tables (lookup/status tables) are offered as a plain dropdown.
const MAX_CHOICES = 50;
const TEXT_TYPES = ["text", "varchar", "bpchar"];

// Best human-readable column: exact Name/Title/… first, then CategoryName,
// TowerCode, Email and similar suffixes.
const LABEL_PATTERNS = [
  /^(name|title|displayname|fullname|label)$/i,
  /^code$/i,
  /name$/i,
  /(title|code)$/i,
  /^email$/i,
  /^(key|description)$/i,
];
function labelColumn(target, key) {
  const text = target.columns.filter((c) => TEXT_TYPES.includes(c.type) && c.name !== key.name);
  for (const re of LABEL_PATTERNS) {
    const hit = text.find((c) => re.test(c.name));
    if (hit) return hit;
  }
  return key;
}

function tableSQL(meta) {
  return `${qi("public")}.${qi(meta.name)}`;
}

async function referenceChoices(meta) {
  for (const c of meta.columns) {
    const fk = c.fk;
    if (!fk || fk.width !== 1 || fk.schema !== "public") continue;
    try {
      const target = await schema(fk.table);
      const key = target.columns.find((t) => t.name === fk.target);
      if (!key) continue;
      const label = labelColumn(target, key);
      const { rows } = await pool.query(
        `SELECT ${qi(key.name)}::text AS value, ${qi(label.name)}::text AS label FROM ${tableSQL(target)} ORDER BY 2, 1 LIMIT $1`,
        [MAX_CHOICES + 1],
      );
      if (rows.length && rows.length <= MAX_CHOICES) c.choices = rows;
    } catch {
      // Inaccessible target: the searchable picker remains available.
    }
  }
  return meta;
}

module.exports = { referenceChoices, labelColumn, MAX_CHOICES };
