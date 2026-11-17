import { createRequire } from "node:module"; const require = createRequire(import.meta.url);

// skills/statechart/scripts/worker.ts
import { Buffer as Buffer2 } from "node:buffer";
import fs2 from "node:fs";
import path2 from "node:path";
import { pathToFileURL } from "node:url";
import { inspect as inspect2 } from "node:util";

// skills/statechart/scripts/ir.ts
var EC = {
  TLC_INVARIANT_VIOLATED_INITIAL: 2107,
  TLC_PROPERTY_VIOLATED_INITIAL: 2108,
  TLC_INVARIANT_VIOLATED_BEHAVIOR: 2110,
  TLC_ACTION_PROPERTY_VIOLATED_BEHAVIOR: 2112,
  TLC_DEADLOCK_REACHED: 2114,
  TLC_TEMPORAL_PROPERTY_VIOLATED: 2116,
  TLC_BACK_TO_STATE: 2122,
  TLC_FINISHED: 2186,
  TLC_INIT_GENERATED1: 2190,
  TLC_INIT_GENERATED2: 2191,
  TLC_STATS: 2199,
  TLC_PROGRESS_STATS: 2200,
  TLC_STATE_PRINT2: 2217,
  TLC_STATE_PRINT3: 2218,
  TLC_SANY_END: 2219,
  TLC_SANY_START: 2220
};
var LEVEL = { NONE: 0, ERROR: 1, TLCBUG: 2, WARNING: 3, STATE: 4 };
var RERUN_STATES = 1e5;
var CHART_STATES = 500;
var checked = /* @__PURE__ */ Symbol("checked");
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isStrings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
var PART = 1 << 24;
var byText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
var list = (items, and = "and") => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${and} ${items.at(-1)}`;
var ESCAPES = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "	": "\\t",
  "\r": "\\r",
  "\f": "\\f"
};
var quote = (s) => `"${s.replace(/["\\\n\t\r\f]/g, (c) => ESCAPES[c])}"`;
var joined = (items, sep) => {
  let s = "";
  for (let i = 0; i < items.length; i++) s += (i ? sep : "") + show(items[i]);
  return s;
};
var show = (v) => {
  switch (typeof v) {
    case "boolean":
      return v ? "TRUE" : "FALSE";
    case "number":
      return String(v);
    case "string":
      return quote(v);
  }
  switch (v.kind) {
    case "model":
      return v.name;
    case "interval":
      return `${v.lo}..${v.hi}`;
    case "set":
      return `{${joined(v.members, ", ")}}`;
    case "function": {
      if (v.printedAs === "tuple") return `<<${joined(v.values, ", ")}>>`;
      const record = v.printedAs === "record";
      let s = record ? "[" : "(";
      for (let i = 0; i < v.keys.length; i++)
        s += record ? `${i ? ", " : ""}${String(v.keys[i])} |-> ${show(v.values[i])}` : `${i ? " @@ " : ""}${show(v.keys[i])} :> ${show(v.values[i])}`;
      return s + (record ? "]" : ")");
    }
  }
};
var must = (map, key2) => {
  const value = map.get(key2);
  if (value === void 0) throw new Error(`The chart lost track of ${JSON.stringify(key2)}.`);
  return value;
};
var append = (groups, key2, item) => {
  const group = groups.get(key2);
  if (group) group.push(item);
  else groups.set(key2, [item]);
};
var seqOf = (bug, index) => {
  const seq = [must(index, bug.start)];
  for (const p of bug.path) seq.push(must(index, p.state));
  return seq;
};
var loopOf = (bug, index) => new Set(bug.loop === void 0 ? [] : seqOf(bug, index).slice(bug.loop));
var defaultState = (vars) => {
  const entries = Object.entries(vars);
  if (entries.length === 1) return show(entries[0][1]);
  const parts = [];
  for (const [k, v] of entries) parts.push(`${k}=${show(v)}`);
  return parts.join(" ");
};
var stateText = (vars) => {
  const parts = [];
  for (const [k, v] of Object.entries(vars)) parts.push(`${k} = ${show(v)}`);
  return parts.join(" /\\ ");
};
var count = (n) => {
  const items = new Int32Array(n);
  for (let i = 0; i < n; i++) items[i] = i;
  return items;
};
var sortBy = (items, keys2) => {
  for (let k = keys2.length - 1; k >= 0; k--) {
    const key2 = keys2[k];
    let size = 0;
    for (let p = 0; p < items.length; p++) if (key2[items[p]] >= size) size = key2[items[p]] + 1;
    const start = new Int32Array(size + 1);
    for (let p = 0; p < items.length; p++) start[key2[items[p]] + 1]++;
    for (let v = 0; v < size; v++) start[v + 1] += start[v];
    const sorted = new Int32Array(items.length);
    for (let p = 0; p < items.length; p++) sorted[start[key2[items[p]]]++] = items[p];
    items = sorted;
  }
  return items;
};
var tupleKey = (parts) => JSON.stringify(parts);
var unkey = (k) => {
  const parts = JSON.parse(k);
  if (!isStrings(parts)) throw new Error(`The chart cannot read the key ${k}.`);
  return parts;
};
function holds(condition, others) {
  switch (condition.kind) {
    case "and":
      for (let j = 0; j < others.length; j++)
        if (!condition.otherKeys[j].has(others[j])) return false;
      return true;
    case "or":
      for (let j = 0; j < others.length; j++)
        if (condition.otherKeys[j].has(others[j])) return true;
      return false;
    case "tuples":
      return condition.otherTuples.has(tupleKey(others));
  }
}
var ruleKey = (rule) => tupleKey([rule.kind, rule.name]);
var hasRule = (rules, rule) => {
  for (const r of rules) if (r.kind === rule.kind && r.name === rule.name) return true;
  return false;
};
var ascending = (keys2) => {
  for (let i = 1; i < keys2.length; i++) if (keys2[i - 1] > keys2[i]) return false;
  return true;
};
var span = (lo, hi) => hi > lo ? `${lo}..${hi}` : String(lo);
var setKey = (members) => {
  const ints = [];
  let others = [];
  for (const m of members)
    if (typeof m === "number") ints.push(m);
    else others.push(key(m));
  for (let i = 1; i < ints.length; i++)
    if (ints[i - 1] >= ints[i]) {
      ints.sort((a, b) => a - b);
      break;
    }
  if (!ascending(others)) others = others.sort(byText);
  let s = "{";
  for (let i = 0; i < ints.length; ) {
    let j = i;
    while (j + 1 < ints.length && ints[j + 1] - ints[j] <= 1) j++;
    s += `${s.length > 1 ? "," : ""}${span(ints[i], ints[j])}`;
    i = j + 1;
  }
  for (let i = 0; i < others.length; i++)
    if (!i || others[i] !== others[i - 1]) s += (s.length > 1 ? "," : "") + others[i];
  return s + "}";
};
var functionKey = ({ keys: keys2, values }) => {
  const order = [];
  const keyTexts = [];
  let ints = 0;
  for (let i = 0; i < keys2.length; i++) {
    order.push(i);
    keyTexts.push(key(keys2[i]));
    if (typeof keys2[i] === "number") ints++;
  }
  const rank = (i) => {
    const value = keys2[i];
    return typeof value === "number" ? value : Infinity;
  };
  order.sort((a, b) => rank(a) - rank(b) || byText(keyTexts[a], keyTexts[b]) || a - b);
  let tuple = ints === keys2.length;
  for (let i = 0; tuple && i < order.length; i++) tuple = keys2[order[i]] === i + 1;
  let s = tuple ? "<<" : "(";
  for (let i = 0, kept = 0; i < order.length; i++) {
    const k = order[i];
    if (i && keyTexts[k] === keyTexts[order[i - 1]]) continue;
    const v = key(values[k]);
    s += tuple ? `${kept++ ? "," : ""}${v}` : `${kept++ ? "@@" : ""}${keyTexts[k]}:>${v}`;
  }
  return s + (tuple ? ">>" : ")");
};
var keys = /* @__PURE__ */ new WeakMap();
var key = (v) => {
  switch (typeof v) {
    case "boolean":
      return v ? "TRUE" : "FALSE";
    case "number":
      return String(v);
    case "string":
      return JSON.stringify(v);
  }
  if (v.kind === "model") return v.name;
  let k = keys.get(v);
  if (k === void 0) {
    k = v.kind === "interval" ? `{${v.lo > v.hi ? "" : span(v.lo, v.hi)}}` : v.kind === "set" ? setKey(v.members) : functionKey(v);
    keys.set(v, k);
  }
  return k;
};
var stateKey = (values) => {
  let k = "";
  for (let i = 0; i < values.length; i++) k += (i ? "," : "") + key(values[i]);
  return k;
};
var memo = (make, limit = 1 << 16) => {
  const cache = /* @__PURE__ */ new Map();
  return (k) => {
    let v = cache.get(k);
    if (v === void 0) {
      if (cache.size >= limit) cache.clear();
      cache.set(k, v = make(k));
    }
    return v;
  };
};
var valuesOf = (vars, names2) => {
  const values = [];
  for (const n of names2) values.push(vars[n]);
  return values;
};
var findTrace = (counterexample, names2, rule, find) => {
  const trace = [];
  for (const { action, vars } of counterexample) {
    const values = valuesOf(vars, names2);
    trace.push({ action, vars, values, id: find(values) });
  }
  const end = trace.length - 1;
  if (end < 0) throw new Error(`TLC's trace for ${rule.name} has no states.`);
  for (let i = 0; i < end; i++)
    if (trace[i].id === void 0)
      throw new Error(
        `TLC's trace for ${rule.name} has a state before its last that the dump does not list.`
      );
  return trace;
};
var findLoop = ({ seq, loop }, names2, find) => {
  const found = [];
  for (const { action, vars } of seq)
    found.push({ action, id: vars && find(valuesOf(vars, names2)) });
  return { seq: found, loop };
};
var pastState = (vars, start, marked, excluded) => {
  const breaks = [];
  for (const r of marked) if (!hasRule(breaks, r)) breaks.push(r);
  return { vars, start, breaks, ends: [], past: true, excluded };
};
var CHECK_DEADLOCK = "CHECK_DEADLOCK";
var deadlockRule = ({ invariants, properties }) => ({
  kind: "deadlock",
  name: invariants.includes("NoDeadlock") || properties.includes("NoDeadlock") ? CHECK_DEADLOCK : "NoDeadlock"
});
var hasSection = ({ written }, ...keys2) => {
  for (const s of written) if (keys2.includes(s.key)) return true;
  return false;
};
var stateRules = (spec) => {
  const rules = [];
  for (const name of spec.invariants) rules.push({ kind: "invariant", name });
  if (spec.deadlock) rules.push(deadlockRule(spec));
  return rules;
};

