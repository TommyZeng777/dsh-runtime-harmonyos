import test from 'node:test';
import assert from 'node:assert/strict';
import {validateToolDeclaration, needsApproval} from '../src/runtime/app-tools.js';

test('declarations are validated and normalized for DSH', () => {
  const tool = validateToolDeclaration({name: 'save_note', description: 'Save a note.', effect: 'write',
    parameters: {title: {type: 'string', required: true}, tags: {type: 'array', required: false, items: {type: 'string', description: null}}}});
  assert.deepEqual(tool.parameters, {title: {type: 'string', required: true}, tags: {type: 'array', items: {type: 'string'}}});
  assert.equal(needsApproval(tool), true);
  assert.equal(needsApproval({...tool, autoApprove: true}), false);
  assert.equal(needsApproval(validateToolDeclaration({name: 'read_notes', description: 'Read notes.', effect: 'read'})), false);
  for (const bad of [{name: '1x', description: 'd', effect: 'read'}, {name: 'x', description: '', effect: 'read'}, {name: 'x', description: 'd', effect: 'delete'}])
    assert.throws(() => validateToolDeclaration(bad));
});
