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

test('ToolPruner throws if API key missing', async () => {
  const pruner = new ToolPruner({ read: 'Read file' }, { apiKey: '' });
  // force apiKey undefined
  pruner.apiKey = undefined;
  await assert.rejects(
    async () => await pruner.select('read a file'),
    /TypeSafe API key required/
  );
});
