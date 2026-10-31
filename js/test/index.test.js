import test from 'node:test';
import assert from 'node:assert/strict';
import toolPrune, { ToolPruner, TurboQuantEngine, normalizeTools, autoSelectCandidates } from '../index.js';

test('normalizeTools accepts dictionary format', () => {
  const { criteria, registry } = normalizeTools({
    read: 'Read file contents',
    write: { description: 'Write file contents' }
  });
  assert.equal(criteria.read, 'Read file contents');
  assert.equal(criteria.write, 'Write file contents');
  assert.equal(registry.get('read').name, 'read');
});

test('normalizeTools accepts array, MCP inputSchema, Anthropic input_schema, and OpenAI function format', () => {
  const mcpTool = {
    name: 'postgres_query',
    description: 'Run read-only SQL',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'SELECT statement' } }
    }
  };
  const anthropicTool = {
    name: 'slack_post',
    description: 'Post message to channel',
    input_schema: {
      type: 'object',
      properties: { channel: { type: 'string' }, text: { type: 'string' } }
    }
  };
  const openaiTool = {
    type: 'function',
    function: {
      name: 'get_exchange_rate',
      description: 'Fetch currency rate',
      parameters: {
        type: 'object',
        properties: {
          base: { type: 'string', enum: ['USD', 'EUR', 'GBP'] },
          date: { type: 'string', description: 'Historical ISO date' }
        }
      }
    }
  };

  const { criteria, registry } = normalizeTools([mcpTool, anthropicTool, openaiTool]);
  assert.match(criteria.postgres_query, /params: sql/);
  assert.match(criteria.slack_post, /params: channel, text/);
  assert.match(criteria.get_exchange_rate, /params: base, date/);
  // Exact original SDK objects preserved for LLM tool-calling passthrough
  assert.strictEqual(registry.get('postgres_query'), mcpTool);
  assert.strictEqual(registry.get('slack_post'), anthropicTool);
  assert.strictEqual(registry.get('get_exchange_rate'), openaiTool);
});

test('ToolPruner can be instantiated and exports are complete', () => {
  const pruner = toolPrune({
    read: 'Read file',
    write: 'Write file'
  });
  assert.ok(pruner instanceof ToolPruner);
  assert.equal(typeof pruner.select, 'function');
  assert.equal(typeof pruner.filter, 'function');
  assert.equal(typeof pruner.dispatch, 'function');
  assert.equal(typeof TurboQuantEngine, 'function');
  assert.equal(typeof autoSelectCandidates, 'function');
});

test('ToolPruner defaults to turboquant if API key is missing', async () => {
  const pruner = new ToolPruner({
    read_file: 'Read file contents from filesystem',
    search_web: 'Search the web for real-time information'
  }, { apiKey: '' });
  pruner.apiKey = undefined;

  const res = await pruner.select('read package.json');
  assert.equal(res.engine, 'turboquant');
  assert.equal(res.tool, 'read_file');
  assert.ok(res.confidence > 0.5);
  assert.equal(res.topK.length, 2);
});

test('ToolPruner throws if engine is typesafe and API key missing', async () => {
  const pruner = new ToolPruner({ read: 'Read file' }, { apiKey: '' });
  pruner.apiKey = undefined;
  await assert.rejects(
    async () => await pruner.select('read a file', { engine: 'typesafe' }),
    /TypeSafe API key required/
  );
});

test('ToolPruner filter preserves OpenAI wrapped function schemas', async () => {
  const openaiTools = [
    {
      type: 'function',
      function: {
        name: 'EuclideanDistance.calculate',
        description: 'Compute Euclidean distance between two 2D points',
        parameters: { type: 'object', properties: { pointA: { type: 'array' }, pointB: { type: 'array' } } }
      }
    },
    {
      type: 'function',
      function: {
        name: 'send_smtp_email',
        description: 'Send email notification via SMTP',
        parameters: { type: 'object', properties: { recipient: { type: 'string' } } }
      }
    }
  ];
  const router = toolPrune(openaiTools, { engine: 'turboquant' });
  const filtered = await router.filter('Compute the Euclidean distance between A(3,4) and B(1,2)');
  assert.equal(filtered.length, 1);
  assert.strictEqual(filtered[0], openaiTools[0]);
});

test('TurboQuant handles negation, camelCase/snake_case, dates, and URI schemes', async () => {
  const tools = {
    git_diff_unstaged: 'View diffs of changes in working directory that are not yet staged',
    git_diff_staged: 'View diffs of changes added to git staging index ready to commit',
    http_get_request: 'Perform HTTP GET request to remote REST endpoint URL',
    github_create_pr: 'Open a new pull request on GitHub repository',
    rate_latest: {
      description: 'Get latest exchange rate',
      inputSchema: { properties: { from: { type: 'string' }, to: { type: 'string' } } }
    },
    rate_historical: {
      description: 'Get exchange rate on a specific date',
      inputSchema: { properties: { from: { type: 'string' }, to: { type: 'string' }, date: { type: 'string', description: 'Historical date' } } }
    }
  };
  const router = toolPrune(tools, { engine: 'turboquant' });

  const unstaged = await router.select("show the diff of changes I haven't staged yet");
  assert.equal(unstaged.tool, 'git_diff_unstaged');

  const staged = await router.select("show me what's currently in git staging ready to commit");
  assert.equal(staged.tool, 'git_diff_staged');

  // Hostname 'github' inside URL payload must not hijack HTTP GET to github_create_pr
  const httpGet = await router.select('query GET https://status.github.com/api/v2/summary.json');
  assert.equal(httpGet.tool, 'http_get_request');

  // Temporal literal 'January 1, 2022' bridges to 'date' schema parameter
  const hist = await router.select('Find conversion rate from Euro to Dollar on January 1, 2022');
  assert.equal(hist.tool, 'rate_historical');
});

