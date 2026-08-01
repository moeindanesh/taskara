import { describe, expect, test } from 'bun:test';
import { envSchema, parseEnvFlag } from './config';

/**
 * Issue #42, the half of the sweep that has no caller to answer.
 *
 * A query parameter that cannot be parsed gets a 400, because someone asked. An environment
 * variable is read once at boot with nobody listening, so the same rule — never silently
 * reinterpret a value we do not understand — has to be paid for differently: the process refuses to
 * start. Falling back to the default is the one option actively rejected, because the default is
 * precisely what the operator was trying to change, so the fallback is indistinguishable from the
 * bug and the deployment comes up wrong and quiet.
 *
 * The accepted vocabulary is wider here than in a query string on purpose. A compose file is written
 * by a person, and `1`, `yes` and `on` already work today; narrowing them would break running
 * deployments and prevent nothing. What changes is only the else-branch.
 */

/** The variables with no default, so a `safeParse` is testing the flag and not the scaffolding. */
const baseEnv = {
  API_HOST: '127.0.0.1',
  API_PORT: '4000',
  WEB_ORIGIN: 'http://localhost:3005',
  MATTERMOST_SYNTHETIC_EMAIL_DOMAIN: 'mattermost.example.invalid'
};

const flags = [
  // Defaults off. `z.coerce.boolean()` read "false" as true, so writing the word that means off was
  // the one way to turn this on by accident.
  'TASKARA_SCHEDULED_JOBS_ENABLED',
  'TASKARA_DAILY_REPORT_SMS_ENABLED',
  // Defaults on, and closes an authentication path when off.
  'TASKARA_EMAIL_HEADER_AUTH'
] as const;

function parseEnv(overrides: Record<string, string>) {
  return envSchema.safeParse({ ...baseEnv, ...overrides });
}

describe('environment flags read the word an operator wrote', () => {
  test('every flag reads "false" as off, including the two that default off', () => {
    for (const flag of flags) {
      const parsed = parseEnv({ [flag]: 'false' });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data[flag]).toBe(false);
    }
  });

  test('every flag reads "true" as on, including the one that defaults on', () => {
    for (const flag of flags) {
      const parsed = parseEnv({ [flag]: 'true' });
      expect(parsed.success && parsed.data[flag]).toBe(true);
    }
  });

  test('the spellings an operator actually writes keep working', () => {
    for (const off of ['FALSE', 'False', '0', 'no', 'off', ' off ']) {
      expect(parseEnv({ TASKARA_EMAIL_HEADER_AUTH: off }).success).toBe(true);
      const parsed = parseEnv({ TASKARA_EMAIL_HEADER_AUTH: off });
      expect(parsed.success && parsed.data.TASKARA_EMAIL_HEADER_AUTH).toBe(false);
    }
    for (const on of ['TRUE', '1', 'yes', 'on']) {
      const parsed = parseEnv({ TASKARA_SCHEDULED_JOBS_ENABLED: on });
      expect(parsed.success && parsed.data.TASKARA_SCHEDULED_JOBS_ENABLED).toBe(true);
    }
  });

  test('a value nobody can read refuses to boot rather than picking a side', () => {
    for (const flag of flags) {
      // "flase" is the whole ticket in one string: a typo that used to mean `true`, so an operator
      // disabling the legacy auth path would have enabled it and been told nothing.
      for (const value of ['flase', 'banana', 'maybe', '2', 'null']) {
        const parsed = parseEnv({ [flag]: value });
        expect(parsed.success).toBe(false);
        // The variable has to be named, or a boot crash is a scavenger hunt across thirty settings.
        expect(parsed.success === false && parsed.error.issues[0].path).toEqual([flag]);
      }
    }
  });

  test('an absent or blank flag still falls back to its default', () => {
    const parsed = parseEnv({});
    expect(parsed.success && parsed.data.TASKARA_EMAIL_HEADER_AUTH).toBe(true);
    expect(parsed.success && parsed.data.TASKARA_SCHEDULED_JOBS_ENABLED).toBe(false);
    expect(parsed.success && parsed.data.TASKARA_DAILY_REPORT_SMS_ENABLED).toBe(false);

    const blank = parseEnv({ TASKARA_EMAIL_HEADER_AUTH: '', TASKARA_SCHEDULED_JOBS_ENABLED: '' });
    expect(blank.success && blank.data.TASKARA_EMAIL_HEADER_AUTH).toBe(true);
    expect(blank.success && blank.data.TASKARA_SCHEDULED_JOBS_ENABLED).toBe(false);
  });

  test('parseEnvFlag resolves the words it knows and echoes back the ones it does not', () => {
    expect(parseEnvFlag('false', true)).toBe(false);
    expect(parseEnvFlag('on', false)).toBe(true);
    expect(parseEnvFlag(undefined, true)).toBe(true);
    // Echoed rather than guessed: the schema behind it is what turns this into a boot failure that
    // still knows which variable was wrong.
    expect(parseEnvFlag('flase', true)).toBe('flase');
  });
});
