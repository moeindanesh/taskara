-- CreateIndex
-- Serves the people-side predicate `{ role: { not: 'GUEST' }, user: { kind: 'HUMAN' } }`, which every
-- human-facing measurement composes so agent Users stay visible as teammates but are never counted.
-- Separate from 20260731140000_user_kind because that migration was already applied.
CREATE INDEX "User_kind_idx" ON "User"("kind");
