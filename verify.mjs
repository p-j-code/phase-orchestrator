import { readFileSync } from "node:fs";
let pass = 0,
  fail = 0;
const ok = (l) => {
  console.log("OK", l);
  pass++;
};
const bad = (l) => {
  console.log("FAIL", l);
  fail++;
};
const H = readFileSync("src/server/telegram-handlers.js", "utf8");
const M = readFileSync("src/lib/command-menu.js", "utf8");
const S = readFileSync("src/server.js", "utf8");
const R = readFileSync("src/server/job-runner.js", "utf8");
const va = H.match(/VALID_ACTIONS\s*=\s*\[([^\]]+)\]/);
const v = va[1]
  .split(",")
  .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
  .filter(Boolean);
const cases = new Set();
let m;
const ce = new RegExp(/case\s+'([a-z]+)':/.source, "g");
let mm;
while ((mm = ce.exec(R))) cases.add(mm[1]);
v.every((a) => cases.has(a)) ? ok("dispatcher OK") : bad("dispatcher missing");
const b = H.match(/Actions for \/run:\s*([^<\n]+?)<\/i>/);
b ? ok("banner present") : bad("banner missing");
const er = /\{\s*command:\s*'([a-z0-9_]+)'/g;
const menu = [];
while ((m = er.exec(M))) menu.push(m[1]);
menu.length <= 25 ? ok(`menu cap (${menu.length})`) : bad("over 25");
const cr = /bot\.command\(\s*(?:'([^']+)'|\[([^\]]+)\])/g;
const reg = new Set();
while ((m = cr.exec(S))) {
  if (m[1]) reg.add(m[1]);
  else
    for (const a of m[2]
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, "")))
      reg.add(a);
}
menu.every((c) => reg.has(c)) ? ok("menu↔commands") : bad("orphans");
for (const x of [
  "coach",
  "req_promote",
  "bug_promote",
  "triage",
  "preview",
  "sync",
  "ship",
  "inbox",
  "cancel",
  "predict",
  "promote",
  "inspect",
  "qa_handoff",
])
  menu.includes(x) ? ok(`/${x}`) : bad(`missing /${x}`);
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail);
