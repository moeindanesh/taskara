-- A call is external communication even when its staff summary is internal. Keep direction on the
-- call fact itself so reporting and SLA logic never have to infer it from mutable presentation.
ALTER TABLE "SupportCallDetail"
  ADD COLUMN "direction" "SupportInteractionDirection";

-- Legacy call details inherit the enclosing interaction direction. INTERNAL was the historical
-- manual-call placeholder, not a valid call direction, so coerce it conservatively to INBOUND.
UPDATE "SupportCallDetail" AS call
SET "direction" = CASE
  WHEN interaction."direction" = 'OUTBOUND'
    THEN 'OUTBOUND'::"SupportInteractionDirection"
  ELSE 'INBOUND'::"SupportInteractionDirection"
END
FROM "SupportInteraction" AS interaction
WHERE interaction."workspaceId" = call."workspaceId"
  AND interaction."id" = call."interactionId";

ALTER TABLE "SupportCallDetail"
  ALTER COLUMN "direction" SET NOT NULL;

ALTER TABLE "SupportCallDetail"
  ADD CONSTRAINT "SupportCallDetail_external_direction"
  CHECK ("direction" IN ('INBOUND', 'OUTBOUND'));
