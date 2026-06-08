# Ccw.Core.Tests / Fixtures

This folder holds parity fixtures captured from Node CCW runs (or
hand-authored to lock the wire format). They are the **contract** the
C# port writes against:

- `job-build-mode-with-detection.json` — `JobRecord` from a build-mode
  ngo-environment run with auto-detect-pipeline ON and the identity-
  transform path selected. Exercises the full optional graph
  (`pipelineDetection`, all six step entries, `datasetHash`,
  `evalSetHash`). No provision-mode fields (`auth`, `score`,
  `agentName`, etc.) — those land in a follow-up fixture once the
  provision-mode end-to-end smoke is captured.

## Indentation

All fixtures use **2-space indent + LF** to match `JSON.stringify(obj,
null, 2)`. `.gitattributes` at the repo root pins `*.json` (and
specifically `tests/**/Fixtures/**`) to LF so a checkout on a CRLF
machine does not silently break the byte-equality test.

## Adding a fixture

1. Capture from a Node run (preferred) or hand-author with the exact
   shape `src/types.ts` defines.
2. Property order MUST match the TS declaration order in
   `src/types.ts` (and the `[JsonPropertyOrder]` attributes on the
   matching C# records under `winui3/src/Ccw.Core/Models/`). If the
   two disagree, the fixture is wrong — that disagreement is what the
   parity test exists to catch.
3. Whitespace is significant. Reformatting a fixture (e.g. with
   `prettier --write` or `jq`) will break the byte-equality assertion.
4. The C# round-trip test deserializes -> reserializes -> compares
   indented bytes (UTF-8, LF). If you intentionally change the wire
   shape, regenerate the fixture in the same operation.
