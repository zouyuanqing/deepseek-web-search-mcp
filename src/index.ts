import { loadConfig } from "./config.js";
import { errorText } from "./errors.js";
import { printHealth, runStdioServer } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const doctor = process.argv.includes("--doctor") || process.argv.includes("--health");
  if (doctor) {
    await printHealth(config);
    return;
  }
  await runStdioServer(config);
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorText(error)}\n`);
  process.exitCode = 1;
});