// skills/statechart/scripts/frontends/view.ts
var projected = /* @__PURE__ */ new WeakMap();
var json = (v) => {
  if (typeof v !== "object") return v;
  if (v.kind === "model") return v.name;
  let j = projected.get(v);
  if (j === void 0) {
    if (v.kind === "interval") {
      const members = [];
      for (let k = v.lo; k <= v.hi; k++) members.push(k);
      j = members;
    } else if (v.kind === "set") {
      const members = [];
      for (const m of v.members) members.push(json(m));
      j = members;
    } else {
      const fields = [];
      for (let i = 0; i < v.keys.length; i++) {
        const k = json(v.keys[i]);
        fields.push([typeof k === "object" ? JSON.stringify(k) : String(k), json(v.values[i])]);
      }
      j = Object.fromEntries(fields);
    }
    projected.set(v, j);
  }
  return j;
};
var projectedVars = /* @__PURE__ */ new WeakMap();
var jsonVars = (vars) => {
  let j = projectedVars.get(vars);
  if (j === void 0) {
    const fields = [];
    for (const [name, v] of Object.entries(vars)) fields.push([name, json(v)]);
    j = Object.fromEntries(fields);
    projectedVars.set(vars, j);
  }
  return j;
};
var THEME_COLORS = ["blue", "orange", "purple", "yellow", "teal", "tan", "pink"];
var isFunction = (v) => typeof v === "function";
var isPlainObject = (v) => {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
var isString = (v) => typeof v === "string";
var VIEW_EXPORTS = ["state", "step", "group", "colors", "title"];
function checkView(view, inspect3) {
  const literal = (v) => typeof v === "string" ? JSON.stringify(v) : inspect3(v, { breakLength: Infinity });
  const extra = [];
  for (const name of Object.keys(view)) if (!VIEW_EXPORTS.includes(name)) extra.push(name);
  if (extra.length)
    throw new Error(
      `The view exports ${list(extra)}, which the command does not read. Export only ${list(VIEW_EXPORTS)}.`
    );
  const wrong = [];
  const pick = (name, kind, fits) => {
    const v = view[name];
    if (v === void 0 || fits(v)) return v;
    wrong.push(`${name} must be ${kind}`);
    return void 0;
  };
  const state = pick("state", "a function", isFunction);
  const step = pick("step", "a function", isFunction);
  const group = pick("group", "a function", isFunction);
  const exported = pick("colors", "a plain object", isPlainObject);
  const title = pick("title", "a string", isString);
  if (wrong.length) throw new Error(`The view's ${list(wrong)}.`);
  if (group !== void 0 && exported === void 0)
    throw new Error("The view exports group() but no colors. Give each group a color in colors.");
  const colors = /* @__PURE__ */ Object.create(null);
  const bad = [];
  for (const [name, color] of Object.entries(exported ?? {})) {
    if (typeof color === "string" && THEME_COLORS.includes(color)) colors[name] = color;
    else bad.push(`${JSON.stringify(name)} the color ${literal(color)}`);
  }
  if (bad.length)
    throw new Error(
      `The view's colors give ${list(bad)}. Give each group ${list(THEME_COLORS, "or")}.`
    );
  const named = group && ((vars) => {
    const g = group(jsonVars(vars));
    if (g !== void 0 && !Object.hasOwn(colors, typeof g === "symbol" ? g : String(g)))
      throw new Error(
        `The view's group() returned ${literal(g)}, which colors does not name. Give each group a color in colors.`
      );
    return g;
  });
  return {
    state: state && ((vars) => state(jsonVars(vars))),
    step: step && ((action, from, to) => step(action, jsonVars(from), jsonVars(to))),
    group: named,
    colors,
    title,
    [checked]: true
  };
}

// skills/statechart/scripts/backends/mermaid.ts
var BLANK = new RegExp("\\p{White_Space}", "u");
var SAFE = /^[\p{L}\p{N} !'()+,\-./=?[\]"_|@{}:\\^%<>]$/u;
var HAZARD = /:(?=:|$|\S*#)|\\(?=n)|%(?=%)|<(?=[\p{L}/!?])|_(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])_/giu;
var DIRECTION = /(direction)\s+(?=LR|RL|TB|BT)/gi;
var DOUBLE_BRACKET = /\[(?=\[)/g;
var C4 = /C4(?=Container|Component|Dynamic|Deployment)/g;
var UNDRAWN = /[\0\x80-\x9f]/;
var REWRITTEN = ["\uFB02\xB0", "\xB6\xDF"];
var MARKER = /(?<=marker-end=)"/g;
var firstOf = /* @__PURE__ */ new Map();
for (const pair of REWRITTEN) {
  const [first, second] = [...pair].map((c) => c.codePointAt(0) ?? 0);
  firstOf.set(second, first);
}
var KEPT = 0;
var BLANKED = 1;
var DROPPED = 2;
var CODED = 3;
var JOINS = 4;
var kindOf = (n) => {
  const c = String.fromCodePoint(n);
  const kind = c === " " ? KEPT : BLANK.test(c) ? BLANKED : UNDRAWN.test(c) ? DROPPED : SAFE.test(c) ? KEPT : CODED;
  return firstOf.has(n) ? kind | JOINS : kind;
};
var ASCII = Uint8Array.from({ length: 128 }, (_, n) => kindOf(n));
var wide = /* @__PURE__ */ new Map();
var kindAt = (n) => {
  if (n < 128) return ASCII[n];
  let kind = wide.get(n);
  if (kind === void 0) wide.set(n, kind = kindOf(n));
  return kind;
};
var encode = (s, ref) => {
  let out = "";
  let run = 0;
  let last = -1;
  for (let i = 0; i < s.length; ) {
    let n = s.charCodeAt(i);
    let width = 1;
    if (n >= 55296 && n <= 57343) {
      const low = s.charCodeAt(i + 1);
      if (n <= 56319 && low >= 56320 && low <= 57343) {
        n = 65536 + (n - 55296 << 10) + (low - 56320);
        width = 2;
      } else n = 65533;
    }
    let kind = kindAt(n);
    if (kind === DROPPED) {
      out += s.slice(run, i);
      run = i + width;
    } else {
      const joined3 = kind >= JOINS && firstOf.get(n) === last;
      kind &= ~JOINS;
      if (joined3 || kind !== KEPT) {
        out += s.slice(run, i);
        if (joined3) out += ref(8288);
        if (kind === KEPT) run = i;
        else {
          out += kind === BLANKED ? " " : ref(n);
          run = i + width;
        }
      }
      last = n;
    }
    i += width;
  }
  return out + s.slice(run);
};
var code = (s, ref) => encode(s, ref).replace(MARKER, `${ref(8288)}"`).replace(HAZARD, (c) => ref(c.charCodeAt(0)));
var esc = (s, quoted = false) => {
  const plain = code(s, (n) => `#${n};`);
  const out = quoted ? plain.replaceAll('"', "#34;") : plain;
  if (!out.trim()) return "#32;";
  const turned = out.replace(DIRECTION, "$1#32;");
  const opened = turned.includes("[[") ? turned.replace(DOUBLE_BRACKET, "#91;") : turned;
  return opened.includes("C4") ? opened.replace(C4, "C#52;") : opened;
};
var or = (names2) => [...names2].sort(byText).join(" or ");
var MARK_STYLES = {
  breaks: "fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834",
  mayBreak: "fill:#fff3e6,stroke:#e8730c,stroke-width:2.5px,color:#b85a06"
};
function mermaidLines(chart) {
  let next = 0;
  const marks = [];
  const used = /* @__PURE__ */ new Set();
  const rules = { breaks: /* @__PURE__ */ new Set(), mayBreak: /* @__PURE__ */ new Set() };
  const region = (r) => {
    const out = [];
    const topIds = /* @__PURE__ */ new Map();
    const nestedIds = /* @__PURE__ */ new Map();
    const id = (path3) => {
      const top = path3.length === 1;
      const named = top ? topIds : nestedIds;
      const k = top ? path3[0] : tupleKey(path3);
      let s = named.get(k);
      if (s === void 0) named.set(k, s = `s${next++}`);
      return s;
    };
    const known = /* @__PURE__ */ new Map();
    const idOf = (path3) => {
      let s = known.get(path3);
      if (s === void 0) known.set(path3, s = id(path3));
      return s;
    };
    const tree = (prefix, indent, below) => {
      const heads = /* @__PURE__ */ new Map();
      for (const s of below) append(heads, s.path[prefix.length], s);
      for (const [head, under] of heads) {
        const path3 = [...prefix, head];
        let leaf;
        const inner = [];
        for (const s of under)
          if (s.path.length > path3.length) inner.push(s);
          else leaf = s;
        if (inner.length) {
          out.push(`${indent}state "${esc(head, true)}" as ${id(path3)} {`);
          tree(path3, indent + "  ", inner);
          out.push(`${indent}}`);
        } else if (leaf) {
          const sid = idOf(leaf.path);
          out.push(`${indent}${sid}: ${esc(head)}`);
          let mark2 = leaf.breaks.length && !leaf.works ? "mayBreak" : void 0;
          if (mark2) {
            for (const b of leaf.breaks) if (b.always) mark2 = "breaks";
          }
          if (mark2) for (const b of leaf.breaks) rules[mark2].add(b.rule.name);
          const trail = [leaf.lead && "bugPath", leaf.repeats && "repeats"];
          const color = leaf.group === void 0 ? void 0 : chart.colors[String(leaf.group)];
          for (const cls of [color, mark2, ...trail])
            if (cls) {
              used.add(cls);
              marks.push(`  class ${sid} ${cls}`);
            }
        }
      }
    };
    tree([], "  ", r.states);
    for (const s of r.states) if (s.start) out.push(`  [*] --> ${idOf(s.path)}`);
    for (const s of r.steps)
      out.push(
        `  ${idOf(s.from)} --> ${idOf(s.to)}: ${esc(s.label + (s.when ? ` [${s.when}]` : ""))}`
      );
    return out;
  };
  let body;
  if (chart.regions.length > 1) {
    body = [`  state "At the same time" as all {`];
    for (const [i, r] of chart.regions.entries()) {
      if (i) body.push("    --");
      body.push(`    state "${esc(r.name, true)}" as r${i} {`);
      for (const line of region(r)) body.push(`    ${line}`);
      body.push("    }");
    }
    body.push("  }");
  } else body = region(chart.regions[0]);
  const legend = [];
  for (const entry of [
    ...Object.entries(chart.colors),
    [`Breaks ${or(rules.breaks)}`, "breaks"],
    [`Breaks ${or(rules.mayBreak)} in some cases`, "mayBreak"],
    [`Path to the ${or(chart.paths)} bug`, "bugPath"],
    [`Repeats forever, so ${or(chart.loops)} breaks`, "repeats"]
  ])
    if (used.has(entry[1])) legend.push(entry);
  const lines = [];
  const title = chart.title && code(chart.title, (n) => `\uFB02\xB0\xB0${n}\xB6\xDF`).replaceAll("<", "\uFB02\xB0\xB060\xB6\xDF");
  if (title) lines.push("---", `title: ${JSON.stringify(title)}`, "---");
  lines.push("stateDiagram-v2");
  if (chart.regions.length > 1) lines.push("  direction LR");
  if (legend.length) {
    lines.push(`  state "Legend" as legend {`);
    for (const [i, [text]] of legend.entries()) lines.push(`    lg${i}: ${esc(text)}`);
    lines.push("  }");
    for (const [i, [, cls]] of legend.entries()) lines.push(`  class lg${i} ${cls}`);
  }
  for (const line of body) lines.push(line);
  for (const [cls, style] of Object.entries(MARK_STYLES))
    if (used.has(cls)) lines.push(`  classDef ${cls} ${style}`);
  for (const line of marks) lines.push(line);
  return lines;
}

// skills/statechart/scripts/backends/plain-text.ts
var PREFIX = {
  [LEVEL.ERROR]: "Error: ",
  [LEVEL.TLCBUG]: "TLC Bug: ",
  [LEVEL.WARNING]: "Warning: ",
  [LEVEL.STATE]: "State "
};
var MINUTE = 6e4;
var HOUR = 36e5;
var DAY = 864e5;
var pad = (n) => String(n).padStart(2, "0");
function runtime(ms) {
  const t = new Date(ms > DAY ? ms - DAY : ms);
  const [hh, mm, ss] = [t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds()].map(pad);
  if (ms > DAY)
    return `${Math.floor((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY) + 1}d ${hh}h`;
  if (ms > HOUR) return `${hh}h ${mm}min`;
  if (ms > MINUTE) return `${mm}min ${ss}s`;
  return `${ss}s`;
}
var firstLine = ({ code: code2, level }, line) => {
  if (code2 === EC.TLC_BACK_TO_STATE)
    return line.replace(/^(\d+): Back to state: /, "Back to state $1: ");
  if (code2 === EC.TLC_FINISHED)
    return line.replace(
      /^Finished in (\d+)ms/,
      (_, ms) => `Finished in ${runtime(Number(ms))}`
    );
  return (PREFIX[level] ?? "") + line;
};
var render = (m) => (m.beforeMarker ?? "") + firstLine(m, m.body.map((part) => typeof part === "string" ? part : render(part)).join("\n"));
function* printed(parts) {
  let warned = false;
  let progress;
  for (const part of parts) {
    if (progress?.body.length && (typeof part === "string" || part.code !== EC.TLC_STATS))
      yield render(progress);
    progress = void 0;
    if (typeof part === "string") {
      yield part;
      continue;
    }
    if (part.code === EC.TLC_SANY_START || part.code === EC.TLC_SANY_END) continue;
    if (part.code === EC.TLC_PROGRESS_STATS) progress = part;
    else if (part.body.length) yield render(part);
    if (part.level === LEVEL.WARNING && !warned) {
      yield "(Use the -nowarning option to disable this warning.)";
      warned = true;
    }
  }
  if (progress?.body.length) yield render(progress);
}
function* plainText(parts) {
  let chunk = "";
  for (const line of printed(parts)) {
    chunk += `${line}
`;
    if (chunk.length >= PART) {
      yield chunk;
      chunk = "";
    }
  }
  if (chunk) yield chunk;
}

// skills/statechart/scripts/backends/report.ts
var stepsOf = (story) => {
  const path3 = [];
  for (const { step, state } of story) {
    const parts = [];
    for (const [name, names2] of Object.entries(state))
      parts.push((name ? `${name} ` : "") + names2.join(" / "));
    path3.push({ step, state: parts.join(", ") });
  }
  return path3;
};
var forever = (loop, stutters) => {
  const quoted = /* @__PURE__ */ new Set();
  for (const p of loop) quoted.add(`"${p.state}"`);
  const runs = [...quoted];
  if (stutters) return `The run stops in ${runs[0]} forever.`;
  return runs.length === 1 ? `The run stays in ${runs[0]} forever.` : `The run loops through ${list(runs)} forever.`;
};
var fenced = (text) => ["```", text, "```"].join("\n");
function report({
  spec,
  graph,
  paths,
  rules,
  properties,
  stop,
  drawing,
  states
}, found, chart, stories) {
  let size = 0;
  let arrows = 0;
  for (const r of chart?.regions ?? []) {
    size += r.states.length;
    arrows += r.steps.length;
  }
  let past = 0;
  let pastSteps = 0;
  let excluded = 0;
  for (const s of graph.states.values()) {
    if (s.excluded) excluded++;
    else if (s.past) past++;
  }
  for (const t of graph.steps) if (must(graph.states, t.to).past) pastSteps++;
  const includes = (n) => chart ? `, and the chart includes ${n === 1 ? "it" : "them"}` : "";
  const out = [
    `# ${spec.module}`,
    "",
    paths ? `TLC reached ${states.complete && !states.cut && states.distinct > CHART_STATES ? `${states.distinct.toLocaleString("en-US")} states, more than` : "more states than"} the chart budget of ${CHART_STATES}, so ${chart ? `the chart draws only the bug paths: ${size} states and ${arrows} arrows` : "the command wrote no chart.mmd"}.` : `TLC reached ${graph.states.size - past - excluded} states and ${graph.steps.length - pastSteps} steps. The chart draws ${size} states and ${arrows} arrows.`
  ];
  if (drawing)
    out.push(
      `TLC stopped the drawing run with exit ${drawing.status}, so the chart draws only the states that it reached before it stopped.`
    );
  if (!paths && !drawing && graph.states.size === past + excluded)
    out.push(
      states.initial ? "Every initial state is outside the constraints, so TLC explores none of them." : "TLC found no state that satisfies Init, so no state can break a rule."
    );
  if (past)
    out.push(
      `${past === 1 ? "1 state outside the constraints ends" : `${past} states outside the constraints each end`} a rule's path${includes(past)}. TLC checks the rules in a state outside the constraints, but it does not explore past it.`
    );
  if (excluded)
    out.push(
      `${excluded === 1 ? "1 step that the constraints exclude ends" : `${excluded} steps that the constraints exclude each end`} a rule's path${includes(excluded)}. TLC checks the rules after such a step, but it does not take the step.`
    );
  if (chart?.inside)
    out.push(`The chart does not draw ${chart.inside} steps that stay in one chart state.`);
  if (chart?.quiet)
    out.push(`The view hides ${chart.quiet} steps, so the chart does not draw them.`);
  for (const { rule, outcome } of rules)
    if (!paths && rule.kind === "deadlock" && outcome === "broken" && (drawing || hasSection(spec, "CONSTRAINT", "ACTION_CONSTRAINT")))
      out.push(
        drawing ? "The chart marks only the deadlock that TLC reports, because the drawing run stopped before it reached every state." : "The chart marks only the deadlock that TLC reports. Under a CONSTRAINT or an ACTION_CONSTRAINT, a state with no step in the chart can still have steps that the constraints leave out, and TLC does not count it as a deadlock."
      );
  if (chart?.lie) out.push(`${chart.lie} So the chart draws parent states in place of regions.`);
  out.push(...chart?.notes ?? []);
  const merged = [];
  for (const k of ["VIEW", "SYMMETRY"]) if (hasSection(spec, k)) merged.push(k);
  if (chart && merged.length)
    out.push(
      `With ${list(merged)}, TLC keeps one representative for each group of states that it counts as the same. An arrow can lead to the representative rather than to the state that the step reaches.`
    );
  for (const bug of found) {
    const steps = `${bug.path.length} step${bug.path.length === 1 ? "" : "s"}`;
    out.push("", `## ${bug.rule.name} breaks`);
    out.push(
      bug.rule.kind === "property" ? `TLC's counterexample is in tlc-${bug.rule.name}.out. It has ${steps}:` : `The shortest path has ${steps}:`
    );
    const path3 = stepsOf(must(stories, bug));
    for (const [i, p] of path3.entries()) out.push(`${i}. ${p.step ? `${p.step}: ` : ""}${p.state}`);
    if (bug.loop !== void 0) out.push(forever(path3.slice(bug.loop), bug.stutters));
  }
  const drawn = /* @__PURE__ */ new Set();
  for (const b of found) drawn.add(ruleKey(b.rule));
  const holds2 = [];
  const unchecked = [];
  for (const { rule, outcome, messages } of [...rules, ...properties]) {
    if (outcome === "holds") holds2.push(rule.name);
    else if (outcome === "not checked") unchecked.push(rule.name);
    else if (messages && !drawn.has(ruleKey(rule)))
      out.push(
        "",
        `## ${rule.name} breaks`,
        `TLC found a counterexample. It is in tlc-${rule.name}.out.`
      );
  }
  if (holds2.length) out.push("", "## Rules that hold", holds2.join(", "));
  if (unchecked.length) out.push("", "## Rules not checked", unchecked.join(", "));
  if (unchecked.length && states.cut)
    out.push(
      `After the first break, each TLC run stops at ${RERUN_STATES.toLocaleString("en-US")} distinct states. A run reached that bound before it checked ${unchecked.length === 1 ? "this rule" : "these rules"} in every state.`
    );
  if (stop)
    out.push(
      ...unchecked.length ? [
        `TLC stopped with exit ${stop.status} before it checked ${unchecked.length === 1 ? "this rule" : "these rules"}:`
      ] : ["", "## TLC stopped", `TLC stopped with exit ${stop.status}:`],
      fenced(stop.message)
    );
  for (const p of properties)
    if (p.outcome === "holds" && p.initialOnly)
      out.push(
        `TLC checked ${p.rule.name} only in the initial states, because it has no [], <>, or ~>. List it as an INVARIANT to check every state.`
      );
  return out.join("\n");
}

// skills/statechart/scripts/passes/label.ts
var isLabel = (l) => typeof l === "string" && l !== "" && !/\bundefined\b|\bNaN\b|\[object Object\]/.test(l);
var shapeOf = (shape, vars) => {
  function fail() {
    throw new Error(
      `The view's state() returned ${JSON.stringify(shape) ?? "undefined"} for the state ${stateText(vars)}. Return a string, an array of strings, or an object of those.`
    );
  }
  const path3 = (p) => {
    const labels = [];
    for (const l of [p].flat()) {
      if (!isLabel(l)) fail();
      labels.push(l);
    }
    if (!labels.length) fail();
    return labels;
  };
  const regions = isRecord(shape) ? Object.entries(shape) : [["", shape]];
  const pairs = [];
  for (const [k, v] of regions) pairs.push([k, path3(v)]);
  return pairs.length ? Object.fromEntries(pairs) : fail();
};
var stepOf = (view) => (action, from, to) => {
  const label = (view.step ?? ((a) => a))(action, from, to);
  if (label === null || isLabel(label)) return label;
  throw new Error(
    `The view's step() returned ${JSON.stringify(label) ?? "undefined"} for the step ${action}.`
  );
};
function unlabeled(action, before, after, bug) {
  const changed = [];
  for (const k of Object.keys(after)) if (key(before[k]) !== key(after[k])) changed.push(k);
  throw new Error(
    `The view's step() returned null for the step ${action} that changes ${changed.join(", ") || "nothing"}. It is on the path to the ${bug.rule.name} bug${bug.loop === void 0 ? "" : " or leaves its loop"}, so label it.`
  );
}
function ask(graph, { states: tla, nameOf, from, to }, view) {
  const n = nameOf.length;
  const m = from.length;
  const state = view.state;
  const shapes = new Array(n);
  for (let i = 0; i < n; i++)
    shapes[i] = shapeOf(state ? state(tla[i].vars) : nameOf[i], tla[i].vars);
  const names2 = Object.keys(shapes[0] ?? { "": [] });
  const regionsKey = tupleKey(names2);
  for (let i = 0; i < n; i++)
    if (tupleKey(Object.keys(shapes[i])) !== regionsKey)
      throw new Error(
        `The view's state() returned the regions ${names2.join(", ")} for one state and ${Object.keys(shapes[i]).join(", ")} for the state ${stateText(tla[i].vars)}. Return the same regions for every state.`
      );
  const step = stepOf(view);
  const labels = new Array(m);
  for (let j = 0; j < m; j++)
    labels[j] = step(graph.steps[j].action, tla[from[j]].vars, tla[to[j]].vars);
  const groups = new Array(n);
  const asked = new Uint8Array(n);
  const group = (i) => {
    if (view.group && !asked[i]) {
      groups[i] = view.group(tla[i].vars);
      asked[i] = 1;
    }
    return groups[i];
  };
  return { names: names2, shapes, labels, group };
}
function asParents({ states: tla }, { names: names2, shapes, labels, group }) {
  const parents = new Array(shapes.length);
  for (let i = 0; i < shapes.length; i++) {
    const path3 = [];
    for (const n of names2) for (const p of shapes[i][n]) path3.push(`${n} ${p}`);
    parents[i] = shapeOf(path3, tla[i].vars);
  }
  return { names: [""], shapes: parents, labels, group };
}
function labelGraph(graph, { index, from, to, action }, answers, rank, found) {
  const { names: names2, shapes, labels: stepLabels } = answers;
  const n = shapes.length;
  const m = stepLabels.length;
  const onPath = /* @__PURE__ */ new Set();
  for (const b of found) for (const p of b.path) onPath.add(p.step);
  const pathStepIndex = /* @__PURE__ */ new Map();
  if (onPath.size) {
    for (let j = 0; j < m; j++)
      if (onPath.has(graph.steps[j])) pathStepIndex.set(graph.steps[j], j);
  }
  const R = names2.length;
  const keys2 = [];
  const kinds = [];
  const sizes = [];
  for (const name of names2) {
    const key2 = new Array(n);
    const kind = new Int32Array(n);
    const tops = /* @__PURE__ */ new Map();
    const nested = /* @__PURE__ */ new Map();
    const keyOf = [];
    for (let i = 0; i < n; i++) {
      const path3 = shapes[i][name];
      const top = path3.length === 1;
      const seen = top ? tops : nested;
      const k = top ? path3[0] : tupleKey(path3);
      let c = seen.get(k);
      if (c === void 0) {
        seen.set(k, c = keyOf.length);
        keyOf.push(top ? tupleKey(path3) : k);
      }
      key2[i] = keyOf[c];
      kind[i] = c;
    }
    keys2.push(key2);
    kinds.push(kind);
    sizes.push(keyOf.length);
  }
  for (const b of found) {
    let t;
    for (const p of b.path)
      if (stepLabels[must(pathStepIndex, p.step)] === null) {
        t = p.step;
        break;
      }
    if (!t) {
      const inLoop = loopOf(b, index);
      if (inLoop.size) {
        for (let j = 0; j < m; j++)
          if (inLoop.has(from[j]) && !inLoop.has(to[j]) && stepLabels[j] === null) {
            t = graph.steps[j];
            break;
          }
      }
    }
    if (t) unlabeled(t.action, must(graph.states, t.from).vars, must(graph.states, t.to).vars, b);
  }
  const drawn = [];
  const drawnLabels = new Array(m);
  for (let j = 0; j < m; j++) {
    const label = stepLabels[j];
    if (label === null) continue;
    drawn.push(j);
    drawnLabels[j] = label;
  }
  const fromRank = new Int32Array(m);
  const toRank = new Int32Array(m);
  for (let j = 0; j < m; j++) {
    fromRank[j] = rank[from[j]];
    toRank[j] = rank[to[j]];
  }
  const sorted = sortBy(Int32Array.from(drawn), [fromRank, toRank, action]);
  const pathSteps = new Uint8Array(m);
  for (const j of pathStepIndex.values()) pathSteps[j] = 1;
  const byLabel = /* @__PURE__ */ new Map();
  if (R > 1)
    for (const j of sorted) {
      let entry = byLabel.get(drawnLabels[j]);
      if (!entry)
        byLabel.set(drawnLabels[j], entry = { changed: new Uint8Array(R), sets: /* @__PURE__ */ new Set() });
      const changed = [];
      for (let r = 0; r < R; r++)
        if (kinds[r][from[j]] !== kinds[r][to[j]]) {
          changed.push(names2[r]);
          entry.changed[r] = 1;
        }
      if (changed.length > 1) entry.sets.add(list(changed));
    }
  const together = /* @__PURE__ */ new Set();
  for (const [text, { sets }] of byLabel) if (sets.size) together.add(text);
  const notes = [];
  for (const [text, entry] of byLabel) {
    const changed = [];
    for (let r = 0; r < R; r++) if (entry.changed[r]) changed.push(names2[r]);
    if (changed.length < 2) continue;
    if (!together.has(text)) {
      notes.push(`The step ${text} changes only one of ${list(changed)} at a time.`);
      continue;
    }
    const sets = [...entry.sets];
    notes.push(
      `The step ${text} changes ${sets.length > 1 ? `${sets.join(", or ")},` : sets[0]} at the same time.`
    );
  }
  return {
    ...answers,
    drawnLabels,
    keys: keys2,
    kinds,
    sizes,
    sorted,
    pathStepIndex,
    pathSteps,
    together,
    notes
  };
}
function tell(states, found, shapeAt, labelAt) {
  const vars = (id) => must(states, id).vars;
  const stories = /* @__PURE__ */ new Map();
  for (const bug of found) {
    const story = [{ state: shapeAt(bug.start) }];
    let from = bug.start;
    for (const [k, p] of bug.path.entries()) {
      const step = labelAt(bug, k, from);
      if (step === null) unlabeled(p.action, vars(from), vars(p.state), bug);
      story.push({ step, state: shapeAt(p.state) });
      from = p.state;
    }
    stories.set(bug, story);
  }
  return stories;
}
var storiesOf = (graph, found, { index }, { shapes, drawnLabels, pathStepIndex }) => tell(
  graph.states,
  found,
  (id) => shapes[must(index, id)],
  (bug, k) => drawnLabels[must(pathStepIndex, bug.path[k].step)]
);

// skills/statechart/scripts/passes/lift.ts
function liftToParents(states, steps) {
  const depths = /* @__PURE__ */ new Map();
  const leaves = /* @__PURE__ */ new Map();
  for (const s of states.values())
    for (let i = 1; i < s.path.length; i++) {
      const prefix = tupleKey(s.path.slice(0, i));
      depths.set(prefix, i);
      leaves.set(prefix, (leaves.get(prefix) ?? 0) + 1);
    }
  if (!depths.size) return steps;
  const leaving = /* @__PURE__ */ new Map();
  for (const s of steps) {
    let same = 0;
    while (same < s.from.length && s.from[same] === s.to[same]) same++;
    for (let i = 1; i < s.from.length; i++) {
      if (i <= same && i < s.to.length) continue;
      const prefix = tupleKey(s.from.slice(0, i));
      if (depths.has(prefix)) append(leaving, prefix, s);
    }
  }
  const removed = /* @__PURE__ */ new Set();
  const lifted = [];
  for (const [prefix] of [...depths].sort((a, b) => a[1] - b[1])) {
    const groups = /* @__PURE__ */ new Map();
    for (const s of leaving.get(prefix) ?? [])
      if (!removed.has(s)) append(groups, tupleKey([s.label, s.when, s.to]), s);
    const under = must(leaves, prefix);
    for (const group of groups.values()) {
      if (under < 2 || group.length < under) continue;
      for (const s of group) removed.add(s);
      lifted.push({ ...group[0], from: unkey(prefix) });
    }
  }
  const kept = [];
  for (const s of steps) if (!removed.has(s)) kept.push(s);
  for (const s of lifted) kept.push(s);
  return kept;
}
function lift(chart) {
  const regions = [];
  for (const r of chart.regions) {
    const known = /* @__PURE__ */ new Map();
    for (const s of r.states) known.set(s.path, known.size);
    let numbers;
    const pathIndex = (path3) => {
      let i = known.get(path3);
      if (i !== void 0) return i;
      if (!numbers) {
        numbers = /* @__PURE__ */ new Map();
        for (const s of r.states) numbers.set(tupleKey(s.path), numbers.size);
      }
      const k = tupleKey(path3);
      i = numbers.get(k);
      if (i === void 0) numbers.set(k, i = numbers.size);
      known.set(path3, i);
      return i;
    };
    const merged = /* @__PURE__ */ new Map();
    for (const s of liftToParents(r.states, r.steps)) {
      const f = pathIndex(s.from);
      const t = pathIndex(s.to);
      const k = s.when === void 0 && f < 2 ** 26 && t < 2 ** 26 ? f * 2 ** 26 + t : `${f},${t}:${s.when}`;
      const prior = merged.get(k);
      if (prior) prior.label += ` or ${s.label}`;
      else merged.set(k, { ...s });
    }
    regions.push({ ...r, steps: [...merged.values()] });
  }
  return { ...chart, regions };
}

// skills/statechart/scripts/passes/loop-check.ts
function loopCheck({ regions, loops }, { names: names2, keys: keys2, drawnLabels, sorted }, { index, from, to }, found) {
  const R = names2.length;
  const combo = (i) => {
    const parts = [];
    for (let r = 0; r < R; r++) parts.push(keys2[r][i]);
    return tupleKey(parts);
  };
  const stepsFrom = /* @__PURE__ */ new Map();
  const arrowsFrom = [];
  if (loops.length) {
    for (const j of sorted) append(stepsFrom, from[j], j);
    for (const { arrows } of regions) {
      const out = /* @__PURE__ */ new Map();
      for (const a of arrows) append(out, a.from, a);
      arrowsFrom.push(out);
    }
  }
  for (const b of found) {
    if (b.loop === void 0) continue;
    const inLoop = /* @__PURE__ */ new Set();
    const twinsOf = /* @__PURE__ */ new Map();
    for (const i of loopOf(b, index)) {
      inLoop.add(combo(i));
      append(twinsOf, combo(i), i);
    }
    for (const i of loopOf(b, index)) {
      const twins = must(twinsOf, combo(i));
      for (const [r, name] of names2.entries()) {
        const takes = (a) => {
          for (const s of twins)
            for (const j of stepsFrom.get(s) ?? [])
              if (drawnLabels[j] === a.label && keys2[r][to[j]] === a.to) return true;
          return false;
        };
        const rest = [];
        for (let o = 0; o < R; o++) if (o !== r) rest.push(keys2[o][i]);
        for (const a of arrowsFrom[r].get(keys2[r][i]) ?? []) {
          if (!holds(a.condition, rest)) continue;
          const next = [];
          for (let o = 0; o < R; o++) next.push(o === r ? a.to : keys2[o][i]);
          if (!inLoop.has(tupleKey(next)) && !takes(a))
            throw new Error(
              `The chart draws the step ${a.label} out of ${name ? `${name} ` : ""}${unkey(a.from).join(" / ")}, but the ${b.rule.name} loop cannot take it there. Show in a label what stops it.`
            );
        }
      }
    }
  }
}

// skills/statechart/scripts/passes/reach.ts
function walk(graph) {
  const ids = [];
  const states = [];
  const nameOf = [];
  const starts = [];
  const unique = /* @__PURE__ */ new Set();
  for (const [id, s] of graph.states) {
    const name = defaultState(s.vars);
    if (s.start) starts.push(ids.length);
    ids.push(id);
    states.push(s);
    nameOf.push(name);
    unique.add(name);
  }
  const names2 = Array.from(unique).sort(byText);
  const rankOf = /* @__PURE__ */ new Map();
  for (let i = 0; i < names2.length; i++) rankOf.set(names2[i], i);
  const n = ids.length;
  const index = /* @__PURE__ */ new Map();
  const nameRank = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    index.set(ids[i], i);
    nameRank[i] = must(rankOf, nameOf[i]);
  }
  const m = graph.steps.length;
  const from = new Int32Array(m);
  const to = new Int32Array(m);
  const action = new Int32Array(m);
  const actions = /* @__PURE__ */ new Map();
  for (let j = 0; j < m; j++) {
    const t = graph.steps[j];
    from[j] = must(index, t.from);
    to[j] = must(index, t.to);
    let a = actions.get(t.action);
    if (a === void 0) actions.set(t.action, a = actions.size);
    action[j] = a;
  }
  const actionRank = new Int32Array(actions.size);
  for (const [i, a] of [...actions.keys()].sort(byText).entries()) actionRank[must(actions, a)] = i;
  const toName = new Int32Array(m);
  for (let j = 0; j < m; j++) {
    action[j] = actionRank[action[j]];
    toName[j] = nameRank[to[j]];
  }
  const first = new Int32Array(n + 1);
  for (let j = 0; j < m; j++) first[from[j] + 1]++;
  for (let i = 0; i < n; i++) first[i + 1] += first[i];
  const fill = first.slice(0, n);
  const next = new Int32Array(m);
  for (const j of sortBy(count(m), [action, toName])) next[fill[from[j]]++] = j;
  starts.sort((a, b) => nameRank[a] - nameRank[b]);
  const depth = new Int32Array(n).fill(-1);
  const via = new Int32Array(n).fill(-1);
  const reached = new Int32Array(n);
  let size = 0;
  for (const s of starts) {
    depth[s] = 0;
    reached[size++] = s;
  }
  for (let q = 0; q < size; q++) {
    const s = reached[q];
    for (let e = first[s]; e < first[s + 1]; e++) {
      const t = to[next[e]];
      if (depth[t] >= 0) continue;
      depth[t] = depth[s] + 1;
      via[t] = next[e];
      reached[size++] = t;
    }
  }
  return {
    ids,
    states,
    index,
    nameOf,
    nameRank,
    from,
    to,
    action,
    depth,
    via,
    reached: reached.subarray(0, size),
    starts
  };
}
function drawOrder({ depth, nameRank }) {
  const n = depth.length;
  let deepest = 0;
  for (let i = 0; i < n; i++) if (depth[i] > deepest) deepest = depth[i];
  const level = new Int32Array(n);
  for (let i = 0; i < n; i++) level[i] = depth[i] < 0 ? deepest + 1 : depth[i];
  const order = sortBy(count(n), [level, nameRank]);
  const rank = new Int32Array(n);
  for (let p = 0; p < n; p++) rank[order[p]] = p;
  return { order, rank };
}
function bugs(graph, { ids, from, via, reached } = walk(graph)) {
  const ends = /* @__PURE__ */ new Map();
  for (const [id, s] of graph.states) for (const rule of s.ends ?? []) ends.set(ruleKey(rule), id);
  const first = /* @__PURE__ */ new Map();
  for (const i of reached) {
    const s = must(graph.states, ids[i]);
    for (const rule of s.past ? s.ends : s.breaks) {
      const k = ruleKey(rule);
      if (!first.has(k) && (ends.get(k) ?? ids[i]) === ids[i]) first.set(k, { rule, i });
    }
  }
  const found = [];
  for (const { rule, i } of first.values()) {
    const path3 = [];
    let start = i;
    for (let j; (j = via[start]) >= 0; start = from[j]) {
      const step = graph.steps[j];
      path3.unshift({ action: step.action, state: step.to, step });
    }
    found.push({ rule, start: ids[start], path: path3 });
  }
  return found;
}

// skills/statechart/scripts/passes/region-check.ts
function regionsLie(regions, { names: names2, keys: keys2, sorted, drawnLabels, together }, { from, to, starts }, order) {
  if (names2.length < 2) return void 0;
  const combo = (i) => {
    const c = [];
    for (let r = 0; r < names2.length; r++) c.push(keys2[r][i]);
    return c;
  };
  const words = (c) => {
    const parts = [];
    for (let i = 0; i < names2.length; i++) parts.push(`${names2[i]} ${unkey(c[i]).join(" / ")}`);
    return parts.join(", ");
  };
  const addMove = (moves, m) => moves.set(tupleKey([m.from, m.text, m.to]), m);
  let product = [[]];
  for (const r of regions) {
    const next = [];
    for (const c of product)
      for (const s of r.states) if (s.start) next.push([...c, tupleKey(s.path)]);
    product = next;
  }
  const realStarts = /* @__PURE__ */ new Set();
  for (const i of starts) realStarts.add(tupleKey(combo(i)));
  for (const c of product)
    if (!realStarts.has(tupleKey(c)))
      return `The regions chart starts at ${words(c)}, where the model never starts.`;
  for (const [i, r] of regions.entries())
    for (const a of r.arrows)
      if (a.condition.kind === "tuples")
        return `In ${names2[i]}, ${a.label} from ${unkey(a.from).join(" / ")} depends on the other regions in a way that one "and" or "or" condition cannot say.`;
  const real = /* @__PURE__ */ new Map();
  for (const j of sorted) {
    const before = combo(from[j]);
    const after = combo(to[j]);
    if (tupleKey(before) !== tupleKey(after))
      addMove(real, { from: before, text: drawnLabels[j], to: after });
  }
  const combos = /* @__PURE__ */ new Map();
  for (const i of order) {
    const c = combo(i);
    combos.set(tupleKey(c), c);
  }
  const drawn = /* @__PURE__ */ new Map();
  for (const c of combos.values()) {
    const enabled = /* @__PURE__ */ new Map();
    for (const [i, r] of regions.entries()) {
      const rest = [];
      for (let k = 0; k < c.length; k++) if (k !== i) rest.push(c[k]);
      for (const a of r.arrows)
        if (a.from === c[i] && holds(a.condition, rest)) append(enabled, a.label, { i, a });
    }
    for (const [text, list2] of enabled) {
      let groups = [];
      if (together.has(text)) {
        const byRegion = /* @__PURE__ */ new Map();
        for (const m of list2) append(byRegion, m.i, m);
        groups = [[]];
        for (const opts of byRegion.values()) {
          const next = [];
          for (const g of groups) for (const m of opts) next.push([...g, m]);
          groups = next;
        }
      } else for (const m of list2) groups.push([m]);
      for (const group of groups) {
        const to2 = [...c];
        for (const { i, a } of group) to2[i] = a.to;
        addMove(drawn, { from: c, text, to: to2 });
      }
    }
  }
  for (const [k, extra] of drawn)
    if (!real.has(k))
      return `The regions chart lets ${words(extra.from)} go to ${words(extra.to)} by ${extra.text}, which the model never does.`;
  for (const [k, missing] of real)
    if (!drawn.has(k))
      return `The model goes from ${words(missing.from)} to ${words(missing.to)} by ${missing.text}, which the regions chart cannot show.`;
  return void 0;
}

// skills/statechart/scripts/passes/regions.ts
var anyRest = { kind: "and", otherKeys: [] };
function drawRegions({ states: tla, index, from, to }, { names: names2, shapes, drawnLabels, group, keys: keys2, kinds, sizes, sorted, pathSteps, notes }, order, found, view) {
  const n = shapes.length;
  const m = drawnLabels.length;
  const R = names2.length;
  const lead = new Uint8Array(n);
  const looped = new Uint8Array(n);
  for (const b of found) {
    for (const i of seqOf(b, index).slice(0, b.loop)) lead[i] = 1;
    for (const i of loopOf(b, index)) looped[i] = 1;
  }
  const loop = (j) => R === 1 && pathSteps[j] === 1;
  const stays = (j) => {
    for (let r = 0; r < R; r++) if (kinds[r][from[j]] !== kinds[r][to[j]]) return false;
    return true;
  };
  let inside = 0;
  for (const j of sorted) if (stays(j) && !loop(j)) inside++;
  const comboOf = R === 1 ? (i) => kinds[0][i] : (i) => {
    let c = "";
    for (let r = 0; r < R; r++) c += (r ? "," : "") + kinds[r][i];
    return c;
  };
  const dirty = /* @__PURE__ */ new Map();
  for (const i of order)
    if (tla[i].breaks.length) {
      const c = comboOf(i);
      if (!dirty.has(c)) dirty.set(c, i);
    }
  const clean = new Uint8Array(n);
  if (dirty.size) for (let i = 0; i < n; i++) clean[i] = dirty.has(comboOf(i)) ? 0 : 1;
  else clean.fill(1);
  const regions = [];
  const objects = [];
  for (const [r, name] of names2.entries()) {
    const key2 = keys2[r];
    const kind = kinds[r];
    const states = /* @__PURE__ */ new Map();
    const objectOf = new Array(sizes[r]);
    const keyOf = new Array(sizes[r]);
    const position = new Int32Array(sizes[r]);
    for (const i of order) {
      const s = tla[i];
      let o = objectOf[kind[i]];
      if (!o) {
        o = {
          path: shapes[i][name],
          start: false,
          members: [],
          works: false,
          lead: false,
          repeats: false,
          breaks: [],
          group: void 0
        };
        objectOf[kind[i]] = o;
        keyOf[kind[i]] = key2[i];
        position[kind[i]] = states.size;
        states.set(key2[i], o);
      }
      o.start ||= s.start;
      o.works ||= clean[i] === 1;
      o.lead ||= lead[i] === 1;
      o.repeats ||= looped[i] === 1;
      o.members.push(i);
    }
    const parents = /* @__PURE__ */ new Set();
    for (const s of states.values())
      for (let i = 1; i < s.path.length; i++) parents.add(tupleKey(s.path.slice(0, i)));
    for (const s of states.values()) {
      if (parents.size && parents.has(tupleKey(s.path)))
        throw new Error(
          `The view's state() returned ${s.path.join(" / ")} both as a state and as a parent state${name ? ` in ${name}` : ""}. Give that state a child name of its own.`
        );
      const rules = /* @__PURE__ */ new Map();
      for (const i of s.members) for (const rule of tla[i].breaks) rules.set(ruleKey(rule), rule);
      s.breaks = [];
      for (const rule of [...rules.values()].sort(
        (a, b) => byText(a.name, b.name) || byText(a.kind, b.kind)
      )) {
        let always = true;
        for (const i of s.members) always &&= hasRule(tla[i].breaks, rule);
        s.breaks.push({ rule, always });
      }
      const groups = /* @__PURE__ */ new Set();
      for (const i of s.members) groups.add(group(i));
      s.group = groups.size === 1 ? [...groups][0] : void 0;
    }
    const others = [];
    for (let o = 0; o < R; o++) if (o !== r) others.push(o);
    const tuple = (i) => {
      const t = [];
      for (const o of others) t.push(keys2[o][i]);
      return t;
    };
    const two = others.length === 1;
    const words = (vs) => {
      const texts = [];
      for (const v of vs) texts.push(unkey(v).join(" / "));
      return texts.sort(byText).join(two ? " or " : ", ");
    };
    const is = (o, vs) => two ? `when ${words(vs)}` : `${names2[o]} is ${vs.size > 1 ? "one of " : ""}${words(vs)}`;
    const isNot = (o, vs) => two ? `unless ${words(vs)}` : `${names2[o]} is ${vs.length > 1 ? "none of" : "not"} ${words(vs)}`;
    const moves = [];
    const pairs = /* @__PURE__ */ new Map();
    const size = sizes[r];
    for (const j of sorted) {
      const f = kind[from[j]];
      const t = kind[to[j]];
      if (f === t && !loop(j)) continue;
      const text = drawnLabels[j];
      const pair = position[f] * size + position[t];
      let move = pairs.get(pair);
      while (move && move.text !== text) move = move.other;
      if (!move) {
        move = { f, t, text, group: [], other: pairs.get(pair) };
        pairs.set(pair, move);
        moves.push(move);
      }
      if (R > 1) move.group.push(j);
    }
    const tuplesAt = /* @__PURE__ */ new Map();
    const seenAt = /* @__PURE__ */ new Map();
    if (R > 1) for (const i of order) append(tuplesAt, kind[i], i);
    const arrows = [];
    for (const move of moves) {
      const fromKey = keyOf[move.f];
      const toKey = keyOf[move.t];
      if (R === 1) {
        arrows.push({
          from: fromKey,
          to: toKey,
          label: move.text,
          condition: anyRest,
          when: void 0
        });
        continue;
      }
      const ok = /* @__PURE__ */ new Set();
      for (const j of move.group) ok.add(tupleKey(tuple(from[j])));
      const takes = (t) => ok.has(tupleKey(t));
      let seen = seenAt.get(move.f);
      if (!seen) {
        seen = [];
        const seenKeys = /* @__PURE__ */ new Set();
        for (const i of must(tuplesAt, move.f)) {
          const t = tuple(i);
          const k = tupleKey(t);
          if (seenKeys.has(k)) continue;
          seenKeys.add(k);
          seen.push(t);
        }
        seenAt.set(move.f, seen);
      }
      const all = [];
      const and = [];
      const or2 = [];
      for (let j = 0; j < others.length; j++) {
        const values = /* @__PURE__ */ new Set();
        const taken = /* @__PURE__ */ new Set();
        const untaken = /* @__PURE__ */ new Set();
        for (const t of seen) {
          values.add(t[j]);
          if (takes(t)) taken.add(t[j]);
          else untaken.add(t[j]);
        }
        const only2 = /* @__PURE__ */ new Set();
        for (const v of values) if (!untaken.has(v)) only2.add(v);
        all.push(values);
        and.push(taken);
        or2.push(only2);
      }
      const fits = (condition) => {
        for (const t of seen) if (holds(condition, t) !== takes(t)) return false;
        return true;
      };
      const andHolds = { kind: "and", otherKeys: and };
      const orHolds = { kind: "or", otherKeys: or2 };
      const text = move.text;
      if (fits(andHolds)) {
        const parts = [];
        for (let j = 0; j < others.length; j++) {
          const no = [];
          for (const v of all[j]) if (!and[j].has(v)) no.push(v);
          if (no.length)
            parts.push(and[j].size <= no.length ? is(others[j], and[j]) : isNot(others[j], no));
        }
        arrows.push({
          from: fromKey,
          to: toKey,
          label: text,
          condition: andHolds,
          when: parts.length ? two ? parts[0] : `when ${parts.join(" and ")}` : void 0
        });
      } else if (fits(orHolds)) {
        const parts = [];
        for (let j = 0; j < others.length; j++) if (or2[j].size) parts.push(is(others[j], or2[j]));
        arrows.push({
          from: fromKey,
          to: toKey,
          label: text,
          condition: orHolds,
          when: `when ${parts.join(" or ")}`
        });
      } else
        arrows.push({
          from: fromKey,
          to: toKey,
          label: text,
          condition: { kind: "tuples", otherTuples: ok }
        });
    }
    const steps = [];
    for (const [k, a] of arrows.entries())
      steps.push({
        from: objectOf[moves[k].f].path,
        to: objectOf[moves[k].t].path,
        label: a.label,
        when: a.label.endsWith("]") ? void 0 : a.when
      });
    regions.push({ name, states: [...states.values()], steps, arrows });
    objects.push(objectOf);
  }
  const hidden = [];
  for (const i of dirty.values()) {
    const ps = [];
    for (let r = 0; r < R; r++) ps.push(objects[r][kinds[r][i]]);
    let works = true;
    for (const s of ps) works &&= s.works;
    if (works) hidden.push(ps);
  }
  for (const ps of hidden) for (const s of ps) s.works = false;
  const paths = [];
  const loops = [];
  for (const b of found) {
    if (b.loop !== 0) paths.push(b.rule.name);
    if (b.loop !== void 0) loops.push(b.rule.name);
  }
  return {
    title: view.title,
    regions,
    notes,
    inside,
    quiet: m - sorted.length,
    colors: view.colors ?? {},
    paths,
    loops
  };
}

// skills/statechart/scripts/pipeline.ts
function* inParts(lines) {
  let start = 0;
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    size += lines[i].length + 1;
    if (size > PART || i === lines.length - 1) {
      yield (start ? "\n" : "") + lines.slice(start, i + 1).join("\n");
      start = i + 1;
      size = 0;
    }
  }
}
var shortestFirst = (a, b) => a.path.length - b.path.length;
function project(graph, walked, view, found) {
  const { order, rank } = drawOrder(walked);
  const draw = (answers2) => {
    const labels2 = labelGraph(graph, walked, answers2, rank, found);
    return { labels: labels2, chart: drawRegions(walked, labels2, order, found, view) };
  };
  const answers = ask(graph, walked, view);
  const first = draw(answers);
  const lie = regionsLie(first.chart.regions, first.labels, walked, order);
  const { labels, chart } = lie ? draw(asParents(walked, answers)) : first;
  loopCheck(chart, labels, walked, found);
  return {
    chart: lift(lie ? { ...chart, lie } : chart),
    stories: storiesOf(graph, found, walked, first.labels)
  };
}
function compile(result, view) {
  const walked = walk(result.graph);
  const found = [...result.paths ?? bugs(result.graph, walked)].sort(shortestFirst);
  for (const p of result.properties) if (p.bug) found.push({ rule: p.rule, ...p.bug });
  const { chart, stories } = found.length || !result.paths ? project(result.graph, walked, view, found) : { chart: void 0, stories: /* @__PURE__ */ new Map() };
  const text = report(result, found, chart, stories);
  const files = /* @__PURE__ */ new Map();
  if (chart) files.set("chart.mmd", inParts(mermaidLines(chart)));
  files.set("report.md", [text]);
  files.set("tlc.out", plainText(result.messages));
  const drawn = /* @__PURE__ */ new Set();
  for (const b of found) if (b.rule.kind !== "property") drawn.add(ruleKey(b.rule));
  for (const { rule, outcome, messages } of [...result.rules, ...result.properties])
    if (outcome === "broken" && messages && !drawn.has(ruleKey(rule)))
      files.set(`tlc-${rule.name}.out`, plainText(messages));
  return { report: text, files, exit: result.exit };
}

// skills/statechart/scripts/run.ts
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";

// skills/statechart/scripts/backends/cfg.ts
function configText(sections, extra) {
  const lines = [];
  for (const s of sections) lines.push(`${s.key} ${s.tokens.join(" ")}`);
  lines.push(...extra);
  return lines.join("\n");
}
var helperName = (base, used) => {
  let name = base;
  let suffix = 1;
  while (used.has(name)) name = `${base}_${suffix++}`;
  return name;
};
function helperOperators(definitions) {
  const used = new Set(definitions);
  const take = (base) => {
    const name = helperName(base, used);
    used.add(name);
    return name;
  };
  return {
    tlc: take("ChartTLC"),
    naturals: take("ChartNaturals"),
    bound: take("ChartBound"),
    budget: take("ChartBudget"),
    broken: take("ChartBroken"),
    mark: take("ChartMark")
  };
}
var boundRun = (module, name, ops) => [
  `---- MODULE ${name} ----`,
  `EXTENDS ${module}`,
  `${ops.tlc} == INSTANCE TLC`,
  `${ops.naturals} == INSTANCE Naturals`,
  `${ops.bound} == ${ops.naturals}!<(${ops.tlc}!TLCGet("distinct"), ${RERUN_STATES})`,
  `====`
].join("\n");
function chartRun({ module, variables, invariants }, tag, name, ops) {
  const every = [];
  for (const name2 of invariants) every.push(`(IF ~${name2} THEN {"${name2}"} ELSE {}) \\cup `);
  return [
    `---- MODULE ${name} ----`,
    `EXTENDS ${module}`,
    `${ops.tlc} == INSTANCE TLC`,
    `${ops.naturals} == INSTANCE Naturals`,
    `${ops.budget} == ${ops.naturals}!<=(${ops.tlc}!TLCGet("distinct"), ${CHART_STATES})`,
    `${ops.broken} == ${every.join("")}{}`,
    `${ops.mark} == ${ops.broken} = {} \\/ ${ops.tlc}!PrintT(<<"${tag}", <<${variables.join(", ")}>>, ${ops.broken}>>)`,
    `====`
  ].join("\n");
}

// skills/statechart/scripts/frontends/config.ts
var isListField = (field) => field === "invariants" || field === "properties" || field === "constraints" || field === "actionConstraints";
var SECTIONS = /* @__PURE__ */ new Map();
for (const section of [
  { key: "CONSTANT", plural: "CONSTANTS" },
  { key: CHECK_DEADLOCK, field: "checkDeadlock" },
  { key: "INIT", field: "init", undefinedNoun: "initial predicate" },
  { key: "NEXT", field: "next", undefinedNoun: "next state action" },
  { key: "SPECIFICATION", field: "spec", undefinedNoun: "name" },
  { key: "VIEW", field: "view", undefinedNoun: "view function" },
  { key: "SYMMETRY", field: "symmetry", undefinedNoun: "symmetry function" },
  { key: "TYPE", field: "type" },
  { key: "TYPE_CONSTRAINT", field: "typeConstraint" },
  { key: "INVARIANT", plural: "INVARIANTS", field: "invariants", undefinedNoun: "invariant" },
  { key: "PROPERTY", plural: "PROPERTIES", field: "properties", undefinedNoun: "property" },
  { key: "CONSTRAINT", plural: "CONSTRAINTS", field: "constraints", undefinedNoun: "constraint" },
  {
    key: "ACTION_CONSTRAINT",
    plural: "ACTION_CONSTRAINTS",
    field: "actionConstraints",
    undefinedNoun: "action constraint"
  }
]) {
  SECTIONS.set(section.key, section);
  if (section.plural) SECTIONS.set(section.plural, section);
}
var NAME = /^\w*[A-Za-z]\w*$/;
var WORD = /\w+/y;
var CONFIG_HOLDS = "A config can hold only names, numbers, strings, comments, and the symbols { } ( ) [ ] , = ! <-.";
var shown = (c) => {
  const code2 = c.codePointAt(0) ?? 0;
  const hex = `U+${code2.toString(16).toUpperCase().padStart(4, "0")}`;
  if (code2 < 32 || code2 === 127) return hex;
  return code2 < 127 ? `"${c}"` : `"${c}" (${hex})`;
};
function tokenizeConfig(text, cannot) {
  if (text.startsWith("\uFEFF"))
    throw cannot(1, "The file starts with a byte order mark. Save it as UTF-8 without one.");
  const tokens = [];
  let line = 1;
  let last = 1;
  let i = 0;
  const skip = (to) => {
    for (; i < to; i++) {
      last = line;
      if (text[i] === "\n" || text[i] === "\r" && text[i + 1] !== "\n") line++;
    }
  };
  const push = (image) => {
    tokens.push({ image, line });
    skip(i + image.length);
  };
  while (i < text.length) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    const start = line;
    if (c === " " || c === "	" || c === "\n" || c === "\r") skip(i + 1);
    else if (two === "\\*") {
      const end = text.slice(i).search(/[\n\r]/);
      skip(end < 0 ? text.length : i + end);
    } else if (two === "(*") {
      const marks = /\(\*|\*\)/g;
      let depth = 0;
      do {
        marks.lastIndex = i;
        const m = marks.exec(text);
        if (!m) throw cannot(start, "A comment starts here and does not end.");
        depth += m[0] === "(*" ? 1 : -1;
        skip(m.index + 2);
      } while (depth);
    } else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') {
        const ch = text[j];
        if (ch === void 0) throw cannot(start, "A string starts here and does not end.");
        if (ch === "\n" || ch === "\r")
          throw cannot(
            start,
            "A string starts here and does not end on its line. Write \\n for a line break in a string."
          );
        if (ch === "\0") throw cannot(start, "A string has the character U+0000.");
        if (ch === "\\" && text[j + 1] !== void 0 && !'"\\ntrf'.includes(text[j + 1]))
          throw cannot(
            start,
            `A string has a backslash before ${shown(text[j + 1])}. A string can use only the escapes \\" \\\\ \\n \\t \\r \\f.`
          );
        j += ch === "\\" ? 2 : 1;
      }
      push(text.slice(i, j + 1));
    } else if (/\w/.test(c)) {
      WORD.lastIndex = i;
      const word = WORD.exec(text)?.[0] ?? c;
      if (/^[WS]F_/.test(word))
        throw cannot(
          start,
          `TLC reads ${word.slice(0, 3)} at the start of a word as a TLA+ keyword, so it cannot read ${word} as a name.`
        );
      if (!/[A-Za-z]/.test(word) && word !== "_") {
        if (/\D/.test(word))
          throw cannot(
            start,
            `TLC splits ${word} into ${word.match(/\d+|_/g)?.join(" ")}, because a name needs a letter.`
          );
        if (Number(word) > 2147483647)
          throw cannot(start, `TLC cannot read a number above 2147483647, such as ${word}.`);
      }
      push(word);
    } else if (two === "<-") push(two);
    else if (["[]", "]_", "==", "=<", "!!"].includes(two))
      throw cannot(start, `TLC reads ${two} as one TLA+ symbol, and a config cannot hold it.`);
    else if ("{}()[],=!".includes(c)) push(c);
    else {
      const ch = String.fromCodePoint(text.codePointAt(i) ?? 0);
      const where = ch > "\x7F" ? " outside a string" : "";
      throw cannot(start, `It cannot read the character ${shown(ch)}${where}. ${CONFIG_HOLDS}`);
    }
  }
  return { tokens, end: last };
}
function readConfig({ file, text }) {
  const refuse = (line, words) => new Error(`TLC refuses the config ${file} at line ${line}. ${words}`);
  const cannot = (line, words) => new Error(`The command cannot read the config ${file} at line ${line}. ${words}`);
  const { tokens, end } = tokenizeConfig(text, cannot);
  const eof = { image: "", line: end };
  let at = 0;
  const next = () => tokens[at++] ?? eof;
  let deferred;
  const defer = (error) => deferred ??= error;
  const defined = (t, undefinedNoun) => {
    if (!NAME.test(t.image))
      defer(
        refuse(
          t.line,
          `The ${undefinedNoun} ${t.image} specified in the configuration file is not defined in the specification.`
        )
      );
  };
  const name = (t, what) => {
    if (SECTIONS.has(t.image))
      defer(cannot(t.line, `TLC would read the keyword ${t.image} as ${what}.`));
    else if (!NAME.test(t.image))
      defer(cannot(t.line, `TLC would read ${t.image} as ${what}, and it is not a name.`));
  };
  const value = (t) => {
    if (t === eof) throw refuse(t.line, "It was expecting a value, but did not find it.");
    if (t.image === "{") {
      t = next();
      if (t.image === "}") return;
      value(t);
      while ((t = next()).image === ",") value(next());
      if (t.image !== "}") throw refuse(t.line, "It was expecting }, but did not find it.");
    } else if (SECTIONS.has(t.image))
      defer(cannot(t.line, `TLC would read the keyword ${t.image} as a value.`));
    else if (!NAME.test(t.image) && !/^(\d+|".*")$/.test(t.image))
      defer(
        cannot(
          t.line,
          `TLC would read ${t.image} as a value. A value is a name, a number, a string, or a set in braces.`
        )
      );
  };
  const constant = (t, loc) => {
    name(t, "a constant name");
    for (t = next(); t.image === "!"; t = next()) name(t = next(), "a constant name");
    if (t.image === "<-") {
      t = next();
      if (t.image === "[") {
        t = next();
        if (t === eof) throw refuse(t.line, "Expected an identifier after <-[.");
        name(t, "a module name");
        t = next();
        if (t.image !== "]") throw refuse(t.line, "It was expecting ], but did not find it.");
        t = next();
        if (t === eof) throw refuse(t.line, "Expected an identifier after <-[mod].");
      } else if (t === eof) throw refuse(t.line, "Expected an identifier after <-.");
      name(t, "the name after <-");
      return;
    }
    if (t.image === "(") {
      value(next());
      while ((t = next()).image === ",") value(next());
      if (t.image !== ")")
        throw refuse(
          loc,
          "TLC gives no reason here. An operator's arguments are one or more values in ( ), with commas between them."
        );
      t = next();
    }
    if (t.image !== "=") throw refuse(t.line, "It was expecting = or <-, but did not find it.");
    t = next();
    if (t.image === "[") {
      t = next();
      if (t === eof) throw refuse(t.line, "Expected an identifier after =[.");
      name(t, "a module name");
      t = next();
      if (t.image !== "]") throw refuse(t.line, "It was expecting ], but did not find it.");
      t = next();
    }
    value(t);
  };
  const config = {
    sections: [],
    invariants: [],
    properties: [],
    constraints: [],
    actionConstraints: []
  };
  for (let t = next(); t !== eof; ) {
    const keyword = t;
    const section = SECTIONS.get(keyword.image);
    if (!section) throw refuse(t.line, "It was expecting a keyword, but did not find it.");
    const { key: key2, field, undefinedNoun } = section;
    const begin = at;
    if (field === void 0) {
      for (t = next(); t !== eof && !SECTIONS.has(t.image); t = next()) constant(t, keyword.line);
    } else if (isListField(field)) {
      for (t = next(); t !== eof && !SECTIONS.has(t.image); t = next()) {
        config[field].push(t.image);
        defined(t, undefinedNoun);
      }
    } else {
      t = next();
      if (t === eof)
        throw refuse(
          keyword.line,
          `The keyword ${keyword.image} was not followed by an identifier.`
        );
      if (field === "checkDeadlock" && t.image !== "TRUE" && t.image !== "FALSE")
        throw refuse(t.line, "It was expecting TRUE or FALSE, but did not find it.");
      if (config[field] !== void 0)
        throw refuse(keyword.line, `The keyword ${keyword.image} appeared twice.`);
      if (field === "checkDeadlock") config[field] = t.image === "TRUE";
      else {
        config[field] = t.image;
        if (SECTIONS.has(t.image))
          defer(cannot(t.line, `TLC would read the keyword ${t.image} as the name after ${key2}.`));
        else if (undefinedNoun) defined(t, undefinedNoun);
      }
      t = next();
    }
    const images = [];
    for (let k = begin; k < (t === eof ? tokens.length : at - 1); k++) images.push(tokens[k].image);
    config.sections.push({ key: key2, line: keyword.line, tokens: images });
  }
  if (deferred) throw deferred;
  return config;
}

