import type { Migration } from '../migrator.ts';
import { initialSchema } from './0001-initial-schema.ts';
import { syncEngineSchema } from './0002-sync-engine.ts';

/**
 * The ordered migration list. To add one: create `NNNN-description.ts` exporting a `Migration` with the next version
 * number, append it HERE, never edit or reorder an earlier entry (the migrator verifies checksums), and add a test that
 * the resulting schema still serves the repositories. See DATABASE.md "Adding a migration".
 */
export const migrations: readonly Migration[] = [initialSchema, syncEngineSchema];
