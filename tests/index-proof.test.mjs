// Real optional sqlite-vec over temporary synthetic databases, no QMD store or
// model invocation. The observer reads them without modifying the DB or config.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {prove, capSqliteAllocator} from '../src/claude_note/index_proof.mjs';

const sdk = process.env.CLAUDE_NOTE_TEST_QMD_SDK;
const requireSDK = sdk && createRequire(pathToFileURL(sdk));
const Database = requireSDK && requireSDK('better-sqlite3');
const sqliteVec = requireSDK && requireSDK('sqlite-vec');
const store = sdk && await import(pathToFileURL(join(dirname(sdk), 'store.js')).href);
const llm = sdk && await import(pathToFileURL(join(dirname(sdk), 'llm.js')).href);
const model = 'synthetic-embedding-model';
const fingerprint = store && store.getEmbeddingFingerprint(model);

function fixture(t, {body = '# Synthetic\n\nExact synthetic indexed revision.\n', normalized = false} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claude-note-vector-proof-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const database = join(root, 'index.sqlite'), configuration = join(root, 'index.yml');
  const revision = createHash('sha256').update(body).digest('hex');
  const db = new Database(database);
  sqliteVec.load(db);
  db.exec('CREATE TABLE documents(id INTEGER PRIMARY KEY,collection TEXT,path TEXT,title TEXT,hash TEXT,active INTEGER);'
    + 'CREATE TABLE content(hash TEXT PRIMARY KEY,doc TEXT);'
    + "CREATE VIRTUAL TABLE documents_fts USING fts5(filepath,title,body,tokenize='porter unicode61');"
    + 'CREATE TABLE content_vectors(hash TEXT,seq INTEGER,pos INTEGER,model TEXT,embed_fingerprint TEXT,total_chunks INTEGER,PRIMARY KEY(hash,seq));'
    + 'CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY,embedding float[2] distance_metric=cosine);');
  db.prepare('INSERT INTO documents VALUES(1,?,?,?,?,1)').run('synthetic', 'first.md', 'Synthetic', revision);
  db.prepare('INSERT INTO content VALUES(?,?)').run(revision, body);
  db.prepare('INSERT INTO documents_fts(rowid,filepath,title,body) VALUES(1,?,?,?)')
    .run('synthetic/first.md', 'Synthetic', normalized ? store.normalizeCjkForFTS(body) : body);
  for (let seq = 0; seq < 2; seq++) {
    db.prepare('INSERT INTO content_vectors VALUES(?,?,?,?,?,2)').run(revision, seq, seq * 100, model, fingerprint);
    db.prepare('INSERT INTO vectors_vec(hash_seq,embedding) VALUES(?,?)').run(`${revision}_${seq}`, new Float32Array([1, .25 + seq]));
  }
  writeFileSync(configuration, `collections: {}\nmodels:\n  embed: ${model}\n`);
  const input = {database, configuration, sdk, references: [{collection: 'synthetic', path: 'first.md', revision}], vector: true};
  t.after(() => { if (db.open) db.close(); });
  return {root, db, input, revision};
}

const native = (name, fn) => test(name, {skip: !sdk}, fn);

function partitionedFixture(t) {
  const context = fixture(t);
  const {db, revision} = context;
  db.exec('DROP TABLE vectors_vec;'
    + 'CREATE TABLE vector_collection_ids(id INTEGER PRIMARY KEY,name TEXT UNIQUE);'
    + 'CREATE TABLE vector_rows(id INTEGER PRIMARY KEY,hash TEXT,seq INTEGER,collection_id INTEGER,UNIQUE(hash,seq,collection_id));'
    + 'CREATE VIRTUAL TABLE vectors_by_collection USING vec0(collection_id INTEGER PARTITION KEY,embedding float[2] distance_metric=cosine);'
    + "INSERT INTO vector_collection_ids VALUES(1,'synthetic'),(2,'other');");
  // Both collections share content/chunk metadata but need their own vectors.
  db.prepare('INSERT INTO documents VALUES(2,?,?,?,?,1)').run('other', 'second.md', 'Synthetic', revision);
  const body = db.prepare('SELECT doc FROM content WHERE hash=?').get(revision).doc;
  db.prepare('INSERT INTO documents_fts(rowid,filepath,title,body) VALUES(2,?,?,?)')
    .run('other/second.md', 'Synthetic', body);
  for (let partition = 1; partition <= 2; partition++) {
    for (let seq = 0; seq < 2; seq++) {
      const id = partition * 10 + seq;
      db.prepare('INSERT INTO vector_rows VALUES(?,?,?,?)').run(id, revision, seq, partition);
      db.prepare('INSERT INTO vectors_by_collection(rowid,collection_id,embedding) VALUES(?,?,?)')
        .run(BigInt(id), BigInt(partition), new Float32Array([1, .25 + seq]));
    }
  }
  context.input.references.push({collection: 'other', path: 'second.md', revision});
  return context;
}