// skills/statechart/scripts/frontends/value.ts
var BRACKET = new Int8Array(128);
for (const c of "<{[(") BRACKET[c.charCodeAt(0)] = 1;
for (const c of ">}])") BRACKET[c.charCodeAt(0)] = -1;
var PUNCT = /* @__PURE__ */ new Map([
  [60, "<<"],
  [62, ">>"],
  [124, "|->"],
  [58, ":>"],
  [64, "@@"],
  [46, ".."]
]);
var SPACE = /\s/;
var isSpace = (c) => c === 32 || c >= 9 && c <= 13 || c > 127 && SPACE.test(String.fromCharCode(c));
var isDigit = (c) => c >= 48 && c <= 57;
var isWord = (c) => isDigit(c) || c >= 65 && c <= 90 || c >= 97 && c <= 122 || c === 95;
var isLineEnd = (c) => c === 10 || c === 13 || c === 8232 || c === 8233;
var tokenEnd = (s, i) => {
  const c = s.charCodeAt(i);
  if (c === 34) {
    for (let j2 = i + 1; j2 < s.length; j2++) {
      const d = s.charCodeAt(j2);
      if (d === 34) return j2 + 1;
      if (d === 92 && (++j2 >= s.length || isLineEnd(s.charCodeAt(j2)))) return -1;
    }
    return -1;
  }
  const punct = PUNCT.get(c);
  if (punct) return s.startsWith(punct, i) ? i + punct.length : -1;
  if (BRACKET[c] || c === 44) return i + 1;
  let j = i + 1;
  if (c === 45 || isDigit(c)) {
    while (isDigit(s.charCodeAt(j))) j++;
    return c === 45 && j === i + 1 ? -1 : j;
  }
  if (!isWord(c)) return -1;
  while (isWord(s.charCodeAt(j))) j++;
  return j;
};
var unreadable = (text, pos) => new Error(`cannot read TLA+ value at "${text.slice(pos, pos + 20)}"`);
var INT = /^-?\d+$/;
var NAME2 = /^\w*[A-Za-z]\w*$/;
var UNESCAPED = {
  '"': '"',
  "\\": "\\",
  n: "\n",
  t: "	",
  r: "\r",
  f: "\f"
};
var models = /* @__PURE__ */ new Map();
var model = (name) => {
  let v = models.get(name);
  if (v === void 0) models.set(name, v = { kind: "model", name });
  return v;
};
function parseValue(text) {
  const tokens = [];
  const starts = [];
  for (let pos = 0; ; ) {
    while (pos < text.length && isSpace(text.charCodeAt(pos))) pos++;
    if (pos === text.length) break;
    const end = tokenEnd(text, pos);
    if (end === -1) throw unreadable(text, pos);
    tokens.push(text.slice(pos, end));
    starts.push(pos);
    pos = end;
  }
  let i = 0;
  const fail = () => {
    throw unreadable(text, i < starts.length ? starts[Math.max(i - 1, 0)] : text.length);
  };
  const next = () => i < tokens.length ? tokens[i++] : fail();
  const eat = (t) => {
    if (next() !== t) fail();
  };
  const items = (close, item) => {
    const out2 = [];
    if (tokens[i] === close) {
      i++;
      return out2;
    }
    for (; ; ) {
      out2.push(item());
      const t = next();
      if (t === close) return out2;
      if (t !== ",") fail();
    }
  };
  const string = (t) => {
    let s = "";
    for (let j = 1, from = 1; ; ) {
      const k = t.indexOf("\\", j);
      if (k === -1 || k >= t.length - 1) return s + t.slice(from, -1);
      const c = UNESCAPED[t[k + 1]];
      if (c === void 0) fail();
      s += t.slice(from, k) + c;
      j = from = k + 2;
    }
  };
  const value = () => {
    const t = next();
    switch (t) {
      case "TRUE":
        return true;
      case "FALSE":
        return false;
      case "{":
        return { kind: "set", members: items("}", value) };
      case "<<": {
        const values = items(">>", value);
        const keys2 = [];
        for (let k = 1; k <= values.length; k++) keys2.push(k);
        return { kind: "function", printedAs: "tuple", keys: keys2, values };
      }
      case "[": {
        const keys2 = [];
        const values = [];
        items("]", () => {
          const name = next();
          if (!NAME2.test(name)) fail();
          eat("|->");
          keys2.push(name);
          values.push(value());
        });
        return { kind: "function", printedAs: "record", keys: keys2, values };
      }
      case "(": {
        const keys2 = [];
        const values = [];
        do {
          keys2.push(value());
          eat(":>");
          values.push(value());
        } while (next() === "@@");
        if (tokens[i - 1] !== ")") fail();
        return { kind: "function", printedAs: "pairs", keys: keys2, values };
      }
    }
    if (t.charCodeAt(0) === 34) return string(t);
    if (INT.test(t)) {
      if (tokens[i] !== "..") return Number(t);
      i++;
      const hi = next();
      if (!INT.test(hi)) fail();
      return { kind: "interval", lo: Number(t), hi: Number(hi) };
    }
    if (NAME2.test(t)) return model(t);
    return fail();
  };
  const out = value();
  if (i < tokens.length) {
    i++;
    fail();
  }
  return out;
}

