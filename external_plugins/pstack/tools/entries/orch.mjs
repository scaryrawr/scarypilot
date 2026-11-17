import { main } from "../../skills/poteto-mode/scripts/orch/orch.ts";

process.exitCode = await main(process.argv.slice(2));
