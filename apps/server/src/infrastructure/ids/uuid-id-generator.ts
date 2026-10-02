import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '../../application/index.ts';

export class UuidIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
