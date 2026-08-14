import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateRecord } from '../src/migrate.mjs';

test('migrates v1 while preserving identity and metadata', () => {
  const source = { version: 1, id: 'u-1', name: ' Ada ', emailOptIn: true, metadata: { source: 'import' }, extra: 7 };
  const migrated = migrateRecord(source);
  assert.deepEqual(migrated, {
    version: 2,
    id: 'u-1',
    displayName: 'Ada',
    preferences: { emailNotifications: true },
    metadata: { source: 'import' },
    extra: 7,
  });
  assert.notEqual(migrated, source);
  assert.equal(source.version, 1);
});

test('keeps v2 idempotent and supplies safe defaults', () => {
  const v2 = { version: 2, id: 'u-2', displayName: 'Grace', preferences: { emailNotifications: false }, note: 'keep' };
  assert.deepEqual(migrateRecord(v2), v2);
  assert.notEqual(migrateRecord(v2), v2);
  assert.deepEqual(
    migrateRecord({ version: 1, id: 'u-3', name: 'Lin', metadata: {} }).preferences,
    { emailNotifications: false },
  );
  assert.throws(() => migrateRecord({ version: 3, id: 'u-4' }), /unsupported/i);
});
