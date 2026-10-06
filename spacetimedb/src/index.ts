import { schema, table, t, SenderError } from 'spacetimedb/server';

import { validateStateDocument } from '../../src/shared/stateValidation.js';
const owner = table({ name: 'bootstrap_owner' }, { key: t.string().primaryKey(), identity: t.identity() });
const services = table({ name: 'service_identity' }, { identity: t.identity().primaryKey() });
const documents = table({ name: 'state_document' }, {
  key: t.string().primaryKey(), instance: t.string().index('btree'), kind: t.string(), guildId: t.string(), value: t.string(), revision: t.u64(),
});
const sequence = table({ name: 'state_sequence' }, { key: t.string().primaryKey(), revision: t.u64() });
const db = schema({ owner, services, documents, sequence });
export default db;

export const init = db.init(ctx => {
  ctx.db.owner.insert({ key: 'owner', identity: ctx.sender });
  ctx.db.sequence.insert({ key: 'sequence', revision: 0n });
});
export const authorizeService = db.reducer({ identity: t.identity() }, (ctx, { identity }) => {
  if (!ctx.db.owner.key.find('owner')?.identity.isEqual(ctx.sender)) throw new SenderError('Access denied.');
  if (!ctx.db.services.identity.find(identity)) ctx.db.services.insert({ identity });
});
export const serviceDocuments = db.view({ name: 'service_documents', public: true }, t.array(documents.rowType), ctx => {
  if (!ctx.db.services.identity.find(ctx.sender)) return [];
  return Array.from(ctx.db.documents.instance.filter('nox-bot'));
});
export const serviceSequence = db.view({ name: 'service_sequence', public: true }, t.option(sequence.rowType), ctx => {
  if (!ctx.db.services.identity.find(ctx.sender)) return undefined;
  return ctx.db.sequence.key.find('sequence') ?? undefined;
});
const change = t.object('StateMutation', {
  key: t.string(), kind: t.string(), guildId: t.string(), value: t.option(t.string()), expectedRevision: t.u64(),
});
export const mutateState = db.reducer({ changes: t.array(change) }, (ctx, { changes }) => {
  if (!ctx.db.services.identity.find(ctx.sender)) throw new SenderError('Access denied.');
  if (changes.length < 1 || changes.length > 1000) throw new SenderError('Invalid mutation batch.');
  const keys = new Set<string>();
  const seq = ctx.db.sequence.key.find('sequence');
  if (!seq) throw new SenderError('State is not initialized.');
  const revision = seq.revision + 1n;
  for (const c of changes) {
    if (keys.has(c.key)) throw new SenderError('Duplicate mutation key.');
    keys.add(c.key);
    try { validateStateDocument(c.kind, c.guildId, c.key, c.value === undefined ? undefined : JSON.parse(c.value)); } catch { throw new SenderError('Invalid state document.'); }
    const existing = ctx.db.documents.key.find(c.key);
    if ((existing?.revision ?? 0n) !== c.expectedRevision) throw new SenderError('STATE_CONFLICT');
    if (c.value !== undefined) {
      if (c.value.length > 65536) throw new SenderError('State value too large.');
      const value: unknown = JSON.parse(c.value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SenderError('Invalid state value.');
      const row = { key: c.key, instance: 'nox-bot', kind: c.kind, guildId: c.guildId, value: c.value, revision };
      if (existing) ctx.db.documents.key.update(row); else ctx.db.documents.insert(row);
    } else if (existing) ctx.db.documents.key.delete(c.key);
  }
  ctx.db.sequence.key.update({ key: 'sequence', revision });
});