// skills/statechart/scripts/frontends/dot.ts
var unescapeDot = (s) => {
  let i = s.indexOf("\\");
  if (i === -1) return s;
  let out = "";
  let from = 0;
  for (; i !== -1 && i + 1 < s.length; i = s.indexOf("\\", i)) {
    const c = s[i + 1];
    if (c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029") {
      i++;
      continue;
    }
    out += s.slice(from, i) + (c === "n" ? "\n" : c);
    i += 2;
    from = i;
  }
  return out + s.slice(from);
};
var parseState = (label, parsed = /* @__PURE__ */ new Map()) => {
  const pairs = [];
  for (const part of (label.startsWith("/\\ ") ? label.slice(3) : label).split("\n/\\ ")) {
    let pair = parsed.get(part);
    if (!pair) {
      const [, name, value] = /^(\w+)\s*=\s*([\s\S]*)$/.exec(part) ?? [];
      if (!name) throw new Error(`cannot read the TLC state line "${part}"`);
      parsed.set(part, pair = [name, parseValue(value)]);
    }
    pairs.push(pair);
  }
  return Object.fromEntries(pairs);
};
var linesOf = (input) => typeof input === "string" ? input.split("\n") : input;
function parseDot(input) {
  const states = /* @__PURE__ */ new Map();
  const steps = /* @__PURE__ */ new Map();
  const parsed = /* @__PURE__ */ new Map();
  const owned = /* @__PURE__ */ new Map();
  const own = (s) => {
    let copy = owned.get(s);
    if (copy === void 0) owned.set(copy = String(JSON.parse(JSON.stringify(s))), copy);
    return copy;
  };
  for (const line of linesOf(input)) {
    const edge = /^(-?\d+) -> (-?\d+) \[label="([^"]*)"/.exec(line);
    if (edge) {
      steps.set(edge.slice(1).join(" "), {
        from: own(edge[1]),
        to: own(edge[2]),
        action: own(edge[3])
      });
      continue;
    }
    const node = /^(-?\d+) \[label="((?:[^"\\]|\\.)*)"(,style = filled)?/.exec(line);
    if (node)
      states.set(own(node[1]), {
        vars: parseState(unescapeDot(node[2]), parsed),
        start: !!node[3],
        breaks: []
      });
  }
  for (const loose of steps.values())
    if (!states.has(loose.from) || !states.has(loose.to))
      throw new Error(
        `The TLC graph dump has a step ${loose.action} to or from a state that it does not list.`
      );
  return { states, steps: [...steps.values()] };
}