test('allowEmpty rejects unrelated out-of-domain queries with low confidence', async () => {
  const tools = {
    fs_read_file: 'Read raw text contents of a local file from disk',
    db_query_select: 'Execute read-only SQL SELECT query against database'
  };
  const router = toolPrune(tools, { engine: 'turboquant', threshold: 0.7 });

  const ood = await router.select('hello, how are you today?', { allowEmpty: true });
  assert.equal(ood.tool, '');
  assert.equal(ood.autoTools.length, 0);
  assert.ok(ood.confidence < 0.2, `Expected low OOD confidence, got ${ood.confidence}`);

  let fallbackCalled = false;
  const dispatched = await router.dispatch('what is 149 * 82?', {
    fs_read_file: () => 'should not run',
    fallback: (_q, sel) => {
      fallbackCalled = true;
      return { mode: 'llm', confidence: sel.confidence };
    }
  }, { allowEmpty: true });
  assert.ok(fallbackCalled);
  assert.equal(dispatched.mode, 'llm');
});

test('Custom DecisionEngine object (webml-kit / SemIf .choice contract) works seamlessly', async () => {
  const mockWebMLEngine = {
    name: 'webml-kit',
    async choice({ state, options }) {
      assert.equal(state, 'run sql query on users');
      assert.ok(options.run_sql);
      return {
        choice: 'run_sql',
        confidence: 0.93,
        probabilities: { run_sql: 0.93, read_file: 0.07 }
      };
    }
  };

  const router = toolPrune({
    run_sql: 'Execute SQL against Postgres',
    read_file: 'Read local file'
  }, { engine: mockWebMLEngine, threshold: 0.85 });

  const sel = await router.select('run sql query on users');
  assert.equal(sel.engine, 'webml-kit');
  assert.equal(sel.tool, 'run_sql');
  assert.equal(sel.confidence, 0.93);
  assert.equal(sel.autoTools.length, 1);
  assert.equal(sel.autoTools[0].name, 'run_sql');
});

test('ToolPruner filter works with turboquant engine', async () => {
  const tools = {
    git_commit: 'Record changes to the repository',
    git_push: 'Update remote refs along with associated objects',
    file_search: 'Search for files by name glob',
    text_replace: 'Replace text inside a file'
  };
  const pruner = new ToolPruner(tools, { engine: 'turboquant' });
  const pruned = await pruner.filter('commit these changes with a message', { topK: 2 });
  assert.equal(pruned.length, 2);
  assert.equal(pruned[0].name, 'git_commit');
});

test('ToolPruner dispatch routes to handler with turboquant', async () => {
  const tools = {
    calculator: 'Calculate mathematical expressions',
    weather: 'Get current weather forecast'
  };
  const pruner = new ToolPruner(tools, { engine: 'turboquant', threshold: 0.1 });
  let executed = false;
  const result = await pruner.dispatch('calculate 2 + 2', {
    calculator: (q, s) => {
      executed = true;
      return { answer: 4, tool: s.tool };
    }
  });
  assert.ok(executed);
  assert.equal(result.answer, 4);
});

test('autoSelectCandidates isolates single dominant winner', () => {
  const candidates = [
    { name: 'git_commit', score: 0.65, probability: 0.95 },
    { name: 'git_status', score: 0.22, probability: 0.70 },
    { name: 'fs_read', score: 0.15, probability: 0.60 }
  ];
  const selected = toolPrune.autoSelectCandidates(candidates);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].name, 'git_commit');
});

test('autoSelectCandidates clusters closely scoring tools', () => {
  const candidates = [
    { name: 'git_diff', score: 0.42, probability: 0.85 },
    { name: 'git_status', score: 0.38, probability: 0.82 },
    { name: 'file_read', score: 0.10, probability: 0.40 }
  ];
  const selected = toolPrune.autoSelectCandidates(candidates);
  assert.equal(selected.length, 2);
  assert.equal(selected[0].name, 'git_diff');
  assert.equal(selected[1].name, 'git_status');
});

test('ToolPruner filter defaults to auto selection when k is omitted or auto', async () => {
  const tools = {
    git_commit: 'Record changes to the repository with a commit message',
    git_status: 'Show working tree status and untracked files',
    calculator: 'Evaluate mathematical expressions',
    weather: 'Get current weather forecast'
  };
  const pruner = new ToolPruner(tools, { engine: 'turboquant' });
  const autoPruned = await pruner.filter('commit changes with fix');
  assert.ok(Array.isArray(autoPruned));
  assert.ok(autoPruned.length >= 1 && autoPruned.length <= 2);
  assert.equal(autoPruned[0].name, 'git_commit');

  const explicitAuto = await pruner.filter('commit changes with fix', { k: 'auto' });
  assert.deepEqual(autoPruned, explicitAuto);

  const autoMethod = await pruner.auto('commit changes with fix');
  assert.deepEqual(autoPruned, autoMethod);
});

test('toolPrune.auto one-shot function returns auto-selected candidates', async () => {
  const tools = {
    git_commit: 'Record changes to the repository with a commit message',
    weather: 'Get current weather forecast'
  };
  const selected = await toolPrune.auto('commit changes', tools, { engine: 'turboquant' });
  assert.ok(Array.isArray(selected));
  assert.equal(selected[0].name, 'git_commit');
});
