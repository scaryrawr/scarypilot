import { main } from "./cli.ts";

try {
  await main();
} catch (error) {
  console.error(`decide: ${error instanceof Error ? error.message : "Decision command failed."}`);
  process.exitCode = 1;
}
