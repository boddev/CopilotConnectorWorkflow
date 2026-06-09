# `winget configure` — bulk dependency provisioning

`ccw-deps.dsc.winget.yaml` is a [DSC configuration](https://learn.microsoft.com/windows/package-manager/configuration/)
for `winget configure` that installs every external CLI tool CCW needs:

- Node.js LTS (>= 22) — Step 2 (enhancer) + Step 6 (judge).
- Git for Windows — `ccw bootstrap clone` of sibling repos.
- Azure CLI — Step 4 connector deploy.
- GitHub CLI — Step 6 GitHub Copilot judge.

## Usage

```pwsh
# 1. Optionally inspect first (no installs)
winget configure show --file ccw-deps.dsc.winget.yaml

# 2. Install everything
winget configure --file ccw-deps.dsc.winget.yaml

# 3. After winget completes, install the gh-copilot extension:
gh extension install github/gh-copilot
```

The gh-copilot extension is not on `winget` (it's a GitHub CLI extension,
installed via `gh extension install`). CCW's first-run wizard surfaces a
one-click button for this step; the bulk YAML path leaves it as the
documented post-resource manual step above.

## Where this fits

The intended distribution flow:

1. User installs CCW via the MSIX or portable ZIP.
2. CCW launches its first-run wizard (`Setup` tab), probes for each
   external CLI, and offers per-tool `winget install` buttons.
3. For headless/enterprise scenarios (silent provisioning, gold-image
   builds), use `winget configure --file ccw-deps.dsc.winget.yaml` to
   install everything in one shot.

Both flows ultimately call `winget install` with the same package IDs;
the YAML just exposes the same set declaratively.
