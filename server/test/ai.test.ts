import assert from "node:assert/strict";
import { test } from "node:test";
import type { Analysis } from "../src/services/ai.ts";
import type { ComponentDef } from "../src/shared/types.ts";

// ai.ts loads config, which needs a database URL; nothing here connects.
process.env.DATABASE_URL ??= "postgres://localhost/unused";
const { toDraft } = await import("../src/services/ai.ts");

const MAZDA = "11111111-1111-4111-8111-111111111111";
const HOUSE = "22222222-2222-4222-8222-222222222222";

function def(key: string, name: string, fields: Array<Pick<ComponentDef["fields"][number], "key" | "type">>): ComponentDef {
  return {
    id: key, key, name, description: "", aiHint: "", color: null,
    fields: fields.map((f, i) => ({ id: f.key, label: f.key, description: "", required: false, options: {}, position: i, ...f })),
  } as unknown as ComponentDef;
}

const catalog = new Map(
  [
    def("asset_link", "Related asset", [{ key: "asset", type: "ref" }]),
    def("vehicle_registration", "Vehicle registration", [{ key: "vehicle", type: "ref" }, { key: "expiry", type: "date" }]),
    def("invoice", "Invoice", [{ key: "total", type: "money" }]),
  ].map((c) => [c.key, c]),
);

const analysis = (components: Analysis["components"]): Analysis => ({
  title: "Registration renewal",
  document_date: "2025-03-01",
  components,
  new_components: [],
  new_objects: [],
  existing_object_updates: [],
  reasoning: "",
});

const keys = (a: Analysis) => toDraft(a, catalog, new Set([MAZDA, HOUSE])).draft.components.map((c) => c.component);

test("drops Related asset when another component already links the same object", () => {
  const a = analysis([
    { component: "vehicle_registration", values: [{ field: "vehicle", value: MAZDA }, { field: "expiry", value: "2026-03-01" }] },
    { component: "asset_link", values: [{ field: "asset", value: MAZDA }] },
  ]);
  assert.deepEqual(keys(a), ["vehicle_registration"]);
  assert.match(toDraft(a, catalog, new Set([MAZDA])).warnings.join(" "), /Left out Related asset/);
});

test("keeps Related asset for an object nothing else links", () => {
  assert.deepEqual(
    keys(analysis([
      { component: "vehicle_registration", values: [{ field: "vehicle", value: MAZDA }] },
      { component: "asset_link", values: [{ field: "asset", value: HOUSE }] },
    ])),
    ["vehicle_registration", "asset_link"],
  );
  assert.deepEqual(
    keys(analysis([
      { component: "invoice", values: [{ field: "total", value: "120" }] },
      { component: "asset_link", values: [{ field: "asset", value: MAZDA }] },
    ])),
    ["invoice", "asset_link"],
  );
});

test("keeps one of two identical Related asset links", () => {
  assert.deepEqual(
    keys(analysis([
      { component: "asset_link", values: [{ field: "asset", value: MAZDA }] },
      { component: "asset_link", values: [{ field: "asset", value: MAZDA }] },
    ])),
    ["asset_link"],
  );
});
