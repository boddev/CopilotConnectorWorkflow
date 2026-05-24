import * as fs from 'fs';
import * as path from 'path';

export interface ScoreAgentConfig {
  key: string;
  name: string;
  connectorId: string;
  responseCsv: string;
}

interface EvalItem {
  id?: string;
  prompt?: string;
  expected_answer?: string;
  expectedAnswer?: string;
  assertions?: Array<{ value?: string; wholeWord?: boolean }>;
  supporting_facts?: string[];
  supportingFacts?: string[];
  category?: string;
  difficulty?: string;
}

const NO_RESULT_PATTERNS = [
  'no matching',
  'not found',
  'unable to return',
  'was not located',
  'no records found',
  'could not find',
];

export function scoreResponseSet(evalgenJson: string, agents: ScoreAgentConfig[], outputDir: string): void {
  const evalItems = readEvalItems(evalgenJson);
  const payload: Record<string, unknown> = {
    methodology: {
      deterministic_grounding_score: '80% EvalGen must-contain assertion coverage + 20% supporting-fact value coverage',
      semantic_quality_score: 'Local semantic quality fallback: token-overlap F1 between expected and actual answer, separate from deterministic grounding.',
      matching: 'Case-insensitive, Unicode-normalized, punctuation/spacing-tolerant matching; whole-word assertions enforce token boundaries.',
    },
    agents: {},
  };
  const agentPayload = payload.agents as Record<string, unknown>;

  for (const agent of agents) {
    const rows = readCsv(agent.responseCsv);
    const scored = evalItems.map((item, index) => scoreItem(item, rows[index] || {}, index + 1));
    agentPayload[agent.key] = {
      summary: summarize(agent, scored),
      items: scored,
      category_summary: summarizeCategories(scored),
    };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'agent-response-scores.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(path.join(outputDir, 'agent-response-scores.md'), renderMarkdown(payload, agents), 'utf-8');
}

function scoreItem(item: EvalItem, row: Record<string, string>, index: number): Record<string, unknown> {
  const response = row.actual_answer || '';
  const assertions = item.assertions || [];
  const assertionResults = assertions.map((assertion) => {
    const value = assertion.value || '';
    return { value, passed: containsValue(response, value, !!assertion.wholeWord), whole_word: !!assertion.wholeWord };
  });
  const factResults = normalizeFacts(item.supporting_facts || item.supportingFacts || []).map((fact) => {
    const [, value] = parseFact(fact);
    return { value, passed: containsValue(response, value, isShortCode(value)) };
  }).filter((fact) => fact.value);

  const assertionsTotal = assertionResults.length;
  const assertionsPassed = assertionResults.filter((result) => result.passed).length;
  const factsTotal = factResults.length;
  const factsPassed = factResults.filter((result) => result.passed).length;
  const expected = item.expected_answer || item.expectedAnswer || row.expected_answer || '';
  const expectedNoResult = hasNoResultLanguage(expected);
  const responseNoResult = hasNoResultLanguage(response);

  let assertionScore = 0;
  let factScore = 0;
  let deterministicScore = 0;
  let status: 'pass' | 'partial' | 'fail' = 'fail';
  if (assertionsTotal > 0) {
    assertionScore = assertionsPassed / assertionsTotal;
    factScore = factsTotal > 0 ? factsPassed / factsTotal : assertionScore;
    deterministicScore = (0.8 * assertionScore) + (0.2 * factScore);
    status = assertionsPassed === assertionsTotal ? 'pass' : assertionsPassed > 0 ? 'partial' : 'fail';
  } else if (factsTotal > 0) {
    assertionScore = factsPassed / factsTotal;
    factScore = assertionScore;
    deterministicScore = factScore;
    status = factsPassed === factsTotal ? 'pass' : factsPassed > 0 ? 'partial' : 'fail';
  } else if (expectedNoResult) {
    assertionScore = responseNoResult ? 1 : 0;
    factScore = assertionScore;
    deterministicScore = assertionScore;
    status = responseNoResult ? 'pass' : 'fail';
  }

  return {
    index,
    id: item.id || '',
    category: item.category || '',
    difficulty: item.difficulty || '',
    prompt: item.prompt || row.prompt || '',
    expected_answer: expected,
    actual_answer: response,
    assertions: assertionResults,
    supporting_facts: factResults,
    assertions_passed: assertionsPassed,
    assertions_total: assertionsTotal,
    facts_passed: factsPassed,
    facts_total: factsTotal,
    deterministic_grounding_score: roundPct(deterministicScore),
    semantic_quality_score: roundPct(localSemanticQuality(expected, response)),
    semantic_quality_provider: 'local-token-overlap',
    assertion_score: roundPct(assertionScore),
    fact_score: roundPct(factScore),
    status,
    has_citation: hasCitation(response),
    has_no_result_language: responseNoResult,
    expected_no_result: expectedNoResult,
    failed_checks: assertionResults.filter((result) => !result.passed).map((result) => result.value),
  };
}

function summarize(agent: ScoreAgentConfig, scores: Array<Record<string, unknown>>): Record<string, unknown> {
  const deterministic = scores.map((item) => Number(item.deterministic_grounding_score || 0));
  const semantic = scores.map((item) => Number(item.semantic_quality_score || 0));
  const totalAssertions = sum(scores, 'assertions_total');
  const passedAssertions = sum(scores, 'assertions_passed');
  const totalFacts = sum(scores, 'facts_total');
  const passedFacts = sum(scores, 'facts_passed');
  return {
    agent: { key: agent.key, name: agent.name, connector_id: agent.connectorId },
    prompt_count: scores.length,
    average_deterministic_grounding_score: average(deterministic),
    average_semantic_quality_score: average(semantic),
    assertion_pass_rate: totalAssertions ? roundPct(passedAssertions / totalAssertions) : 100,
    assertions_passed: passedAssertions,
    assertions_total: totalAssertions,
    fact_pass_rate: totalFacts ? roundPct(passedFacts / totalFacts) : 100,
    facts_passed: passedFacts,
    facts_total: totalFacts,
    pass_count: scores.filter((item) => item.status === 'pass').length,
    partial_count: scores.filter((item) => item.status === 'partial').length,
    fail_count: scores.filter((item) => item.status === 'fail').length,
    citation_count: scores.filter((item) => item.has_citation).length,
  };
}

function summarizeCategories(scores: Array<Record<string, unknown>>): Record<string, unknown> {
  const categories = [...new Set(scores.map((item) => String(item.category || 'uncategorized')))].sort();
  const out: Record<string, unknown> = {};
  for (const category of categories) {
    const items = scores.filter((item) => String(item.category || 'uncategorized') === category);
    out[category] = {
      count: items.length,
      average_deterministic_grounding_score: average(items.map((item) => Number(item.deterministic_grounding_score || 0))),
      average_semantic_quality_score: average(items.map((item) => Number(item.semantic_quality_score || 0))),
    };
  }
  return out;
}

function renderMarkdown(payload: Record<string, unknown>, agents: ScoreAgentConfig[]): string {
  const agentsPayload = payload.agents as Record<string, { summary: Record<string, unknown> }>;
  const lines = [
    '# Agent Response Scoring',
    '',
    'Scores include deterministic grounding and a separate semantic quality score.',
    '',
    '| Agent | Connector | Avg grounding | Avg semantic quality | Assertions passed | Fact pass rate | Pass | Partial | Fail |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const agent of agents) {
    const summary = agentsPayload[agent.key]?.summary;
    if (!summary) continue;
    lines.push(
      `| ${agent.name} | \`${agent.connectorId}\` | ${summary.average_deterministic_grounding_score}% | ` +
      `${summary.average_semantic_quality_score}% | ${summary.assertions_passed}/${summary.assertions_total} | ` +
      `${summary.fact_pass_rate}% | ${summary.pass_count} | ${summary.partial_count} | ${summary.fail_count} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function readEvalItems(filePath: string): EvalItem[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { items?: EvalItem[] };
  if (!Array.isArray(parsed.items)) throw new Error(`EvalGen JSON has no items array: ${filePath}`);
  return parsed.items;
}

function readCsv(filePath: string): Array<Record<string, string>> {
  const rows = parseCsv(fs.readFileSync(filePath, 'utf-8'));
  const header = rows[0] || [];
  return rows.slice(1).map((row) => {
    const out: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) out[header[i]] = row[i] || '';
    return out;
  });
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const text = stripBom(content);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim()));
}

function foldText(value: string): string {
  return (value || '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function compact(value: string): string {
  return foldText(value).replace(/[^a-z0-9]+/g, '');
}

function containsValue(response: string, expected: string, wholeWord: boolean): boolean {
  if (!expected) return true;
  const foldedResponse = foldText(response);
  const foldedExpected = foldText(expected);
  if (wholeWord || isShortCode(expected)) {
    const pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(foldedExpected)}(?![a-z0-9])`);
    if (pattern.test(foldedResponse)) return true;
  }
  return foldedResponse.includes(foldedExpected) || compact(response).includes(compact(expected));
}

function localSemanticQuality(expected: string, actual: string): number {
  const expectedTokens = tokenSet(expected);
  const actualTokens = tokenSet(actual);
  if (expectedTokens.size === 0) return actualTokens.size === 0 ? 1 : 0;
  if (actualTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of expectedTokens) if (actualTokens.has(token)) overlap++;
  const precision = overlap / actualTokens.size;
  const recall = overlap / expectedTokens.size;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function tokenSet(value: string): Set<string> {
  return new Set(foldText(value).split(/[^a-z0-9.]+/).filter((token) => token.length > 1));
}

function isShortCode(value: string): boolean {
  const stripped = (value || '').replace(/[^A-Za-z0-9]/g, '');
  return stripped.length > 1 && stripped.length <= 3 && stripped.toUpperCase() === stripped;
}

function hasNoResultLanguage(value: string): boolean {
  const folded = foldText(value);
  return NO_RESULT_PATTERNS.some((pattern) => folded.includes(pattern));
}

function hasCitation(value: string): boolean {
  return value.includes('\ue200cite') || value.includes('cite') || /\[\^\d+\^\]/.test(value);
}

function normalizeFacts(facts: string[]): string[] {
  return facts.filter((fact) => typeof fact === 'string' && fact.trim());
}

function parseFact(fact: string): [string, string] {
  const index = fact.indexOf('=');
  return index < 0 ? ['', fact.trim()] : [fact.slice(0, index).trim(), fact.slice(index + 1).trim()];
}

function average(values: number[]): number {
  return values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : 0;
}

function sum(values: Array<Record<string, unknown>>, key: string): number {
  return values.reduce((total, item) => total + Number(item[key] || 0), 0);
}

function roundPct(value: number): number {
  return Math.round(value * 1000) / 10;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