native('partitioned vectors prove every captured collection without changing DB/config', async t => {
  const {db, input, root} = partitionedFixture(t);
  db.close();
  const before = Object.fromEntries(readdirSync(root).map(name => [name, readFileSync(join(root, name))]));
  assert.deepEqual(await prove(input), {lexical: true, vector: true, reason: ''});
  assert.deepEqual(readdirSync(root).sort(), Object.keys(before).sort());
  for (const [name, body] of Object.entries(before)) assert.deepEqual(readFileSync(join(root, name)), body);
});

native('partitioned proof rejects missing mappings, missing vectors, wrong partitions and zero vectors', async t => {
  for (const scenario of ['mapping', 'vector', 'partition', 'zero', 'collection']) {
    const {db, input} = partitionedFixture(t);
    if (scenario === 'mapping') db.exec('DELETE FROM vector_rows WHERE id=21');
    if (scenario === 'collection') db.exec('DELETE FROM vector_collection_ids WHERE id=2');
    if (['vector', 'partition', 'zero'].includes(scenario))
      db.prepare('DELETE FROM vectors_by_collection WHERE rowid=?').run(21n);
    if (scenario === 'partition' || scenario === 'zero')
      db.prepare('INSERT INTO vectors_by_collection(rowid,collection_id,embedding) VALUES(?,?,?)')
        .run(21n, scenario === 'partition' ? 1n : 2n,
          new Float32Array(scenario === 'zero' ? [0, 0] : [1, .25]));
    const answer = await prove(input);
    assert.equal(answer.lexical, true, scenario);
    assert.equal(answer.vector, false, scenario);
  }
});

native('partitioned proof rejects ordinary vector storage and prefers legacy during migration', async t => {
  const {db, input} = partitionedFixture(t);
  db.exec('CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY,embedding float[2] distance_metric=cosine)');
  assert.equal((await prove(input)).vector, false);
  db.exec('DROP TABLE vectors_vec; DROP TABLE vectors_by_collection;'
    + 'CREATE TABLE vectors_by_collection(collection_id INTEGER,embedding BLOB)');
  assert.equal((await prove(input)).vector, false);
});

test('unsupported or invalid SQLite allocator caps fail closed', () => {
  for (const value of [undefined, null, 0, -1, true, '16777216', 16777217, NaN, Infinity]) {
    assert.throws(() => capSqliteAllocator({pragma: () => value}), /allocator cap/);
  }
  assert.doesNotThrow(() => capSqliteAllocator({pragma: () => 16777216}));
});

native('complete vectors prove only captured revisions and leave DB/config bytes unchanged', async t => {
  const {db, input, root} = fixture(t);
  db.close();
  const before = Object.fromEntries(readdirSync(root).map(name => [name, readFileSync(join(root, name))]));
  assert.deepEqual(await prove(input), {lexical: true, vector: true, reason: ''});
  assert.deepEqual(readdirSync(root).sort(), Object.keys(before).sort());
  for (const [name, body] of Object.entries(before)) assert.deepEqual(readFileSync(join(root, name)), body);
});

native('read-only proof uses the current WAL snapshot without changing DB or WAL bytes', async t => {
  const {db, input} = fixture(t);
  db.pragma('journal_mode=WAL');
  db.prepare('UPDATE documents SET title=?').run('Synthetic WAL');
  db.prepare('UPDATE documents_fts SET title=?').run('Synthetic WAL');
  const beforeDB = readFileSync(input.database), beforeWAL = readFileSync(input.database + '-wal');
  assert.equal((await prove(input)).vector, true);
  assert.deepEqual(readFileSync(input.database), beforeDB);
  assert.deepEqual(readFileSync(input.database + '-wal'), beforeWAL);
});

native('partial, missing, gapped, and inconsistent chunks do not prove vector completion', async t => {
  for (const scenario of ['partial', 'missing-vector', 'gap', 'inconsistent']) {
    const {db, input, revision} = fixture(t);
    if (scenario === 'partial') db.prepare('DELETE FROM content_vectors WHERE seq=1').run();
    if (scenario === 'missing-vector') db.prepare('DELETE FROM vectors_vec WHERE hash_seq=?').run(`${revision}_1`);
    if (scenario === 'gap') db.prepare('UPDATE content_vectors SET seq=2 WHERE seq=1').run();
    if (scenario === 'inconsistent') db.prepare('UPDATE content_vectors SET total_chunks=3 WHERE seq=1').run();
    const answer = await prove(input);
    assert.equal(answer.lexical, true, scenario);
    assert.equal(answer.vector, false, scenario);
  }
});