// skills/statechart/scripts/frontends/messages.ts
var START = /@!@!@STARTMSG (\d+):(\d+) @!@!@$/;
var END = /^@!@!@ENDMSG \d+ @!@!@$/;
var isCutMarker = (lastLine) => lastLine.startsWith("@!@!@");
function cutMessage(open) {
  for (let i = open.length - 1; i > 0 && !open[i].body.length; i--) open[i - 1].body.pop();
  return open[0]?.body.length ? open[0] : void 0;
}
function* readMessages(tlcOut) {
  const lines = linesOf(tlcOut)[Symbol.iterator]();
  const open = [];
  try {
    for (let next = lines.next(); !next.done; ) {
      const line = next.value;
      next = lines.next();
      if (next.done && (!line || isCutMarker(line))) break;
      const start = START.exec(line);
      if (start) {
        const message = { code: Number(start[1]), level: Number(start[2]), body: [] };
        if (start.index) message.beforeMarker = line.slice(0, start.index);
        open.at(-1)?.body.push(message);
        open.push(message);
      } else if (END.test(line)) {
        const done = open.pop();
        if (done && !open.length) yield done;
      } else if (open.length) open[open.length - 1].body.push(line);
      else yield line;
    }
  } finally {
    lines.return?.();
  }
  const cut = cutMessage(open);
  if (cut) yield cut;
}
var textOf = ({ body }) => body.filter((part) => typeof part === "string").join("\n");
var actionOf = (m) => /^\d+: (?:Back to state: )?<([^\s>]+)/.exec(textOf(m))?.[1];
var messageState = (m) => {
  const lines = textOf(m).split("\n");
  const body = [];
  for (let i = 1; i < lines.length && lines[i].trim(); i++) body.push(lines[i]);
  return parseState(body.join("\n"));
};

