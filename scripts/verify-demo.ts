import { startVerificationFixture } from "../test/helpers/verification-fixture.ts";
import { verifyWorkflow } from "../src/verify/runtime.ts";

// Two independently seeded servers: the broken one displays success without persisting the write.
for (const broken of [true, false]) {
  const fixture = await startVerificationFixture({ broken });
  try {
    const report = await verifyWorkflow(fixture.workflow());
    console.log(JSON.stringify({ fixture: broken ? "false-success-toast" : "persisted-write", status: report.status, reason: report.reason, cost: report.cost, artifacts: report.artifacts }, null, 2));
    if (report.status !== (broken ? "failed" : "passed")) process.exitCode = 1;
  } finally { await fixture.close(); }
}
