import { CHART_STATES, type ConfigSection, RERUN_STATES, type Spec } from "../ir.ts";

export function configText(sections: ConfigSection[], extra: string[]) {
  const lines: string[] = [];

  for (const s of sections) lines.push(`${s.key} ${s.tokens.join(" ")}`);
  lines.push(...extra);

  return lines.join("\n");
}

export const helperName = (base: string, used: ReadonlySet<string>) => {
  let name = base;
  let suffix = 1;

  while (used.has(name)) name = `${base}_${suffix++}`;

  return name;
};

export function helperOperators(definitions: Iterable<string>) {
  const used = new Set(definitions);

  const take = (base: string) => {
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
    mark: take("ChartMark"),
  };
}

type HelperOperators = ReturnType<typeof helperOperators>;

export const boundRun = (module: string, name: string, ops: HelperOperators) =>
  [
    `---- MODULE ${name} ----`,
    `EXTENDS ${module}`,
    `${ops.tlc} == INSTANCE TLC`,
    `${ops.naturals} == INSTANCE Naturals`,
    `${ops.bound} == ${ops.naturals}!<(${ops.tlc}!TLCGet("distinct"), ${RERUN_STATES})`,
    `====`,
  ].join("\n");

export function chartRun(
  { module, variables, invariants }: Spec,
  tag: string,
  name: string,
  ops: HelperOperators,
) {
  const every: string[] = [];

  for (const name of invariants) every.push(`(IF ~${name} THEN {"${name}"} ELSE {}) \\cup `);

  return [
    `---- MODULE ${name} ----`,
    `EXTENDS ${module}`,
    `${ops.tlc} == INSTANCE TLC`,
    `${ops.naturals} == INSTANCE Naturals`,
    `${ops.budget} == ${ops.naturals}!<=(${ops.tlc}!TLCGet("distinct"), ${CHART_STATES})`,
    `${ops.broken} == ${every.join("")}{}`,
    `${ops.mark} == ${ops.broken} = {} \\/ ${ops.tlc}!PrintT(<<"${tag}", <<${variables.join(", ")}>>, ${ops.broken}>>)`,
    `====`,
  ].join("\n");
}
