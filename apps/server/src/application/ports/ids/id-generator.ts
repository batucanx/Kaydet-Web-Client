/** Source of opaque server-issued ids (labels, outbox operations…). Ids carry no meaning and are never parsed. */
export interface IdGenerator {
  next(): string;
}
