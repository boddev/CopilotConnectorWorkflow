# CCW portable CLI ZIP (Phase 7)

Build a self-contained single-file `ccw.exe` and pack it as a portable
ZIP. No .NET runtime install needed on the target machine. Lighter-weight
alternative to the MSIX for users who only want the headless orchestrator.

## Build

```pwsh
pwsh .\winui3\packaging\portable\build-cli-zip.ps1                    # win-x64, runs tests
pwsh .\winui3\packaging\portable\build-cli-zip.ps1 -Rid win-arm64
pwsh .\winui3\packaging\portable\build-cli-zip.ps1 -SkipTests          # local only
```

The output is written to:

```
winui3/packaging/portable/dist/ccw-<version>-<rid>.zip
```

Version is read from `Ccw.Core.CoreInfo.Version` (`winui3/src/Ccw.Core/CoreInfo.cs`).
Override with `-Version 0.2.0-rc1` if needed.

## Layout

The ZIP unpacks into a versioned directory so it cannot clobber unrelated
files when extracted into a shared folder:

```
ccw-0.1.0/
  ccw.exe                  # self-contained single-file binary
  templates/               # connector / deploy templates
  README.txt
  LICENSE                  # if available at repo root
```

The user adds `C:\Tools\ccw\ccw-0.1.0` to PATH and runs `ccw --help`.

## External runtime dependencies

`ccw.exe` shells out to:

- `node` (>= 22 LTS) — the parity-anchored sibling Node engines for
  Step 2 (enhancer) and Step 6 (judge).
- `git` — `ccw bootstrap clone` of sibling repos.
- `az` — Step 4 connector deploy.
- `gh` + `gh-copilot` extension — Step 6 GitHub Copilot judge.

The portable ZIP intentionally does NOT bundle these — the WinUI 3 head
ships a first-run wizard for `winget install` of each. The portable ZIP
is for users who already have a working developer toolchain.

## Coexistence with the Node CLI

The Node-based `ccw` from the parent repo also installs as `ccw` on PATH.
Both binaries write the same on-disk artifacts (`job.json`, scored CSV,
markdown reports), so artifacts move freely between them — but you should
choose ONE for PATH at a time to avoid confusion about which engine ran a
given job.

## CI

The release workflow (Phase 9) calls this script with `-Rid win-x64`
followed by `-Rid win-arm64`, uploads both ZIPs as release assets, and
prints the SHA-256 of each so the release notes can include them.
