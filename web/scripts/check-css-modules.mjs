#!/usr/bin/env node
// Guards the CSS Modules setup (run by `npm run typecheck`):
//  1. src/global.css has no class selectors, so global classes can't collide.
//  2. Every `styles.foo` used in a component exists in the imported module.
//     CSS Modules turn a typo into a silent `undefined`; this makes it an error.
//  3. Classes defined in a module but never used are reported (warning only).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const errors = [];
const warnings = [];

/** Class names a stylesheet defines (ignores numbers like .5 and comments). */
function classesIn(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return new Set([...noComments.matchAll(/(?<![\w-])\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]));
}

const globalCss = fs.readFileSync(path.join(src, "global.css"), "utf8");
for (const name of classesIn(globalCss)) {
  errors.push(`global.css: class selector .${name} (put it in ui.module.css or a component's module)`);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

const used = new Map(); // module path -> Set of used class names
for (const file of walk(src).filter((f) => /\.tsx?$/.test(f))) {
  const code = fs.readFileSync(file, "utf8");
  const rel = path.relative(src, file);
  for (const m of code.matchAll(/import\s+(\w+)\s+from\s+["']([^"']+\.module\.css)["']/g)) {
    const [, ident, spec] = m;
    const modPath = path.resolve(path.dirname(file), spec);
    const defined = classesIn(fs.readFileSync(modPath, "utf8"));
    const set = used.get(modPath) ?? new Set();
    used.set(modPath, set);
    // Import paths like "../ui.module.css" aren't references.
    const body = code.replace(/^import .*$/gm, "");
    const refs = [
      ...[...body.matchAll(new RegExp(`\\b${ident}\\.(\\w+)`, "g"))].map((r) => r[1]),
      ...[...body.matchAll(new RegExp(`\\b${ident}\\[["'\`]([\\w-]+)["'\`]\\]`, "g"))].map((r) => r[1]),
    ];
    for (const name of refs) {
      set.add(name);
      if (!defined.has(name)) errors.push(`${rel}: ${ident}.${name} is not defined in ${path.relative(src, modPath)}`);
    }
    // Dynamic lookups like styles[`status_${x}`] can't be checked statically.
    if (new RegExp(`\\b${ident}\\[(?!["'\`][\\w-]+["'\`]\\])`).test(code)) {
      warnings.push(`${rel}: dynamic ${ident}[...] lookup isn't checked`);
    }
  }
  // Class names must come from modules: no string literals, and no bare words
  // inside template strings (className={`card ${x}`}).
  for (const m of code.matchAll(/className="([^"]+)"/g)) errors.push(`${rel}: literal className="${m[1]}" (use a module class)`);
  for (const m of code.matchAll(/className=\{`([^`]*)`\}/g)) {
    if (/[a-z]/i.test(m[1].replace(/\$\{[^}]*\}/g, ""))) errors.push(`${rel}: className={\`${m[1]}\`} has a literal class (use a module class)`);
  }
}

for (const file of walk(src).filter((f) => f.endsWith(".module.css"))) {
  const defined = classesIn(fs.readFileSync(file, "utf8"));
  const set = used.get(file);
  if (!set) {
    warnings.push(`${path.relative(src, file)} is never imported`);
    continue;
  }
  for (const name of defined) if (!set.has(name)) warnings.push(`${path.relative(src, file)}: .${name} is never used`);
}

for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
if (errors.length) process.exit(1);
console.log("CSS modules: ok");