// skills/statechart/scripts/frontends/marks.ts
var markTexts = (chunk, top, inner) => {
  if (top.length !== 2) return void 0;
  const [a, b] = top;
  const open = chunk.indexOf("<<", a);
  const close = chunk.lastIndexOf(">>", b);
  const end = chunk.trimEnd().length - 2;
  if (open < 0 || chunk.slice(a + 1, open).trim() || chunk.slice(close + 2, b).trim())
    return void 0;
  if (!chunk.startsWith(">>", end)) return void 0;
  const cuts = [open + 1];
  for (const k of inner) if (k > open && k < close) cuts.push(k);
  cuts.push(close);
  const texts = [];
  for (let k = 1; k < cuts.length; k++) texts.push(chunk.slice(cuts[k - 1] + 1, cuts[k]));
  return { values: texts, rules: chunk.slice(b + 1, end) };
};
var ruleNames = (v) => {
  if (typeof v !== "object" || v.kind !== "set") return void 0;
  const names2 = [];
  for (const m of v.members) {
    if (typeof m !== "string") return void 0;
    names2.push(m);
  }
  return names2;
};
function* readMarks(messages, tag) {
  const read = memo(parseValue);
  const start = `"${tag}",`;
  let chunk = "";
  let depth = 0;
  let top = [];
  let inner = [];
  for (const line of messages) {
    if (typeof line !== "string") continue;
    if (!chunk) {
      if (!line.startsWith("<<") || !line.slice(2).trimStart().startsWith(start)) continue;
      depth = 0;
      top = [];
      inner = [];
    }
    const base = chunk.length;
    chunk += line + "\n";
    let i = 0;
    let last = 0;
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (isSpace(c)) {
        i++;
        continue;
      }
      const j = tokenEnd(line, i);
      if (j === -1) throw unreadable(line + "\n", last);
      if (c === 44 && depth === 1) top.push(base + i);
      else if (c === 44 && depth === 2) inner.push(base + i);
      depth += BRACKET[c];
      i = last = j;
    }
    if (depth > 0) continue;
    const texts = markTexts(chunk, top, inner);
    const values = [];
    if (texts) for (const v of texts.values) values.push(read(v));
    const broken = texts && ruleNames(read(texts.rules));
    if (!broken)
      throw new Error(`TLC printed a mark that the command cannot read:
${chunk.slice(0, 2e3)}`);
    chunk = "";
    yield { values, broken };
  }
  if (chunk)
    throw new Error(
      `TLC's output ends inside a marked state, so the command cannot tell which rules it breaks:
${chunk.slice(0, 2e3)}`
    );
}
function readCounterexample(messages) {
  const trace = [];
  for (const m of messages) {
    if (typeof m === "string") continue;
    const action = m.code === EC.TLC_STATE_PRINT2 ? actionOf(m) : void 0;
    if (action !== void 0) trace.push({ action, vars: messageState(m) });
    else if (m.code === EC.TLC_INVARIANT_VIOLATED_INITIAL || m.code === EC.TLC_PROPERTY_VIOLATED_INITIAL)
      trace.push({ action: "", vars: messageState(m) });
  }
  return trace;
}

