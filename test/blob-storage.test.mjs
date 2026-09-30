import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setSha256Factory} from 'harmonyos-node-compat/crypto';
import {createBlobSessionStorage, createMemoryStore} from '../src/runtime/blob-storage.js';

setSha256Factory(() => { const h = createHash('sha256'); return {update: b => h.update(b), digest: () => new Uint8Array(h.digest())}; });
const sha = text => createHash('sha256').update(text).digest('hex');

test('records are content-addressed and verified on read', async () => {
  const store = createMemoryStore(), storage = createBlobSessionStorage(store);
  const text = JSON.stringify({header: {id: 'a'}, inheritedEventCount: 0, events: []});
  const key = await storage.writeRecord(text);
  assert.equal(key, sha(text));
  assert.equal(await storage.readRecord(key), text);
  assert.equal(await storage.writeRecord(text), key, 'rewriting identical content is a no-op');
  store.files.set('r-' + key, text.replace('"a"', '"b"'));
  await assert.rejects(storage.readRecord(key), /digest_mismatch/);
  assert.equal(await storage.readRecord('0'.repeat(64)), null);
  await assert.rejects(storage.readRecord('../index'), /invalid_session_record_key/);
});

test('large records are chunked without splitting surrogate pairs, and every chunk is checked', async () => {
  const store = createMemoryStore(), storage = createBlobSessionStorage(store);
  const text = JSON.stringify({header: {id: 'big'}, inheritedEventCount: 0, events: [], pad: 'x'.repeat(299998) + '😀'.repeat(200000)});
  const key = await storage.writeRecord(text);
  const chunkNames = [...store.files.keys()].filter(name => name.startsWith('c-'));
  assert.ok(chunkNames.length >= 2);
  for (const name of chunkNames) {
    const part = store.files.get(name);
    assert.equal(/[\uD800-\uDBFF]$/.test(part), false, 'no chunk ends inside a surrogate pair');
  }
  assert.equal(await storage.readRecord(key), text);
  const [first] = chunkNames;
  store.files.set(first, store.files.get(first).slice(1));
  await assert.rejects(storage.readRecord(key), /chunk_missing_or_corrupt/);
});

test('an index write whose reply is lost is confirmed by readback, otherwise it fails', async () => {
  const store = createMemoryStore();
  const lossy = {read: store.read, async write(name, text) { await store.write(name, text); throw Error('reply lost'); }};
  const storage = createBlobSessionStorage(lossy);
  await storage.replaceText('{"version":2,"sessions":[]}');
  assert.equal(await storage.readText(), '{"version":2,"sessions":[]}');
  const failing = createBlobSessionStorage({read: store.read, async write() { throw Error('disk full'); }});
  await assert.rejects(failing.replaceText('{"version":2,"sessions":[1]}'), /disk full/);
});

test('store names are restricted', async () => {
  const store = createMemoryStore();
  await assert.rejects(store.write('../escape', 'x'), /invalid_store_name/);
  await assert.rejects(store.write('Index', 'x'), /invalid_store_name/);
});
