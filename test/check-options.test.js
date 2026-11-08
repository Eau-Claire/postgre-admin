const { test } = require("node:test");
const assert = require("node:assert/strict");
const { checkOptions } = require("../src/schema");

test("check constraint IN-lists become dropdown options", () => {
  assert.deepEqual(
    checkOptions(
      `CHECK ((("ValidationStatus")::text = ANY ((ARRAY['Pending'::character varying, 'InReview'::character varying, 'Confirmed'::character varying, 'Rejected'::character varying])::text[])))`,
    ),
    ["Pending", "InReview", "Confirmed", "Rejected"],
  );
  assert.deepEqual(
    checkOptions(`CHECK (("Status" IS NULL) OR ("Status" = ANY (ARRAY['A'::text, 'it''s'::text])))`),
    ["A", "it's"],
  );
});

test("complex or non-list check constraints are ignored", () => {
  assert.deepEqual(checkOptions(`CHECK (("Confidence" >= (0)::double precision))`), []);
  assert.deepEqual(
    checkOptions(`CHECK ((("Status")::text <> ALL ((ARRAY['X'::character varying])::text[])))`),
    [],
  );
  assert.deepEqual(
    checkOptions(`CHECK ((("ValidationStatus")::text <> 'Confirmed'::text) OR ("TowerId" IS NOT NULL))`),
    [],
  );
  assert.deepEqual(checkOptions(null), []);
});
