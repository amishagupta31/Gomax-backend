import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';

export type Actor = { type: 'staff' | 'user' | 'system'; id?: string; ip?: string };

/** Append-only (a DB trigger blocks UPDATE/DELETE). Every staff action goes here. */
export async function audit(
  db: Db,
  actor: Actor,
  action: string,
  entity: string,
  entityId: string | number | null,
  before?: unknown,
  after?: unknown,
) {
  await db.insert(auditLog).values({
    actorType: actor.type,
    actorId: actor.id ?? null,
    ip: actor.ip ?? null,
    action,
    entity,
    entityId: entityId == null ? null : String(entityId),
    before: before ?? null,
    after: after ?? null,
  });
}
