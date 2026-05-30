/**
 * Post-hoc comparator (`ccw compare`).
 *
 * Reads two completed jobs' canonical scored reports
 * (06-score/agent-response-scores.json), validates pre-conditions, and emits a
 * combined enhanced-vs-non-enhanced comparison report.
 *
 * Never renders, builds, provisions, ingests, or calls Copilot.
 *
 * Pre-conditions (see STREAMLINED_CONNECTOR_EVAL_PLAN.md "Post-hoc comparator"):
 *  - Both jobs ran in mode=provision and reached Step 6 done.
 *  - Same canonical datasetHash.
 *  - Same canonical evalSetHash.
 *  - Exactly one job has noEnhance=true.
 *  - Mismatched judgeProvider is NOT a hard refusal: the comparator emits
 *    deterministic + operational metrics with `semanticComparable: false` and
 *    omits the semantic delta.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadJob } from './jobs';
import { JobRecord, ScoredReport } from './types';

export interface CompareOptions {
  jobIdA: string;
  jobIdB: string;
  outputDir: string;
}

export interface CompareResult {
  outputDir: string;
  reportJsonPath: string;
  reportMdPath: string;
  scoreMatrixPath: string;
  comparable: boolean;
  semanticComparable: boolean;
  diagnostics: string[];
}

export function runCompare(options: CompareOptions): CompareResult {
  const diagnostics: string[] = [];

  const a = mustLoadJob(options.jobIdA);
  const b = mustLoadJob(options.jobIdB);

  // Decide which job is enhanced and which is non-enhanced.
  const enhanced = !a.config.noEnhance ? a : !b.config.noEnhance ? b : undefined;
  const nonEnhanced = a.config.noEnhance ? a : b.config.noEnhance ? b : undefined;
  if (!enhanced || !nonEnhanced || enhanced.id === nonEnhanced.id) {
    throw new Error(
      'compare requires exactly one job with noEnhance=true and one without. ' +
      `Got: ${a.id} noEnhance=${!!a.config.noEnhance}, ${b.id} noEnhance=${!!b.config.noEnhance}`,
    );
  }

  fs.mkdirSync(options.outputDir, { recursive: true });

  let comparable = true;

  if (enhanced.config.mode !== 'provision' || nonEnhanced.config.mode !== 'provision') {
    diagnostics.push('one or both jobs ran in build mode; build jobs have no scored report and are not comparable');
    comparable = false;
  }

  const enhancedReport = comparable ? mustLoadScoredReport(enhanced) : undefined;
  const nonEnhancedReport = comparable ? mustLoadScoredReport(nonEnhanced) : undefined;

  if (enhanced.datasetHash && nonEnhanced.datasetHash && enhanced.datasetHash !== nonEnhanced.datasetHash) {
    diagnostics.push(`datasetHash mismatch: enhanced=${enhanced.datasetHash} non-enhanced=${nonEnhanced.datasetHash}`);
    comparable = false;
  }
  if (enhanced.evalSetHash && nonEnhanced.evalSetHash && enhanced.evalSetHash !== nonEnhanced.evalSetHash) {
    diagnostics.push(`evalSetHash mismatch: enhanced=${enhanced.evalSetHash} non-enhanced=${nonEnhanced.evalSetHash}`);
    comparable = false;
  }

  let semanticComparable = false;
  if (enhancedReport && nonEnhancedReport) {
    if (enhancedReport.judgeProvider === nonEnhancedReport.judgeProvider) {
      semanticComparable = true;
    } else {
      diagnostics.push(
        `judgeProvider differs: enhanced=${enhancedReport.judgeProvider} non-enhanced=${nonEnhancedReport.judgeProvider}; ` +
        'semantic delta omitted. Deterministic and operational metrics are still reported.',
      );
    }
  }

  const reportJson: Record<string, unknown> = {
    comparable,
    semanticComparable,
    diagnostics,
    enhanced: summarizeJob(enhanced, enhancedReport),
    nonEnhanced: summarizeJob(nonEnhanced, nonEnhancedReport),
    deltas: comparable && enhancedReport && nonEnhancedReport
      ? buildDeltas(enhancedReport, nonEnhancedReport, semanticComparable)
      : undefined,
    perQuestion: comparable && enhancedReport && nonEnhancedReport
      ? buildPerQuestion(enhancedReport, nonEnhancedReport, semanticComparable)
      : undefined,
  };

  const reportJsonPath = path.join(options.outputDir, 'comparison-report.json');
  const reportMdPath = path.join(options.outputDir, 'comparison-report.md');
  const scoreMatrixPath = path.join(options.outputDir, 'score-matrix.csv');
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(reportJson, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportMdPath, renderMarkdown(reportJson, enhanced, nonEnhanced, enhancedReport, nonEnhancedReport), 'utf-8');
  fs.writeFileSync(scoreMatrixPath, renderScoreMatrix(enhancedReport, nonEnhancedReport), 'utf-8');

  return {
    outputDir: options.outputDir,
    reportJsonPath,
    reportMdPath,
    scoreMatrixPath,
    comparable,
    semanticComparable,
    diagnostics,
  };
}

function mustLoadJob(jobId: string): JobRecord {
  const job = loadJob(jobId);
  if (!job) throw new Error(`job not found: ${jobId}`);
  return job;
}

function mustLoadScoredReport(job: JobRecord): ScoredReport {
  const file = path.join(job.workspace, '06-score', 'agent-response-scores.json');
  if (!fs.existsSync(file)) {
    throw new Error(`job ${job.id} has no scored report at ${file} (Step 6 must complete in provision mode)`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as ScoredReport;
}

function summarizeJob(job: JobRecord, report: ScoredReport | undefined): Record<string, unknown> {
  return {
    jobId: job.id,
    connectorId: job.config.connectorId,
    connectorName: job.config.connectorName,
    noEnhance: !!job.config.noEnhance,
    datasetHash: job.datasetHash,
    evalSetHash: job.evalSetHash,
    mode: job.config.mode,
    judgeProvider: report?.judgeProvider,
    judgeModel: report?.judgeModel,
    promptCount: report?.promptCount,
    validPromptCount: report?.validPromptCount,
    deterministicAverage: report?.deterministicScore.average,
    semanticAverage: report?.semanticScore.average,
    citationRate: report?.citationRate,
    retryCount: report?.retryCount,
    rateLimitCount: report?.rateLimitCount,
    indexReadyAt: report?.indexReadyAt,
    metadataProvenance: report?.metadataProvenance,
  };
}

function buildDeltas(
  enhanced: ScoredReport,
  nonEnhanced: ScoredReport,
  semanticComparable: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    deterministicAverageDelta: roundDelta(enhanced.deterministicScore.average - nonEnhanced.deterministicScore.average),
    citationRateDelta: roundDelta(enhanced.citationRate - nonEnhanced.citationRate),
    retryCountDelta: enhanced.retryCount - nonEnhanced.retryCount,
    rateLimitCountDelta: enhanced.rateLimitCount - nonEnhanced.rateLimitCount,
    validPromptCountDelta: enhanced.validPromptCount - nonEnhanced.validPromptCount,
  };
  if (semanticComparable) {
    out.semanticAverageDelta = roundDelta(enhanced.semanticScore.average - nonEnhanced.semanticScore.average);
    const byDim: Record<string, number> = {};
    const dimensions = new Set([
      ...Object.keys(enhanced.semanticScore.byDimension || {}),
      ...Object.keys(nonEnhanced.semanticScore.byDimension || {}),
    ]);
    for (const d of dimensions) {
      byDim[d] = roundDelta(
        (enhanced.semanticScore.byDimension?.[d] ?? 0) - (nonEnhanced.semanticScore.byDimension?.[d] ?? 0),
      );
    }
    out.semanticDimensionDeltas = byDim;
  }
  return out;
}

interface PerQuestionRow {
  id: string;
  prompt: string;
  enhanced?: { deterministic: number; semantic: number; status: string };
  nonEnhanced?: { deterministic: number; semantic: number; status: string };
  deterministicDelta?: number;
  semanticDelta?: number;
}

function buildPerQuestion(
  enhanced: ScoredReport,
  nonEnhanced: ScoredReport,
  semanticComparable: boolean,
): PerQuestionRow[] {
  const byId = new Map<string, PerQuestionRow>();
  for (const item of enhanced.items) {
    byId.set(item.id, {
      id: item.id,
      prompt: item.prompt,
      enhanced: { deterministic: item.deterministic.score, semantic: item.semantic.score, status: item.deterministic.status },
    });
  }
  for (const item of nonEnhanced.items) {
    const row = byId.get(item.id) || { id: item.id, prompt: item.prompt };
    row.nonEnhanced = { deterministic: item.deterministic.score, semantic: item.semantic.score, status: item.deterministic.status };
    byId.set(item.id, row);
  }
  for (const row of byId.values()) {
    if (row.enhanced && row.nonEnhanced) {
      row.deterministicDelta = roundDelta(row.enhanced.deterministic - row.nonEnhanced.deterministic);
      if (semanticComparable) row.semanticDelta = roundDelta(row.enhanced.semantic - row.nonEnhanced.semantic);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function renderMarkdown(
  report: Record<string, unknown>,
  enhanced: JobRecord,
  nonEnhanced: JobRecord,
  enhancedReport: ScoredReport | undefined,
  nonEnhancedReport: ScoredReport | undefined,
): string {
  const lines: string[] = [];
  lines.push('# Comparison report', '');
  lines.push(`- comparable: **${report.comparable}**`);
  lines.push(`- semanticComparable: **${report.semanticComparable}**`);
  lines.push('');
  if (Array.isArray(report.diagnostics) && (report.diagnostics as string[]).length > 0) {
    lines.push('## Diagnostics', '');
    for (const d of report.diagnostics as string[]) lines.push(`- ${d}`);
    lines.push('');
  }
  lines.push('## Jobs', '');
  lines.push('| | Enhanced | Non-enhanced |');
  lines.push('|---|---|---|');
  lines.push(`| Job id | \`${enhanced.id}\` | \`${nonEnhanced.id}\` |`);
  lines.push(`| Connector id | \`${enhanced.config.connectorId}\` | \`${nonEnhanced.config.connectorId}\` |`);
  lines.push(`| Judge provider | ${enhancedReport?.judgeProvider ?? '-'} | ${nonEnhancedReport?.judgeProvider ?? '-'} |`);
  lines.push(`| Deterministic average | ${enhancedReport?.deterministicScore.average ?? '-'} | ${nonEnhancedReport?.deterministicScore.average ?? '-'} |`);
  lines.push(`| Semantic average | ${enhancedReport?.semanticScore.average ?? '-'} | ${nonEnhancedReport?.semanticScore.average ?? '-'} |`);
  lines.push(`| Citation rate | ${enhancedReport?.citationRate ?? '-'} | ${nonEnhancedReport?.citationRate ?? '-'} |`);
  lines.push(`| Retry count | ${enhancedReport?.retryCount ?? '-'} | ${nonEnhancedReport?.retryCount ?? '-'} |`);
  lines.push(`| Rate-limit count | ${enhancedReport?.rateLimitCount ?? '-'} | ${nonEnhancedReport?.rateLimitCount ?? '-'} |`);
  lines.push(`| Index ready at | ${enhancedReport?.indexReadyAt ?? '-'} | ${nonEnhancedReport?.indexReadyAt ?? '-'} |`);
  lines.push('');
  if (report.deltas) {
    lines.push('## Deltas (enhanced − non-enhanced)', '');
    const deltas = report.deltas as Record<string, unknown>;
    for (const [key, value] of Object.entries(deltas)) {
      if (typeof value === 'object' && value !== null) continue;
      lines.push(`- \`${key}\`: ${value}`);
    }
    if (deltas.semanticDimensionDeltas) {
      lines.push('', '### Semantic dimension deltas', '');
      for (const [dim, value] of Object.entries(deltas.semanticDimensionDeltas as Record<string, unknown>)) {
        lines.push(`- ${dim}: ${value}`);
      }
    }
    lines.push('');
  }
  if (enhancedReport?.metadataProvenance || nonEnhancedReport?.metadataProvenance) {
    lines.push('## Metadata provenance', '');
    lines.push('| | Enhanced | Non-enhanced |');
    lines.push('|---|---|---|');
    const ePro = enhancedReport?.metadataProvenance;
    const nPro = nonEnhancedReport?.metadataProvenance;
    lines.push(`| Title from source | ${ePro?.titleFromSource ?? '-'} | ${nPro?.titleFromSource ?? '-'} |`);
    lines.push(`| URL from source | ${ePro?.urlFromSource ?? '-'} | ${nPro?.urlFromSource ?? '-'} |`);
    lines.push(`| Icon URL from source | ${ePro?.iconUrlFromSource ?? '-'} | ${nPro?.iconUrlFromSource ?? '-'} |`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function renderScoreMatrix(
  enhanced: ScoredReport | undefined,
  nonEnhanced: ScoredReport | undefined,
): string {
  const header = 'id,prompt,enhanced_deterministic,enhanced_semantic,enhanced_status,nonenhanced_deterministic,nonenhanced_semantic,nonenhanced_status,deterministic_delta,semantic_delta\n';
  if (!enhanced || !nonEnhanced) return header;
  const rows = buildPerQuestion(enhanced, nonEnhanced, enhanced.judgeProvider === nonEnhanced.judgeProvider);
  const lines: string[] = [header.trimEnd()];
  for (const row of rows) {
    lines.push([
      csv(row.id),
      csv(row.prompt),
      row.enhanced?.deterministic ?? '',
      row.enhanced?.semantic ?? '',
      row.enhanced?.status ?? '',
      row.nonEnhanced?.deterministic ?? '',
      row.nonEnhanced?.semantic ?? '',
      row.nonEnhanced?.status ?? '',
      row.deterministicDelta ?? '',
      row.semanticDelta ?? '',
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

function csv(value: string): string {
  if (!/[,"\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function roundDelta(value: number): number {
  return Math.round(value * 10) / 10;
}
