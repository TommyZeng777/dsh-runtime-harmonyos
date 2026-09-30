import {createHash} from 'harmonyos-node-compat/crypto';
import {segmentedRecordStorage} from './session-segments.js';

// Session storage on a minimal host store: `read(name)` returns the text or null,
// `write(name, text)` replaces it atomically and durably before resolving
// (harmony/DshFileStore.ets: temp file, fsync, rename). Names are [a-z0-9-]{1,80}.
//
// Layout: `index` is the session index; `r-<sha256>` are immutable records named by
// their content hash; a record larger than CHUNK_CHARS is stored as a manifest of
// `c-<sha256>` chunks, because one host message and one ArkTS string have size limits.
// Every read is verified against its hash. `p-<sha256(id)>` holds projection snapshots.
const CHUNK_CHARS = 300000;
const MAX_CHUNKS = 4096;
const INDEX = 'index';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const isKey = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);

// Split without separating a surrogate pair.
function chunks(text) {
  const parts = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) { const last = text.charCodeAt(end - 1); if (last >= 0xd800 && last <= 0xdbff) end--; }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

export function createBlobSessionStorage(store) {
  if (typeof store?.read !== 'function' || typeof store?.write !== 'function') throw Error('store.read and store.write are required');

  // Write-once blobs: an existing blob must already hold exactly this text.
  // A failed write whose readback shows the text is treated as written.
  async function writeOnce(name, text) {
    const current = await store.read(name);
    if (current !== null) { if (current !== text) throw Error('session_blob_hash_collision'); return; }
    try { await store.write(name, text); }
    catch (writeError) {
      let actual;
      try { actual = await store.read(name); }
      catch (readError) { throw Object.assign(new Error('Session blob write result unconfirmed'), {cause: writeError, readbackError: readError}); }
      if (actual !== text) throw writeError;
    }
  }

  async function readRecord(key) {
    if (!isKey(key)) throw Error('invalid_session_record_key');
    const stored = await store.read('r-' + key);
    if (stored === null) return null;
    if (!stored.startsWith('{"dshChunks":')) {
      if (sha256(stored) !== key) throw Error('session_record_digest_mismatch');
      return stored;
    }
    const manifest = JSON.parse(stored);
    if (manifest.dshChunks !== 1 || manifest.sha256 !== key || !Array.isArray(manifest.chunks) || !manifest.chunks.length
      || manifest.chunks.length > MAX_CHUNKS || !manifest.chunks.every(isKey)) throw Error('invalid_session_chunk_manifest');
    const digest = createHash('sha256'), parts = [];
    for (const chunk of manifest.chunks) {
      const part = await store.read('c-' + chunk);
      if (typeof part !== 'string' || sha256(part) !== chunk) throw Error('session_chunk_missing_or_corrupt');
      digest.update(part); parts.push(part);
    }
    if (digest.digest('hex') !== key) throw Error('session_record_digest_mismatch');
    return parts.join('');
  }

  async function writeRecord(text) {
    if (typeof text !== 'string') throw Error('invalid_session_record_text');
    const key = sha256(text);
    if (text.length <= CHUNK_CHARS) { await writeOnce('r-' + key, text); return key; }
    const parts = chunks(text);
    if (parts.length > MAX_CHUNKS) throw Error('session_record_too_large');
    const keys = [];
    for (const part of parts) { const chunk = sha256(part); await writeOnce('c-' + chunk, part); keys.push(chunk); }
    // The manifest is written last, so a record is visible only once all its chunks are.
    await writeOnce('r-' + key, JSON.stringify({dshChunks: 1, sha256: key, chunks: keys}));
    return key;
  }

  const storage = {
    readText: () => store.read(INDEX),
    // A lost reply after the host's atomic rename is ambiguous: exact readback
    // confirms success without replaying the update. Anything else is a failure.
    async replaceText(text) {
      try { await store.write(INDEX, text); }
      catch (writeError) {
        let current;
        try { current = await store.read(INDEX); }
        catch (readError) { throw Object.assign(new Error('Session index write result unconfirmed'), {cause: writeError, readbackError: readError}); }
        if (current !== text) throw writeError;
      }
    },
    readRecord,
    writeRecord,
    writeProjection: (id, key, snapshot) => store.write('p-' + sha256('projection:' + id), JSON.stringify({key, snapshot})),
  };
  return segmentedRecordStorage(storage);
}

// In-memory store for tests and previews; same contract as the host store.
export function createMemoryStore() {
  const files = new Map();
  return {
    files,
    async read(name) { return files.has(name) ? files.get(name) : null; },
    async write(name, text) {
      if (!/^[a-z0-9-]{1,80}$/.test(name)) throw Error('invalid_store_name');
      if (typeof text !== 'string') throw Error('invalid_store_text');
      files.set(name, text);
    },
  };
}
