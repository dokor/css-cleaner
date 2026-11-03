import { scanProject, ScanProjectError } from "css-cleaner";

try {
  const { report } = await scanProject({ rootDir: process.argv[2] ?? "." });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  if (!(error instanceof ScanProjectError)) throw error;
  process.stderr.write(JSON.stringify({
    code: error.code, stage: error.stage, location: error.location, message: error.message,
  }) + "\n");
  process.exitCode = 2;
}
