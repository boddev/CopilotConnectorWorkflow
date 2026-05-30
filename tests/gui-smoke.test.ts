import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf-8');
const appJs = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf-8');

/**
 * GUI static smoke test: catches the class of regressions where the GUI
 * silently drifts from the CLI (e.g. stepOrder pinned to a deleted step name,
 * or a deleted form field reappearing).
 *
 * Each slice in the GUI alignment plan extends this file with assertions for
 * its new fields/handlers.
 */
describe('GUI static smoke — m365eval removal (Slice 1)', () => {
  it('public/index.html has no m365 references', () => {
    expect(indexHtml).not.toMatch(/m365eval/i);
    expect(indexHtml).not.toMatch(/runM365Eval/);
    expect(indexHtml).not.toMatch(/m365-copilot-eval/i);
    expect(indexHtml).not.toMatch(/run-m365-eval/i);
  });

  it('public/app.js has no m365eval handler/payload references', () => {
    // Slice 1 removed the m365eval form fields, handlers, and payload branches.
    // Slice 8 reintroduces the string 'm365eval' inside the legacy-job badge
    // detector ('m365eval' in j.steps). That is the only allowed occurrence.
    // Forbid every other shape:
    expect(appJs).not.toMatch(/runM365Eval/);
    expect(appJs).not.toMatch(/m365Eval(?!Eula)/);   // m365Eval.* config object
    expect(appJs).not.toMatch(/m365-copilot-eval/i);
    expect(appJs).not.toMatch(/run-m365-eval/);
    expect(appJs).not.toMatch(/m365AgentId/);
    // The stepOrder must not include m365eval.
    expect(appJs).not.toMatch(/stepOrder\s*=\s*\[[^\]]*'m365eval'/);
  });

  it("public/app.js stepOrder includes 'score'", () => {
    // Match: const stepOrder = ['evalgen','enhance','schema','connector','deploy','score'];
    expect(appJs).toMatch(/stepOrder\s*=\s*\[[^\]]*'score'[^\]]*\]/);
    // And does not include the deleted m365eval entry.
    expect(appJs).not.toMatch(/stepOrder\s*=\s*\[[^\]]*'m365eval'/);
  });
});

describe('GUI static smoke — Slice 2 (noEnhance)', () => {
  it('public/index.html has the noEnhance checkbox', () => {
    expect(indexHtml).toMatch(/name="noEnhance"/);
    expect(indexHtml).toMatch(/id="step2-fields"/);
  });

  it('public/app.js forwards noEnhance into the payload', () => {
    expect(appJs).toMatch(/name=noEnhance/);
    expect(appJs).toMatch(/payload\.noEnhance\s*=\s*true/);
  });
});

describe('GUI static smoke — Slice 3 (eval-set reuse)', () => {
  it('HTML has the eval-source select with all three options', () => {
    expect(indexHtml).toMatch(/name="evalSource"/);
    expect(indexHtml).toMatch(/value="generate"/);
    expect(indexHtml).toMatch(/value="reuseFromJob"/);
    expect(indexHtml).toMatch(/value="reuseFromPath"/);
  });
  it('HTML has reuseEvalFromJobId select and paste-id input', () => {
    expect(indexHtml).toMatch(/name="reuseEvalFromJobId"/);
    expect(indexHtml).toMatch(/id="reuse-eval-paste"/);
    expect(indexHtml).toMatch(/name="evalSetPath"/);
  });
  it('app.js exposes listScoredJobs() and forwards reuseEvalFromJobId / evalSetPath into the payload', () => {
    expect(appJs).toMatch(/listScoredJobs/);
    expect(appJs).toMatch(/payload\.reuseEvalFromJobId\s*=/);
    expect(appJs).toMatch(/payload\.evalSetPath\s*=/);
  });
  it('app.js wires a blur validator on the paste-id field', () => {
    expect(appJs).toMatch(/reuse-eval-paste/);
    expect(appJs).toMatch(/blur/);
  });
});

describe('GUI static smoke — Slice 4 (Step 6 score config)', () => {
  it('HTML has the score-fields fieldset with judgeProvider and candidateAgentId', () => {
    expect(indexHtml).toMatch(/id="score-fields"/);
    expect(indexHtml).toMatch(/name="judgeProvider"/);
    expect(indexHtml).toMatch(/name="judgeAgentId"/);
    expect(indexHtml).toMatch(/name="candidateAgentId"/);
    expect(indexHtml).toMatch(/value="github-copilot"/);
    expect(indexHtml).toMatch(/value="workiq"/);
  });
  it('HTML links the candidate hint to agents/eval-judge/README.md', () => {
    expect(indexHtml).toMatch(/href="agents\/eval-judge\/README\.md"/);
  });
  it('app.js builds payload.score with provider/judge/candidate and validates workiq->judgeAgentId', () => {
    expect(appJs).toMatch(/payload\.score\s*=/);
    expect(appJs).toMatch(/judgeProvider/);
    expect(appJs).toMatch(/judgeAgentId/);
    expect(appJs).toMatch(/candidateAgentId/);
    // Mirror-CLI guard
    expect(appJs).toMatch(/workiq.*judgeAgentId|judgeAgentId.*workiq/);
  });
  it('app.js shows a confirm prompt when candidateAgentId is empty in provision mode', () => {
    expect(appJs).toMatch(/window\.confirm/);
    expect(appJs).toMatch(/Candidate agent id is empty/);
  });
  it('app.js toggles score-fields visibility when mode changes to provision', () => {
    expect(appJs).toMatch(/score-fields/);
  });
});

