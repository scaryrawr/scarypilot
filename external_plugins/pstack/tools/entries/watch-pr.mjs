import { main } from "../../skills/poteto-mode/scripts/watch-pr/cli.ts";

process.exitCode = await main(process.argv.slice(2));
