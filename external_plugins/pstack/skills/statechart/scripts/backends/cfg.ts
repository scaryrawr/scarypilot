import { CHART_STATES, type ConfigSection, RERUN_STATES, type Spec } from "../ir.ts";

export function configText(sections: ConfigSection[], extra: string[]) {
  const lines: string[] = [];

  for (const s of sections) lines.push(`${s.key} ${s.tokens.join(" ")}`);
  lines.push(...extra);

  return lines.join("\n");
}

export const boundName = (modules: ReadonlySet<string>) => {
  let name = "ChartBound";
  let suffix = 1;

  while (modules.has(name)) name = `ChartBound_${suffix++}`;

  return name;
};

export const boundRun = (module: string, name: string) =>
  [
    `---- MODULE ${name} ----`,
    `EXTENDS ${module}`,
    `ChartTLC == INSTANCE TLC`,
    `ChartNaturals == INSTANCE Naturals`,
    `ChartBound == ChartNaturals!<(ChartTLC!TLCGet("distinct"), ${RERUN_STATES})`,
    `====`,
  ].join("\n");

export function chartRun({ module, variables, invariants }: Spec, tag: string) {
  const every: string[] = [];

  for (const name of invariants) every.push(`(IF ~${name} THEN {"${name}"} ELSE {}) \\cup `);

  return [
    `---- MODULE ChartRun ----`,
    `EXTENDS ${module}`,
    `ChartTLC == INSTANCE TLC`,
    `ChartNaturals == INSTANCE Naturals`,
    `ChartBudget == ChartNaturals!<=(ChartTLC!TLCGet("distinct"), ${CHART_STATES})`,
    `ChartBroken == ${every.join("")}{}`,
    `ChartMark == ChartBroken = {} \\/ ChartTLC!PrintT(<<"${tag}", <<${variables.join(", ")}>>, ChartBroken>>)`,
    `====`,
  ].join("\n");
}
