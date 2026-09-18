import test from 'node:test';
import assert from 'node:assert/strict';
import toolPrune, { ToolPruner, normalizeTools } from '../index.js';

test('normalizeTools accepts dictionary format', () => {
  const { criteria, registry } = normalizeTools({
    read: 'Read file contents',
    write: { description: 'Write file contents' }
  });
  assert.equal(criteria.read, 'Read file contents');
  assert.equal(criteria.write, 'Write file contents');
  assert.equal(registry.get('read').name, 'read');
});

test('normalizeTools accepts array format', () => {
  const { criteria, registry } = normalizeTools([
    { name: 'read', description: 'Read file' },
    { id: 'write', criteria: 'Write file' }
  ]);
  assert.equal(criteria.read, 'Read file');
  assert.equal(criteria.write, 'Write file');
  assert.equal(registry.get('read').name, 'read');
});

test('ToolPruner can be instantiated', () => {
  const pruner = toolPrune({
    read: 'Read file',
    write: 'Write file'
  });
  assert.ok(pruner instanceof ToolPruner);
  assert.equal(typeof pruner.select, 'function');
  assert.equal(typeof pruner.filter, 'function');
  assert.equal(typeof pruner.dispatch, 'function');
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
  assert.ok(res.confidence > 0);
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

