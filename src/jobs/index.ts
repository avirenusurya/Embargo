/** Registers every job handler (import for side effects). */
import '../ingest/pipeline.ts';
import '../core/contextManager.ts';
import '../core/consent.ts';
import '../core/revoke.ts';
import '../chain/records.ts';
import './schedules.ts';
import { registerHandler } from './queue.ts';
import { getDb } from '../db/index.ts';
import * as tg from '../integrations/tigergraph.ts';

// Outbox-cursor based: each job syncs every graph.sync event up to its own outbox id (see syncFromCursor).
registerHandler('graph.sync', async (_p, meta) => { if (tg.enabled()) await tg.syncFromCursor(await getDb(), meta.id); });
