/** A Kaydet user. `passwordHash` never leaves the server (no DTO carries it). */
export interface UserRecord {
  readonly id: string;
  /** Normalised login identifier (see `normaliseIdentifier`); unique. */
  readonly identifier: string;
  readonly passwordHash: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UserRepository {
  findByIdentifier(identifier: string): Promise<UserRecord | null>;
  findById(userId: string): Promise<UserRecord | null>;
  /** `false` when the identifier is already taken (uniqueness is the repository's guarantee, not a check-then-insert). */
  create(user: UserRecord): Promise<boolean>;
  /** Replaces the hash (a future password change; the caller must also revoke the user's sessions in the same unit of work). */
  updatePasswordHash(userId: string, passwordHash: string, at: Date): Promise<void>;
}
