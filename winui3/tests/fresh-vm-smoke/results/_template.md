# Fresh VM smoke - release <RELEASE_TAG>

| Field | Value |
| --- | --- |
| Operator | <YOUR_NAME> |
| Date | <YYYY-MM-DD> |
| MSIX SHA-256 | <from packaging\msix\dist\<arch>\signed\*.msix> |
| Portable ZIP SHA-256 | <from packaging\portable\dist\*.zip> |
| VM image | <e.g. Windows 11 Pro 23H2 build 22631.3593> |
| Architecture | <x64 / arm64> |

## A. MSIX install
- [ ] Install accepted
- [ ] Start menu tile present

## B. First-launch wizard
- [ ] Shell renders
- [ ] Banner appears for missing deps
- [ ] Wizard page lists each dep
- [ ] `winget install` streams to log
- [ ] Cancel works
- [ ] All deps OK after refresh
- [ ] gh-copilot extension installs

## C. Sibling repos (optional)
- [ ] EvaluationCLI cloned + built
- [ ] CopilotConnectorSkill cloned + built

## D. Build-mode job
- [ ] Steps 1-6 all green
- [ ] Scored report opens in in-app viewer

## E. Portable CLI
- [ ] `ccw --help` works
- [ ] `ccw tools` clean
- [ ] `ccw diagnostics` allOk=true
- [ ] Build-mode job matches WinUI output (ParityDiffer green)

## F. `winget configure` (second VM)
- [ ] All four packages installed
- [ ] `ccw diagnostics` allOk=true post-config

## G. Cleanup
- [ ] Uninstall clean
- [ ] `%LOCALAPPDATA%\CopilotConnectorWorkflow\workspace\` preserved

## Notes / failures

(operator notes here)