// skills/statechart/scripts/frontends/spec.ts
function readChecks({ configFile: configFile2, config }) {
  const refuse = (words) => new Error(`TLC refuses the config ${configFile2}. ${words}`);
  if (config.spec && (config.init || config.next))
    throw refuse("The configuration file cannot specify both INIT/NEXT and SPECIFICATION fields.");
  if (!config.spec && !config.init)
    throw refuse("The configuration file did not specify the initial state predicate.");
  const written = [];
  for (const s of config.sections)
    if (!["INVARIANT", "PROPERTY", "CHECK_DEADLOCK"].includes(s.key)) written.push(s);
  return {
    invariants: config.invariants,
    properties: config.properties,
    deadlock: config.checkDeadlock !== false,
    written
  };
}
var ENTITIES = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
var decode = (text) => text.replace(
  /&(#x?)?(\w+);/g,
  (_, number, name) => number ? String.fromCodePoint(Number.parseInt(name, number === "#x" ? 16 : 10)) : ENTITIES[name]
);
function parseXml(xml) {
  const document = { tag: "", text: "", children: [] };
  const open = [document];
  for (const [, close, tag, empty, text] of xml.matchAll(
    /<(\/?)([^\s/>?!]+)[^>]*?(\/?)>|<[?!][^>]*>|([^<]+)/g
  )) {
    const parent = open[open.length - 1];
    if (text !== void 0) parent.text += decode(text);
    else if (close) open.pop();
    else if (tag) {
      const node = { tag, text: "", children: [] };
      parent.children.push(node);
      if (!empty) open.push(node);
    }
  }
  return document;
}
var child = (node, tag) => node?.children.find((c) => c.tag === tag);
var textOf2 = (node, tag) => child(node, tag)?.text ?? "";
var VARIABLE_KIND = "3";
function readSany(xml) {
  const modules = child(parseXml(xml), "modules");
  const symbols = /* @__PURE__ */ new Map();
  for (const entry of child(modules, "context")?.children ?? [])
    symbols.set(textOf2(entry, "UID"), entry.children[1]);
  const root = textOf2(modules, "RootModule");
  const moduleNames = /* @__PURE__ */ new Set();
  let module;
  for (const node of symbols.values())
    if (node.tag === "ModuleNode") {
      moduleNames.add(textOf2(node, "uniquename"));
      if (textOf2(node, "uniquename") === root) module = node;
    }
  const definitions = /* @__PURE__ */ new Map();
  const variables = [];
  for (const ref of module?.children ?? []) {
    if (ref.tag === "InstanceNode") {
      definitions.set(textOf2(ref, "uniquename"), ref);
      continue;
    }
    if (ref.tag !== "OpDeclNodeRef" && ref.tag !== "UserDefinedOpKindRef") continue;
    const uid = textOf2(ref, "UID");
    const node = symbols.get(uid);
    if (!node) continue;
    const name = textOf2(node, "uniquename");
    definitions.set(name, node);
    if (node.tag === "OpDeclNode" && textOf2(node, "kind") === VARIABLE_KIND)
      variables.push({ uid: Number(uid), name });
  }
  variables.sort((a, b) => a.uid - b.uid);
  return { variables: variables.map((v) => v.name), definitions, modules: moduleNames };
}
function readSpec({
  module,
  sany,
  checks
}) {
  return { module, variables: sany.variables, ...checks };
}
var STATE_LEVEL = 1;
function initialOnlyProperties({ definitions }, { written, properties }) {
  const replaced = /* @__PURE__ */ new Map();
  for (const s of written)
    if (s.key === "CONSTANT") {
      for (let i = 1; i + 1 < s.tokens.length; i++)
        if (s.tokens[i] === "<-" && NAME.test(s.tokens[i + 1]))
          replaced.set(s.tokens[i - 1], s.tokens[i + 1]);
    }
  const names2 = /* @__PURE__ */ new Set();
  for (const name of properties) {
    const definition = definitions.get(replaced.get(name) ?? name);
    if (definition && Number(textOf2(definition, "level")) <= STATE_LEVEL) names2.add(name);
  }
  return names2;
}

// skills/statechart/scripts/frontends/trace.ts
function readTrace(messages) {
  const seq = [];
  for (const m of messages) {
    if (typeof m === "string") continue;
    if (m.code === EC.TLC_STATE_PRINT3) return { seq, loop: seq.length - 1 };
    const back = m.code === EC.TLC_BACK_TO_STATE && /^(\d+): Back to state: /.exec(textOf(m));
    if (back) {
      const loop = Number(back[1]) - 1;
      seq.push({ action: actionOf(m) ?? "", vars: seq[loop]?.vars });
      return { seq, loop };
    }
    const action = m.code === EC.TLC_STATE_PRINT2 ? actionOf(m) : void 0;
    if (action !== void 0) seq.push({ action, vars: messageState(m) });
    else if (m.code === EC.TLC_INVARIANT_VIOLATED_INITIAL || m.code === EC.TLC_PROPERTY_VIOLATED_INITIAL)
      seq.push({ action: "", vars: messageState(m) });
  }
  return { seq, loop: void 0 };
}

// skills/statechart/scripts/frontends/verdict.ts
var NAMED = /* @__PURE__ */ new Map([
  [EC.TLC_INVARIANT_VIOLATED_INITIAL, ["invariant", /^Invariant (.+) is violated by the initial/]],
  [EC.TLC_INVARIANT_VIOLATED_BEHAVIOR, ["invariant", /^Invariant (.+) is violated\.$/m]],
  [EC.TLC_PROPERTY_VIOLATED_INITIAL, ["property", /^Property (.+) is violated by the initial/]],
  [EC.TLC_ACTION_PROPERTY_VIOLATED_BEHAVIOR, ["property", /^Action property (.+) is violated\.$/m]]
]);
var DISTINCT = /* @__PURE__ */ new Map([
  [EC.TLC_INIT_GENERATED1, /(\d+) distinct states? generated/],
  [EC.TLC_INIT_GENERATED2, /with (\d+) of them distinct/],
  [EC.TLC_STATS, /(\d+) distinct states found/]
]);
function readVerdict(messages) {
  let broke;
  let distinct = 0;
  let initial = 0;
  for (const m of messages) {
    if (typeof m === "string") continue;
    const count2 = DISTINCT.get(m.code)?.exec(textOf(m));
    if (count2) distinct = Math.max(distinct, Number(count2[1]));
    if (m.code === EC.TLC_INIT_GENERATED1 || m.code === EC.TLC_INIT_GENERATED2)
      initial = Number(/(\d+) (?:distinct )?states? generated/.exec(textOf(m))?.[1] ?? 0);
    if (broke) continue;
    if (m.code === EC.TLC_DEADLOCK_REACHED) broke = { kind: "deadlock" };
    else if (m.code === EC.TLC_TEMPORAL_PROPERTY_VIOLATED) broke = { kind: "temporal" };
    const named = NAMED.get(m.code);
    const name = named?.[1].exec(textOf(m))?.[1];
    if (named && name) broke = { kind: named[0], name };
  }
  return { broke, distinct, initial };
}

// skills/statechart/scripts/passes/annotate.ts
var finder = (graph, names2) => {
  let ids;
  const find = (values) => {
    if (!ids) {
      ids = /* @__PURE__ */ new Map();
      for (const [id, s] of graph.states)
        if (!s.excluded) ids.set(stateKey(valuesOf(s.vars, names2)), id);
    }
    return ids.get(stateKey(values));
  };
  find.add = (id, values) => ids?.set(stateKey(values), id);
  return find;
};
function mark(graph, marks, names2, rules, find = finder(graph, names2)) {
  const byName = /* @__PURE__ */ new Map();
  for (const rule of rules) byName.set(rule.name, rule);
  const past = /* @__PURE__ */ new Map();
  for (const { values, broken } of marks) {
    const id = find(values);
    const state = id === void 0 ? void 0 : graph.states.get(id);
    for (const name of broken) {
      const rule = must(byName, name);
      if (state) state.breaks.push(rule);
      else past.set(stateKey(values), (past.get(stateKey(values)) ?? /* @__PURE__ */ new Set()).add(rule));
    }
  }
  return past;
}
function deadEnds(graph, rule) {
  const from = /* @__PURE__ */ new Set();
  for (const t of graph.steps) from.add(t.from);
  for (const [id, s] of graph.states) if (!s.past && !from.has(id)) s.breaks.push(rule);
}
function addPast(graph, counterexample, names2, rule, past, excludes, find = finder(graph, names2)) {
  const trace = findTrace(counterexample, names2, rule, find);
  const end = trace.length - 1;
  const from = trace[end - 1]?.id;
  const action = trace[end].action;
  const taken = (to2) => {
    for (const t of graph.steps)
      if (t.from === from && t.to === to2 && t.action === action) return true;
    return false;
  };
  let to = trace[end].id;
  const reached = to === void 0 ? void 0 : graph.states.get(to);
  const excluded = excludes && reached !== void 0 && end > 0 && !reached.past && !taken(to);
  if (excluded) to = `past ${to} ${action} ${from}`;
  to ??= `past ${graph.states.size}`;
  let last = graph.states.get(to);
  if (!last) {
    const marked = excluded ? reached.breaks : past.get(stateKey(trace[end].values)) ?? [];
    last = pastState(trace[end].vars, end === 0, marked, excluded);
    graph.states.set(to, last);
    if (!excluded) find.add(to, trace[end].values);
  }
  if (!hasRule(last.breaks, rule)) last.breaks.push(rule);
  (last.ends ??= []).push(rule);
  if (from !== void 0 && last.past && !taken(to)) graph.steps.push({ from, to, action });
}
function lasso(graph, trace, names2, find = finder(graph, names2)) {
  const { seq, loop } = findLoop(trace, names2, find);
  const start = seq[0]?.id;
  if (start === void 0) return void 0;
  const out = /* @__PURE__ */ new Map();
  for (const s of seq) out.set(s.id, []);
  for (const t of graph.steps) out.get(t.from)?.push(t);
  const route = [];
  for (let i = 1; i < seq.length; i++) {
    let step;
    for (const t of out.get(seq[i - 1].id) ?? [])
      if (t.to === seq[i].id && t.action === seq[i].action) {
        step = t;
        break;
      }
    if (!step) return void 0;
    route.push({ action: step.action, state: step.to, step });
  }
  const stutters = loop === seq.length - 1;
  return {
    start,
    path: route,
    loop,
    stutters
  };
}

// skills/statechart/scripts/passes/paths.ts
function pathGraph(names2) {
  const graph = { states: /* @__PURE__ */ new Map(), steps: [] };
  const ids = /* @__PURE__ */ new Map();
  const taken = /* @__PURE__ */ new Map();
  const idOf = (vars, start) => {
    if (!vars) throw new Error("TLC's trace has a state with no values.");
    const k = stateKey(names2.map((name) => vars[name]));
    let id = ids.get(k);
    if (id === void 0) {
      ids.set(k, id = String(ids.size));
      graph.states.set(id, { vars, start, breaks: [] });
    } else if (start) must(graph.states, id).start = true;
    return id;
  };
  const route = (seq) => {
    const start = idOf(seq[0].vars, true);
    const path3 = [];
    let from = start;
    for (let i = 1; i < seq.length; i++) {
      const { action } = seq[i];
      const to = idOf(seq[i].vars, false);
      const k = `${from} ${to} ${action}`;
      let step = taken.get(k);
      if (!step) {
        taken.set(k, step = { from, to, action });
        graph.steps.push(step);
      }
      path3.push({ action, state: to, step });
      from = to;
    }
    return { start, path: path3 };
  };
  return {
    graph,
    bug: (rule, trace) => {
      if (!trace.length) throw new Error(`TLC's trace for ${rule.name} has no states.`);
      const bug = { rule, ...route(trace) };
      const end = must(graph.states, bug.path.at(-1)?.state ?? bug.start);
      if (!hasRule(end.breaks, rule)) end.breaks.push(rule);
      return bug;
    },
    lasso: ({ seq, loop }) => seq.length ? { ...route(seq), loop, stutters: loop === seq.length - 1 } : void 0
  };
}

// skills/statechart/scripts/run.ts
function* fileLines(file) {
  const fd = fs.openSync(file, "r");
  try {
    let buf = Buffer.allocUnsafe(PART);
    let kept = 0;
    for (; ; ) {
      if (kept === buf.length) buf = Buffer.concat([buf], buf.length * 2);
      const n = fs.readSync(fd, buf, kept, buf.length - kept, null);
      if (!n) break;
      const end = kept + n;
      const cut = buf.lastIndexOf(10, end - 1);
      if (cut === -1) {
        kept = end;
        continue;
      }
      yield* buf.toString("utf8", 0, cut).split("\n").map(
        (line) => line.endsWith("\r") ? line.slice(0, -1) : line
      );
      kept = buf.copy(buf, 0, cut + 1, end);
    }
    const last = buf.toString("utf8", 0, kept);
    yield last.endsWith("\r") ? last.slice(0, -1) : last;
  } finally {
    fs.closeSync(fd);
  }
}
var PINNED_FLAGS = ["-workers", "1", "-fp", "0", "-lncheck", "final"];
function requirePosix(platform = process.platform) {
  if (platform === "win32" || !fs.existsSync("/bin/sh"))
    throw new Error(
      "The statechart CLI requires POSIX /bin/sh and process groups; Windows is not supported. Use an approved POSIX environment. The pure parser and compiler tests remain portable."
    );
}
var messageOf = (error) => typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : inspect(error);
var joined2 = (files) => {
  const fds = [];
  const sizes = [];
  for (const f of files) {
    const fd = fs.openSync(f, "r");
    fds.push(fd);
    sizes.push(fs.fstatSync(fd).size);
  }
  return {
    *[Symbol.iterator]() {
      for (let f = 0; f < fds.length; f++)
        for (let pos = 0; pos < sizes[f]; ) {
          const buf = Buffer.allocUnsafe(Math.min(PART, sizes[f] - pos));
          const n = fs.readSync(fds[f], buf, 0, buf.length, pos);
          if (!n) break;
          pos += n;
          yield buf.subarray(0, n);
        }
    }
  };
};
var utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
function* outputLines(output) {
  let rest = new Uint8Array(0);
  for (const part of output) {
    const buf = rest.length ? Buffer.concat([rest, part]) : part;
    const cut = buf.lastIndexOf(10);
    if (cut === -1) {
      rest = buf;
      continue;
    }
    yield* utf8.decode(buf.subarray(0, cut)).split("\n");
    rest = buf.subarray(cut + 1);
  }
  yield utf8.decode(rest);
}
var messagesOf = (output) => ({
  [Symbol.iterator]: () => readMessages(outputLines(output))
});
var runToFiles = (file, args, { out, ...options }) => new Promise((resolve) => {
  const files = [`${out}.stdout`, `${out}.stderr`];
  const fds = [];
  for (const f of files) fds.push(fs.openSync(f, "w"));
  let child2;
  try {
    child2 = spawn(file, args, { ...options, stdio: ["ignore", ...fds] });
  } finally {
    for (const fd of fds) fs.closeSync(fd);
  }
  let error;
  const settle = (code2) => resolve({
    status: error ? null : code2,
    stdout: files[0],
    output: joined2(files),
    error
  });
  child2.on("error", (e) => {
    error = e;
    if (child2.pid === void 0) settle(null);
  });
  child2.on("close", (code2) => {
    if (child2.pid !== void 0) settle(code2);
  });
});
function findTlc() {
  const { TLA2TOOLS, JAVA } = process.env;
  if (!TLA2TOOLS)
    throw new Error(
      "Cannot find TLC: set TLA2TOOLS to an existing tla2tools.jar (official TLC 1.7.4 recommended), and JAVA to an existing Java 11+ binary if java is not on PATH. No tools were installed. Obtain user approval before downloading TLC or installing Java."
    );
  return { jar: path.resolve(TLA2TOOLS), java: JAVA || "java" };
}
var exitClass = (status) => status === 0 ? 0 : status === 11 || status === 12 || status === 13 ? 1 : 2;
var tail = (r) => {
  if (r.error) return r.error.message;
  const kept = [];
  let size = 0;
  for (const chunk of plainText(messagesOf(r.output))) {
    kept.push(chunk);
    size += chunk.length;
    while (size - kept[0].length >= 1 << 28) size -= kept.shift().length;
  }
  return kept.join("").trim().split("\n").slice(-30).join("\n");
};
var stopOf = (r) => {
  const errors = [];
  for (const m of r.error ? [] : messagesOf(r.output))
    if (typeof m !== "string" && (m.level === LEVEL.ERROR || m.level === LEVEL.TLCBUG || errors.length && m.level === LEVEL.STATE))
      errors.push(m);
  if (!errors.length) return { status: r.status, message: tail(r) };
  const lines = [...plainText(errors)].join("").trim().split("\n");
  if (lines.length > 40) lines.splice(40, Infinity, `... ${lines.length - 40} more lines`);
  return { status: r.status, message: lines.join("\n") };
};
var names = (rules, kind) => {
  const found = [];
  for (const rule of rules) if (rule.kind === kind) found.push(rule.name);
  return found;
};
var brokenRule = (rules, broke) => {
  if (broke.kind === "temporal") return void 0;
  for (const rule of rules)
    if (rule.kind === broke.kind && (broke.kind === "deadlock" || rule.name === broke.name))
      return rule;
  if (broke.kind === "invariant") {
    for (const rule of rules) if (rule.kind === "property" && rule.name === broke.name) return rule;
  }
  return void 0;
};
function* only(marks, rules) {
  for (const { values, broken } of marks) {
    const kept = [];
    for (const name of broken) if (rules.has(name)) kept.push(name);
    if (kept.length) yield { values, broken: kept };
  }
}
async function check(specFile2, configFile2) {
  requirePosix();
  const tlc = findTlc();
  const cfg = readConfig({ file: configFile2, text: fs.readFileSync(configFile2, "utf8") });
  const checks = readChecks({ configFile: configFile2, config: cfg });
  const folder = path.dirname(path.resolve(specFile2));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statechart-"));
  try {
    const config = (name, sections, extra) => {
      fs.writeFileSync(path.join(dir, `${name}.cfg`), configText(sections, extra));
      return [`-metadir`, path.join(dir, `meta-${name}`), "-config", path.join(dir, `${name}.cfg`)];
    };
    const runJava = (name, main, args, jvm = []) => {
      const tmp = path.join(dir, `tmp-${name}`);
      fs.mkdirSync(tmp);
      return runToFiles(
        tlc.java,
        [
          `-Djava.io.tmpdir=${tmp}`,
          `-DTLA-Library=${folder}`,
          ...jvm,
          "-cp",
          tlc.jar,
          main,
          ...args
        ],
        {
          cwd: dir,
          out: path.join(dir, name),
          env: process.platform === "darwin" ? process.env : { ...process.env, LC_ALL: "C.UTF-8" }
        }
      );
    };
    const xml = await runJava(
      "sany",
      "tla2sany.xml.XMLExporter",
      ["-o", "-I", folder, path.resolve(specFile2)],
      ["-XX:TieredStopAtLevel=1"]
    );
    if (xml.error)
      throw new Error(
        `Cannot start Java ${tlc.java}: ${xml.error.message}. Use an existing JAVA binary or obtain user approval before installing Java. No tools were installed.`
      );
    if (xml.status !== 0)
      throw new Error(`SANY could not read ${specFile2} (exit ${xml.status}):
${tail(xml)}`);
    const sany = readSany(fs.readFileSync(xml.stdout, "utf8"));
    const module = path.basename(specFile2, ".tla");
    const spec = { ...readSpec({ module, sany, checks }), folder };
    const boundedModule = helperName("ChartBound", sany.modules);
    const ops = helperOperators(sany.definitions.keys());
    const rules = stateRules(spec);
    const all = [...rules];
    for (const name of spec.properties) all.push({ kind: "property", name });
    const verdicts = /* @__PURE__ */ new Map();
    const decide = (rule, outcome, r) => verdicts.set(ruleKey(rule), { rule, outcome, messages: r && messagesOf(r.output) });
    const judge = async () => {
      const groups = [all];
      let first;
      let stop;
      const states = { distinct: 0, initial: 0, complete: false, cut: false };
      for (let k = 1; groups.length; ) {
        const group = [];
        for (const rule2 of groups[0]) if (!verdicts.has(ruleKey(rule2))) group.push(rule2);
        if (first && !group.length) {
          groups.shift();
          continue;
        }
        const name = `verdict-${k++}`;
        const extra = [];
        const invariants = names(group, "invariant");
        const properties = names(group, "property");
        if (invariants.length) extra.push(`INVARIANT ${invariants.join(" ")}`);
        if (properties.length) extra.push(`PROPERTY ${properties.join(" ")}`);
        const bounded = first !== void 0 && !states.complete;
        if (bounded) extra.push(`CONSTRAINT ${ops.bound}`);
        const r = await runJava(name, "tlc2.TLC", [
          "-tool",
          ...PINNED_FLAGS,
          ...names(group, "deadlock").length ? [] : ["-deadlock"],
          ...config(name, spec.written, extra),
          bounded ? boundedModule : spec.module
        ]);
        first ??= r;
        const { broke, distinct, initial } = readVerdict(messagesOf(r.output));
        states.distinct = Math.max(states.distinct, distinct);
        states.initial = Math.max(states.initial, initial);
        const rule = broke && brokenRule(group, broke);
        const cut = bounded && distinct >= RERUN_STATES;
        if (exitClass(r.status) === 2) {
          stop = stopOf(r);
          break;
        } else if (rule) decide(rule, "broken", r);
        else if (cut && (r.status === 0 || broke?.kind === "temporal")) {
          states.cut = true;
          for (const rule2 of group) decide(rule2, "not checked");
        } else if (r.status === 0) {
          states.complete = true;
          for (const rule2 of group) decide(rule2, "holds");
        } else if (broke && properties.length) {
          if (broke.kind === "temporal") {
            states.complete = true;
            for (const rule2 of group) if (rule2.kind !== "property") decide(rule2, "holds");
          }
          const pending = [];
          const rest = [];
          for (const rule2 of group)
            if (rule2.kind === "property") pending.push([rule2]);
            else if (!verdicts.has(ruleKey(rule2))) rest.push(rule2);
          if (pending.length === 1) decide(pending[0][0], "broken", r);
          else groups.splice(0, 1, rest, ...pending);
        } else
          throw new Error(
            `TLC exited ${r.status} on ${specFile2}, but its output names no rule that broke:
${tail(r)}`
          );
      }
      for (const rule of all) if (!verdicts.has(ruleKey(rule))) decide(rule, "not checked");
      return { first, stop, states };
    };
    fs.writeFileSync(
      path.join(dir, `${boundedModule}.tla`),
      boundRun(spec.module, boundedModule, ops)
    );
    const judged = await judge();
    const exit = exitClass(judged.first.status);
    const failed = (r) => new Error(`TLC could not check ${specFile2} (exit ${r.status}):
${stopOf(r).message}`);
    const initialOnly = initialOnlyProperties(sany, spec);
    const propertiesWith = (bugOf) => {
      const properties = [];
      for (const rule of all) {
        if (rule.kind !== "property") continue;
        const v = must(verdicts, ruleKey(rule));
        properties.push({
          ...v,
          bug: v.outcome === "broken" && v.messages ? bugOf(readTrace(v.messages)) : void 0,
          initialOnly: initialOnly.has(rule.name)
        });
      }
      return properties;
    };
    if (exit === 2) throw failed(judged.first);
    const checked2 = [];
    for (const rule of rules) checked2.push(must(verdicts, ruleKey(rule)));
    const common = {
      spec,
      exit,
      stop: judged.stop,
      states: judged.states,
      messages: messagesOf(judged.first.output),
      rules: checked2
    };
    if (judged.states.distinct <= CHART_STATES) {
      const tag = `chart-${randomBytes(16).toString("hex")}`;
      const drawingModule = helperName("ChartRun", sany.modules);
      fs.writeFileSync(path.join(dir, `${drawingModule}.tla`), chartRun(spec, tag, drawingModule, ops));
      const drawn2 = await runJava("ChartRun", "tlc2.TLC", [
        "-tool",
        ...PINNED_FLAGS,
        "-deadlock",
        ...config("ChartRun", spec.written, [`INVARIANT ${ops.mark}`, `CONSTRAINT ${ops.budget}`]),
        "-dump",
        "dot,actionlabels",
        path.join(dir, "graph"),
        drawingModule
      ]);
      const file = path.join(dir, "graph.dot");
      if (!fs.existsSync(file)) throw failed(drawn2);
      if (readVerdict(messagesOf(drawn2.output)).distinct <= CHART_STATES) {
        const graph = parseDot(fileLines(file));
        const find = finder(graph, spec.variables);
        const drawing = drawn2.status === 0 ? void 0 : { status: drawn2.status };
        const broken = /* @__PURE__ */ new Set();
        for (const { rule, outcome } of verdicts.values())
          if (rule.kind === "invariant" && outcome === "broken") broken.add(rule.name);
        const marks = only(readMarks(readMessages(fileLines(drawn2.stdout)), tag), broken);
        const past = mark(graph, marks, spec.variables, rules, find);
        const excludes = hasSection(spec, "ACTION_CONSTRAINT");
        for (const rule of rules) {
          const { outcome, messages } = must(verdicts, ruleKey(rule));
          if (rule.kind === "deadlock" && outcome === "broken" && !drawing && !hasSection(spec, "CONSTRAINT", "ACTION_CONSTRAINT"))
            deadEnds(graph, rule);
          if (outcome !== "broken" || !messages) continue;
          const counterexample = readCounterexample(messages);
          if (!drawing || lasso(graph, { seq: counterexample, loop: void 0 }, spec.variables, find))
            addPast(graph, counterexample, spec.variables, rule, past, excludes, find);
        }
        const properties = propertiesWith((trace) => lasso(graph, trace, spec.variables, find));
        return {
          ...common,
          graph,
          paths: void 0,
          properties,
          drawing
        };
      }
    }
    const drawn = pathGraph(spec.variables);
    const paths = [];
    for (const rule of rules) {
      const { outcome, messages } = must(verdicts, ruleKey(rule));
      if (outcome === "broken" && messages)
        paths.push(drawn.bug(rule, readCounterexample(messages)));
    }
    return {
      ...common,
      graph: drawn.graph,
      paths,
      properties: propertiesWith(drawn.lasso),
      drawing: void 0
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// skills/statechart/scripts/worker.ts
var [stage, specFile, configFile, viewFile] = process.argv.slice(2);
try {
  const view = checkView(
    viewFile ? await import(pathToFileURL(path2.resolve(viewFile)).href) : {},
    inspect2
  );
  const { files, exit } = compile(await check(specFile, configFile), view);
  const draft = path2.join(stage, "draft");
  fs2.mkdirSync(draft);
  for (const [name, parts] of files) {
    const fd = fs2.openSync(path2.join(draft, name), "wx");
    try {
      for (const part of parts)
        fs2.writeSync(fd, typeof part === "string" ? Buffer2.from(part) : part);
      fs2.writeSync(fd, "\n");
    } finally {
      fs2.closeSync(fd);
    }
  }
  fs2.renameSync(draft, path2.join(stage, "done"));
  process.exit(exit);
} catch (error) {
  console.error(messageOf(error));
  process.exit(2);
}
