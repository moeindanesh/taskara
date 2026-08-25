-- A referenced SLA policy's clock-defining fields remain immutable. Operational retirement is not
-- a clock rewrite: `active` and `effectiveUntil` only control selection for future cycles, so an
-- administrator must still be able to retire a version after its first clock starts.
CREATE OR REPLACE FUNCTION "taskara_freeze_referenced_sla_policy"() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "SupportCaseSlaClock" WHERE "policyId" = OLD."id") THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A referenced Support SLA policy version is immutable',
        CONSTRAINT = 'SupportSlaPolicy_referenced_version_immutable';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
      OR NEW."calendarId" IS DISTINCT FROM OLD."calendarId"
      OR NEW."policyKey" IS DISTINCT FROM OLD."policyKey"
      OR NEW."name" IS DISTINCT FROM OLD."name"
      OR NEW."version" IS DISTINCT FROM OLD."version"
      OR NEW."priority" IS DISTINCT FROM OLD."priority"
      OR NEW."conditions" IS DISTINCT FROM OLD."conditions"
      OR NEW."targets" IS DISTINCT FROM OLD."targets"
      OR NEW."pauseRules" IS DISTINCT FROM OLD."pauseRules"
      OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A referenced Support SLA policy version is immutable',
        CONSTRAINT = 'SupportSlaPolicy_referenced_version_immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