describe('GUI static smoke — Slice 5 (remaining flags)', () => {
  it('HTML has agentName, agentInstructions, urlPrefix fields', () => {
    expect(indexHtml).toMatch(/name="agentName"/);
    expect(indexHtml).toMatch(/name="agentInstructions"/);
    expect(indexHtml).toMatch(/name="urlPrefix"/);
  });
  it('app.js forwards agentName, agentInstructions, urlPrefix to payload', () => {
    expect(appJs).toMatch(/payload\.agentName\s*=/);
    expect(appJs).toMatch(/payload\.agentInstructions\s*=/);
    expect(appJs).toMatch(/payload\.urlPrefix\s*=/);
  });
});

describe('GUI static smoke — Slice 6 (run controls + auth preflight)', () => {
  it('HTML has Run controls fieldset/details with the expected inputs', () => {
    expect(indexHtml).toMatch(/id="run-controls"/);
    expect(indexHtml).toMatch(/name="startAt"/);
    expect(indexHtml).toMatch(/name="stopAfter"/);
    expect(indexHtml).toMatch(/name="forceSteps"/);
    expect(indexHtml).toMatch(/name="forceAllNew"/);
    expect(indexHtml).toMatch(/name="authPreflight"/);
    expect(indexHtml).toMatch(/name="skipWorkiqAuth"/);
  });
  it('HTML has the Validate auth button + result pane', () => {
    expect(indexHtml).toMatch(/id="validate-auth-btn"/);
    expect(indexHtml).toMatch(/id="validate-auth-result"/);
  });
  it('app.js wires the Validate auth button to /api/auth-preflight', () => {
    expect(appJs).toMatch(/validate-auth-btn/);
    expect(appJs).toMatch(/\/api\/auth-preflight/);
  });
  it('app.js sends the new { config, runtime } envelope when POSTing /api/jobs', () => {
    expect(appJs).toMatch(/config:\s*payload,\s*runtime/);
  });
  it('app.js exposes resume controls for startAt/stopAfter/forceSteps', () => {
    expect(appJs).toMatch(/resume-start-at/);
    expect(appJs).toMatch(/resume-stop-after/);
    expect(appJs).toMatch(/resume-force-steps/);
  });
});

describe('GUI static smoke — Slice 7 (Compare panel)', () => {
  it('HTML has the compare section, two job selects, and the report panes', () => {
    expect(indexHtml).toMatch(/id="compare"/);
    expect(indexHtml).toMatch(/id="compare-job-a"/);
    expect(indexHtml).toMatch(/id="compare-job-b"/);
    expect(indexHtml).toMatch(/id="compare-btn"/);
    expect(indexHtml).toMatch(/id="compare-report"/);
    expect(indexHtml).toMatch(/id="compare-csv-link"/);
  });
  it('app.js fetches compare dropdowns with scored=true&provisionOnly=true', () => {
    expect(appJs).toMatch(/\/api\/jobs\?scored=true&provisionOnly=true/);
  });
  it('app.js cascades the second dropdown by noEnhance + dataset/eval hash', () => {
    expect(appJs).toMatch(/applyCompareCascade/);
    expect(appJs).toMatch(/different datasetHash/);
    expect(appJs).toMatch(/different evalSetHash/);
    expect(appJs).toMatch(/same noEnhance value/);
  });
  it('app.js posts to /api/compare and fetches the rendered Markdown via /api/compare/<id>/file', () => {
    expect(appJs).toMatch(/POST.*api\/compare|fetch\('\/api\/compare'/);
    expect(appJs).toMatch(/api\/compare\/\$\{[^}]+\}\/file\?path=comparison-report\.md/);
    expect(appJs).toMatch(/api\/compare\/\$\{[^}]+\}\/file\?path=score-matrix\.csv/);
  });
  it('app.js renders comparison-report.md as textContent (escaped), not innerHTML', () => {
    expect(appJs).toMatch(/compareReportPre\.textContent\s*=/);
    expect(appJs).not.toMatch(/compareReportPre\.innerHTML/);
  });
});

describe('GUI static smoke — Slice 8 (job-list polish)', () => {
  it('app.js renders job-list badges for noEnhance, judge, legacy, connectorId', () => {
    expect(appJs).toMatch(/class="badge no-enhance"/);
    expect(appJs).toMatch(/class="badge legacy"/);
    expect(appJs).toMatch(/judge:/);
  });
  it('HTML has the build-mode hint', () => {
    expect(indexHtml).toMatch(/id="build-mode-hint"/);
    expect(indexHtml).toMatch(/Build jobs produce artifacts only/);
  });
  it('style.css defines the .badge classes', () => {
    const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'style.css'), 'utf-8');
    expect(css).toMatch(/\.badge\b/);
    expect(css).toMatch(/\.badge\.legacy/);
    expect(css).toMatch(/\.badge\.no-enhance/);
  });
});
