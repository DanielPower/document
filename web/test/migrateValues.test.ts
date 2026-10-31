import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateComponentValues } from "../src/migrateValues.ts";

const field = (key: string, type: string, options = {}) => ({ key, label: key, type, description: "", required: false, options }) as never;
const def = (key: string, fields: unknown[]) => ({ key, name: key, description: "", aiHint: "", fields }) as never;
const use = (values: Record<string, unknown>) => [{ component: "service_account", values }] as never;

test("renaming a field keeps its value", () => {
  const before = def("service_account", [field("provider", "text"), field("annual_amount", "money")]);
  const after = def("service_account", [field("provider", "text"), field("amount", "money")]);
  assert.deepEqual(migrateComponentValues(before, after, use({ provider: "Telus", annual_amount: 95.2 })), [
    { component: "service_account", values: { provider: "Telus", amount: 95.2 } },
  ]);
});

test("adding a select field and reordering keep existing values", () => {
  const before = def("service_account", [field("provider", "text"), field("amount", "money")]);
  const added = def("service_account", [field("provider", "text"), field("amount", "money"), field("frequency", "select", { choices: ["Monthly", "Yearly"] })]);
  const reordered = def("service_account", [field("amount", "money"), field("provider", "text"), field("frequency", "select", { choices: ["Monthly", "Yearly"] })]);
  const step1 = migrateComponentValues(before, added, use({ provider: "Telus", amount: 95.2 }));
  const step2 = migrateComponentValues(added, reordered, step1);
  assert.deepEqual(step2[0].values, { amount: 95.2, provider: "Telus" });
});

test("removing a field drops only its value", () => {
  const before = def("c", [field("a", "text"), field("b", "text"), field("c", "text")]);
  const after = def("c", [field("a", "text"), field("c", "text")]);
  assert.deepEqual(migrateComponentValues(before, after, [{ component: "c", values: { a: "1", b: "2", c: "3" } }] as never)[0].values, { a: "1", c: "3" });
});

test("changing a field's type converts the value when it can", () => {
  const before = def("c", [field("x", "text")]);
  assert.deepEqual(migrateComponentValues(before, def("c", [field("x", "number")]), [{ component: "c", values: { x: "$1,284.00" } }] as never)[0].values, { x: 1284 });
  assert.deepEqual(migrateComponentValues(before, def("c", [field("x", "number")]), [{ component: "c", values: { x: "monthly" } }] as never)[0].values, {});
  assert.deepEqual(migrateComponentValues(def("c", [field("x", "money")]), def("c", [field("x", "text")]), [{ component: "c", values: { x: 12.5 } }] as never)[0].values, { x: "12.5" });
  assert.deepEqual(migrateComponentValues(before, def("c", [field("x", "select", { choices: ["Monthly", "Yearly"] })]), [{ component: "c", values: { x: "monthly" } }] as never)[0].values, { x: "Monthly" });
});

test("renaming the component key updates its uses and leaves other components alone", () => {
  const out = migrateComponentValues(def("svc", [field("a", "text")]), def("service", [field("a", "text")]), [
    { component: "svc", values: { a: "1" } },
    { component: "invoice", values: { vendor: "x" } },
  ] as never);
  assert.deepEqual(out, [{ component: "service", values: { a: "1" } }, { component: "invoice", values: { vendor: "x" } }]);
});
