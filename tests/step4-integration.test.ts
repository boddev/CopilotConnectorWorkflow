import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { renderConnectorProject } from '../src/steps/step4-connector';
import type { JobRecord } from '../src/types';
import type { ToolPaths } from '../src/tools';

function makeMinimalJob(tmpDir: string): JobRecord {
  return {
    id: 'testjob',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'pending',
    workspace: tmpDir,
    config: {
      connectorId: 'testconn',
      connectorName: 'Test Connector',
      description: 'Test connector for unit tests',
      connectorDescription: 'Test connector for unit tests',
      aclMode: 'everyone',
      mode: 'build',
      deployTarget: 'azure-functions',
      count: 10,
      dataset: tmpDir,
    },
    steps: {} as JobRecord['steps'],
  };
}

describe('renderConnectorProject', () => {
  it('generates required Agents Toolkit files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-test-'));
    try {
      const schemaTs = path.join(tmpDir, 'schema.ts');
      const schemaJson = path.join(tmpDir, 'connector-schema.json');
      const itemsJsonl = path.join(tmpDir, 'enhanced-items.jsonl');
      fs.writeFileSync(schemaTs, 'export const connectorSchema = { baseType: "microsoft.graph.externalItem", properties: [] } as const;');
      fs.writeFileSync(schemaJson, '{"baseType":"microsoft.graph.externalItem","properties":[]}');
      fs.writeFileSync(itemsJsonl, '{"id":"item1","acl":[],"properties":{},"content":{"type":"text","value":"test"}}\n');

      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const templatesRoot = path.resolve(__dirname, '..', 'templates');
      const tools: Partial<ToolPaths> = { templatesRoot };
      const job = makeMinimalJob(tmpDir);

      renderConnectorProject(job, tools as ToolPaths, projectDir, schemaTs, schemaJson, itemsJsonl);

      // Agents Toolkit config files
      expect(fs.existsSync(path.join(projectDir, 'teamsapp.yml'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'teamsapp.local.yml'))).toBe(true);

      // appPackage files
      expect(fs.existsSync(path.join(projectDir, 'appPackage', 'manifest.json'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'appPackage', 'declarativeAgent.json'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'appPackage', 'instruction.txt'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'appPackage', 'icon-color.png'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'appPackage', 'icon-outline.png'))).toBe(true);

      // Enhancer (static copy)
      expect(fs.existsSync(path.join(projectDir, 'src', 'custom', 'enhancer.ts'))).toBe(true);

      const ingestTs = fs.readFileSync(path.join(projectDir, 'src', 'scripts', 'ingest.ts'), 'utf-8');
      expect(ingestTs).toContain('source.fetchItems()');
      expect(ingestTs).not.toContain('enhance(rawItem');

      const graphServiceTs = fs.readFileSync(path.join(projectDir, 'src', 'services', 'graphService.ts'), 'utf-8');
      expect(graphServiceTs).toContain('local.settings.json');
      expect(graphServiceTs).toContain('.env.local.user');
      expect(graphServiceTs).toContain('loadLocalSettingsEnv()');

      const provisionTs = fs.readFileSync(path.join(projectDir, 'src', 'scripts', 'provision.ts'), 'utf-8');
      expect(provisionTs).toContain('toGraphSchemaPayload');
      expect(provisionTs).toContain('aliases, ...property');

      // Schema + data files
      expect(fs.existsSync(path.join(projectDir, 'src', 'references', 'schema.ts'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'data', 'enhanced-items.jsonl'))).toBe(true);

      // Validate declarativeAgent.json structure
      const agent = JSON.parse(fs.readFileSync(path.join(projectDir, 'appPackage', 'declarativeAgent.json'), 'utf-8'));
      expect(agent.capabilities[0].connections[0].connection_id).toBe('testconn');
      expect(agent.name).toBe('Test Connector Assistant');

      // Validate manifest.json structure
      const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'appPackage', 'manifest.json'), 'utf-8'));
      expect(manifest.copilotAgents.declarativeAgents[0].file).toBe('declarativeAgent.json');
      expect(manifest.id).toBe('${{TEAMS_APP_ID}}');
      expect(manifest.name.short).toBe('Test Connector Assistant');

      // Validate instruction.txt is non-empty
      const instructions = fs.readFileSync(path.join(projectDir, 'appPackage', 'instruction.txt'), 'utf-8');
      expect(instructions).toContain('Test Connector');

      // Validate teamsapp.yml preserves Agents Toolkit env vars
      const teamsappYml = fs.readFileSync(path.join(projectDir, 'teamsapp.yml'), 'utf-8');
      expect(teamsappYml).toContain('${{TEAMSFX_ENV}}');
      expect(teamsappYml).toContain('Test Connector-${{TEAMSFX_ENV}}');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses custom agentName when provided', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-test-'));
    try {
      const schemaTs = path.join(tmpDir, 'schema.ts');
      const schemaJson = path.join(tmpDir, 'connector-schema.json');
      const itemsJsonl = path.join(tmpDir, 'enhanced-items.jsonl');
      fs.writeFileSync(schemaTs, 'export const connectorSchema = { baseType: "microsoft.graph.externalItem", properties: [] } as const;');
      fs.writeFileSync(schemaJson, '{"baseType":"microsoft.graph.externalItem","properties":[]}');
      fs.writeFileSync(itemsJsonl, '');

      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const templatesRoot = path.resolve(__dirname, '..', 'templates');
      const tools: Partial<ToolPaths> = { templatesRoot };
      const job = makeMinimalJob(tmpDir);
      job.config.agentName = 'Custom Bot Name';
      job.config.agentInstructions = 'Custom instructions here.';

      renderConnectorProject(job, tools as ToolPaths, projectDir, schemaTs, schemaJson, itemsJsonl);

      const agent = JSON.parse(fs.readFileSync(path.join(projectDir, 'appPackage', 'declarativeAgent.json'), 'utf-8'));
      expect(agent.name).toBe('Custom Bot Name');

      const instructions = fs.readFileSync(path.join(projectDir, 'appPackage', 'instruction.txt'), 'utf-8');
      expect(instructions).toBe('Custom instructions here.');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('activates urlToItemResolver when urlPrefix is configured', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-test-'));
    try {
      const schemaTs = path.join(tmpDir, 'schema.ts');
      const schemaJson = path.join(tmpDir, 'connector-schema.json');
      const itemsJsonl = path.join(tmpDir, 'enhanced-items.jsonl');
      fs.writeFileSync(schemaTs, 'export const connectorSchema = { baseType: "microsoft.graph.externalItem", properties: [] } as const;');
      fs.writeFileSync(schemaJson, '{"baseType":"microsoft.graph.externalItem","properties":[]}');
      fs.writeFileSync(itemsJsonl, '');

      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const templatesRoot = path.resolve(__dirname, '..', 'templates');
      const tools: Partial<ToolPaths> = { templatesRoot };
      const job = makeMinimalJob(tmpDir);
      job.config.urlPrefix = 'https://wiki.example.com';

      renderConnectorProject(job, tools as ToolPaths, projectDir, schemaTs, schemaJson, itemsJsonl);

      const connectionTs = fs.readFileSync(
        path.join(projectDir, 'src', 'models', 'connection.ts'),
        'utf-8',
      );
      // Should contain an active (uncommented) urlToItemResolver export
      expect(connectionTs).toContain('export const urlToItemResolver');
      expect(connectionTs).toContain('https://wiki.example.com');
      // Should NOT contain the todo-comment placeholder
      expect(connectionTs).not.toContain('Set --url-prefix when running');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('omits active urlToItemResolver when urlPrefix is not configured', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-test-'));
    try {
      const schemaTs = path.join(tmpDir, 'schema.ts');
      const schemaJson = path.join(tmpDir, 'connector-schema.json');
      const itemsJsonl = path.join(tmpDir, 'enhanced-items.jsonl');
      fs.writeFileSync(schemaTs, 'export const connectorSchema = { baseType: "microsoft.graph.externalItem", properties: [] } as const;');
      fs.writeFileSync(schemaJson, '{"baseType":"microsoft.graph.externalItem","properties":[]}');
      fs.writeFileSync(itemsJsonl, '');

      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const templatesRoot = path.resolve(__dirname, '..', 'templates');
      const tools: Partial<ToolPaths> = { templatesRoot };
      const job = makeMinimalJob(tmpDir);
      // No urlPrefix — resolver should be left as a commented-out TODO

      renderConnectorProject(job, tools as ToolPaths, projectDir, schemaTs, schemaJson, itemsJsonl);

      const connectionTs = fs.readFileSync(
        path.join(projectDir, 'src', 'models', 'connection.ts'),
        'utf-8',
      );
      // Should NOT have an active (uncommented) urlToItemResolver export
      expect(connectionTs).not.toMatch(/^export const urlToItemResolver/m);
      // Should contain the hint comment
      expect(connectionTs).toContain('Set --url-prefix when running');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
