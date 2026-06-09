// Port of src/cli.ts usage() block. Mirrors the Node text closely; not
// byte-equal (System.CommandLine-style help would be wholly different —
// we don't use System.CommandLine for argv parsing either). The plan
// (§4 Phase 4 — Opus I7) explicitly accepts help/error text divergence.

namespace Ccw.Cli;

internal static class Usage
{
    public static string Text => """
ccw - CopilotConnectorWorkflow CLI (Windows-native)

Commands:
  run         Create + run a new pipeline end-to-end
  resume      Resume an existing job (re-runs incomplete steps)
  compare     Post-hoc compare two completed jobs (enhanced vs --no-enhance)
  status      Show job status
  list        List all jobs
  tools       Show detected tool paths and health
  auth        Validate Graph app credentials and seed WorkIQ/EvalScore auth
  diagnostics Emit a JSON inventory report (deps + cli info); --diagnostics alias
  help        Show this message

See the CCW user guide for the full flag matrix. Step log stream output
is parity-tested against the Node `ccw` CLI; help / error text is not.
""";
}