native('wrong model and stale pipeline fingerprint do not prove vector completion', async t => {
  for (const column of ['model', 'embed_fingerprint']) {
    const {db, input} = fixture(t);
    db.prepare(`UPDATE content_vectors SET ${column}=?`).run('different');
    const answer = await prove(input);
    assert.equal(answer.lexical, true);
    assert.equal(answer.vector, false);
  }
});

native('zero and nonfinite actual stored vectors cannot prove completion', async t => {
  for (const vector of [[0, 0], [Number.NaN, 1], [Infinity, 1]]) {
    const {db, input, revision} = fixture(t);
    db.prepare('DELETE FROM vectors_vec WHERE hash_seq=?').run(`${revision}_1`);
    // The native extension accepts raw floats, including invalid numeric values.
    db.prepare('INSERT INTO vectors_vec(hash_seq,embedding) VALUES(?,?)').run(`${revision}_1`, new Float32Array(vector));
    const answer = await prove(input);
    assert.equal(answer.lexical, true);
    assert.equal(answer.vector, false);
  }
});

native('missing FTS, inactive documents, and wrong content hashes deny both stages', async t => {
  for (const sql of ['DELETE FROM documents_fts', 'UPDATE documents SET active=0',
                     "UPDATE content SET doc='Different synthetic text'"]) {
    const {db, input} = fixture(t);
    db.exec(sql);
    const answer = await prove(input);
    assert.equal(answer.lexical, false);
    assert.equal(answer.vector, false);
  }
});

native('exact pinned CJK normalization is accepted', async t => {
  const {input} = fixture(t, {body: '# Synthetic\n\n日本語中文한국어 synthetic text.', normalized: true});
  assert.equal((await prove(input)).vector, true);
});

native('legacy vector columns fail closed without lazy migration', async t => {
  const {db, input} = fixture(t);
  db.exec('ALTER TABLE content_vectors DROP COLUMN embed_fingerprint');
  const before = db.pragma('table_info(content_vectors)');
  assert.equal((await prove(input)).vector, false);
  assert.deepEqual(db.pragma('table_info(content_vectors)'), before);
});

native('ordinary vector tables and unsupported SDK pins cannot prove completion', async t => {
  const {db, input, root} = fixture(t);
  db.exec('DROP TABLE vectors_vec; CREATE TABLE vectors_vec(hash_seq TEXT,embedding BLOB)');
  assert.equal((await prove(input)).vector, false);
  const wrong = join(root, 'wrong-sdk');
  const {mkdirSync} = await import('node:fs');
  mkdirSync(join(wrong, 'dist'), {recursive: true});
  writeFileSync(join(wrong, 'package.json'), JSON.stringify({name: '@tobilu/qmd', version: '2.8.4'}));
  assert.equal((await prove({...input, sdk: join(wrong, 'dist/index.js')})).lexical, false);
});

native('virtual document storage cannot bypass ordinary-column size admission', async t => {
  for (const table of ['documents', 'content']) {
    const {db, input} = fixture(t);
    db.exec(`DROP TABLE ${table}`);
    if (table === 'documents') {
      db.exec('CREATE VIRTUAL TABLE documents USING fts5(id UNINDEXED,collection,path,title,hash,active UNINDEXED)');
    } else {
      db.exec('CREATE VIRTUAL TABLE content USING fts5(hash,doc)');
    }
    const answer = await prove(input);
    assert.equal(answer.lexical, false);
    assert.equal(answer.vector, false);
  }
});

native('config-selected model takes precedence over environment and malformed models deny vector proof', async t => {
  const {input} = fixture(t);
  const prior = process.env.QMD_EMBED_MODEL;
  process.env.QMD_EMBED_MODEL = 'different-environment-model';
  t.after(() => { if (prior === undefined) delete process.env.QMD_EMBED_MODEL; else process.env.QMD_EMBED_MODEL = prior; });
  assert.equal((await prove(input)).vector, true);
  writeFileSync(input.configuration, 'models:\n  embed: [unsupported, list]\n');
  assert.equal((await prove(input)).vector, false);
});

native('oversized FTS/title fields fail closed before body proof', async t => {
  for (const sql of ['UPDATE documents SET title=?', 'UPDATE documents_fts SET title=?',
                     'UPDATE documents_fts SET filepath=?', 'UPDATE documents_fts SET body=?']) {
    const {db, input} = fixture(t);
    const size = sql.endsWith('body=?') ? 1024 * 1024 + 1 : 16385;
    db.prepare(sql).run('x'.repeat(size));
    assert.equal((await prove(input)).lexical, false);
  }
});
