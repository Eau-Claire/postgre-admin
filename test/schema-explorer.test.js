const { test } = require("node:test");
const assert = require("node:assert/strict");
const { tableDefinition } = require("../src/schema-explorer");
test("definition preserves quoted identifiers, default/identity/generated fields and composite constraints", () => {
  const sql = tableDefinition(
    {
      name: 'Odd"Table',
      columns: [
        {
          name: "Id",
          description: "bigint",
          identity: true,
          nullable: false,
          default: null,
        },
        {
          name: "Label",
          description: "text",
          nullable: true,
          default: "'example'::text",
        },
        {
          name: "Computed",
          description: "text",
          nullable: true,
          generated: true,
          default: 'upper("Label")',
        },
      ],
    },
    [{ name: "Id", identity: "a" }],
    [{ name: 'Composite"key', definition: 'PRIMARY KEY ("Id", "Label")' }],
  );
  assert.match(sql, /"Odd""Table"/);
  assert.match(sql, /GENERATED ALWAYS AS IDENTITY NOT NULL/);
  assert.match(sql, /DEFAULT 'example'::text/);
  assert.match(sql, /GENERATED ALWAYS AS \(upper\("Label"\)\) STORED/);
  assert.match(sql, /CONSTRAINT "Composite""key" PRIMARY KEY/);
  assert.match(sql, /not a complete migration/);
});
