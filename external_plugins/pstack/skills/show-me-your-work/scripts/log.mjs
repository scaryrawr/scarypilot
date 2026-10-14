import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

const [logfile, ...cells] = process.argv.slice(2);

if (!logfile || cells.length !== 5) {
  console.error("usage: node log.mjs <logfile> <phase> <decision> <why> <evidence> <result>");
  process.exitCode = 1;
} else {
  mkdirSync(dirname(logfile), { recursive: true });
  let empty;

  try {
    empty = statSync(logfile).size === 0;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    empty = true;
  }

  const clean = (value) => {
    const cell = value.replace(/[\t\n\r]/g, " ");

    return /^[=+\-@]/.test(cell) ? `'${cell}` : cell;
  };

  const header = empty ? "ts\tphase\tdecision\twhy\tevidence\tresult\n" : "";
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  appendFileSync(logfile, `${header}${[timestamp, ...cells.map(clean)].join("\t")}\n`, "utf8");
}
