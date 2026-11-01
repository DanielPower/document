import assert from "node:assert/strict";
import { test } from "node:test";
import type { Analysis } from "../src/services/ai.ts";
import type { ComponentDef } from "../src/shared/types.ts";

// ai.ts loads config, which needs a database URL; nothing here connects.
process.env.DATABASE_URL ??= "postgres://localhost/unused";
const { toDraft, draftToAnalysis } = await import("../src/services/ai.ts");

const MAZDA = "11111111-1111-4111-8111-111111111111";
const HOUSE = "22222222-2222-4222-8222-222222222222";

function def(key: string, name: string, fields: Array<Pick<ComponentDef["fields"][number], "key" | "type"> & { required?: boolean }>): ComponentDef {
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
  component_changes: [],
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

// --- Changes to existing component definitions (Revise) ---------------------

const LOC = "33333333-3333-4333-8333-333333333333";
const loanCatalog = new Map(
  [
    def("loan", "Loan", [{ key: "lender", type: "text", required: true }, { key: "principal", type: "money", required: true }, { key: "term_months", type: "number" }]),
  ].map((c) => [c.key, c]),
);
const newField = (key: string, type: "money" | "text" = "money") => ({
  key, label: key, type, description: "", required: false, choices: [], currency: null, ref_component: null, identifier: false,
});
const loanAnalysis = (extra: Partial<Analysis>): Analysis => ({
  ...analysis([]),
  existing_object_updates: [{ object_id: LOC, components: [{ component: "loan", values: [{ field: "lender", value: "RBC" }] }] }],
  ...extra,
});

test("revising: makes a field of an existing component optional", () => {
  const a = loanAnalysis({ component_changes: [{ component: "loan", required_changes: [{ field: "principal", required: false }], add_fields: [] }] });
  const { draft, warnings } = toDraft(a, loanCatalog, new Set([LOC]), { allowComponentChanges: true });
  assert.deepEqual(draft.componentChanges, [{ component: "loan", required: { principal: false } }]);
  assert.deepEqual(warnings, []);
});

test("first pass: changes to existing components are ignored", () => {
  const a = loanAnalysis({ component_changes: [{ component: "loan", required_changes: [{ field: "principal", required: false }], add_fields: [] }] });
  const { draft, warnings } = toDraft(a, loanCatalog, new Set([LOC]));
  assert.equal(draft.componentChanges, undefined);
  assert.match(warnings.join(" "), /only made when you ask/);
});

test("revising: an existing component restated in new_components becomes a change", () => {
  const a = loanAnalysis({
    new_components: [{
      key: "loan", name: "Loan", description: "", ai_hint: "",
      fields: [{ ...newField("lender", "text"), required: true }, newField("principal"), newField("credit_limit")],
    }],
  });
  const { draft, warnings } = toDraft(a, loanCatalog, new Set([LOC]), { allowComponentChanges: true });
  assert.equal(draft.newComponents.length, 0);
  assert.deepEqual(draft.componentChanges?.[0].required, { principal: false });
  assert.deepEqual(draft.componentChanges?.[0].addFields?.map((f) => f.key), ["credit_limit"]);
  assert.deepEqual(warnings, []);
});

test("revising: a change that does nothing is dropped, unknown fields warn", () => {
  const a = loanAnalysis({
    component_changes: [{ component: "loan", required_changes: [{ field: "term_months", required: false }, { field: "nope", required: false }], add_fields: [] }],
  });
  const { draft, warnings } = toDraft(a, loanCatalog, new Set([LOC]), { allowComponentChanges: true });
  assert.equal(draft.componentChanges, undefined);
  assert.match(warnings.join(" "), /no field "nope"/);
});

test("revising: values for an added field are kept", () => {
  const a = loanAnalysis({
    existing_object_updates: [{ object_id: LOC, components: [{ component: "loan", values: [{ field: "credit_limit", value: "25000" }] }] }],
    component_changes: [{ component: "loan", required_changes: [], add_fields: [newField("credit_limit")] }],
  });
  const { draft, warnings } = toDraft(a, loanCatalog, new Set([LOC]), { allowComponentChanges: true });
  assert.deepEqual(draft.objectUpdates?.[0].components[0].values, { credit_limit: 25000 });
  assert.deepEqual(warnings, []);
});

test("component changes survive a round trip through the model's format", () => {
  const a = loanAnalysis({ component_changes: [{ component: "loan", required_changes: [{ field: "principal", required: false }], add_fields: [newField("credit_limit")] }] });
  const first = toDraft(a, loanCatalog, new Set([LOC]), { allowComponentChanges: true }).draft;
  const again = toDraft({ ...draftToAnalysis(first), reasoning: "" }, loanCatalog, new Set([LOC]), { allowComponentChanges: true }).draft;
  assert.deepEqual(again.componentChanges, first.componentChanges);
});
