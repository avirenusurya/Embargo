/** Runs pending migrations (also run automatically on startup). */
import { getDb } from './index.ts';
const db = await getDb();
console.log('Migrations applied:', (await db.query('SELECT name FROM schema_migrations ORDER BY name')).map((r) => r.name).join(', '));
await db.close();
