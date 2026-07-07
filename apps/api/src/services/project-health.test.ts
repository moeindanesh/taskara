import { describe, expect, test } from 'bun:test';
import { projectHealthNeedsManagerAttention } from './project-health';

describe('project health rules', () => {
  test('requires manager attention for off-track updates', () => {
    expect(projectHealthNeedsManagerAttention({ health: 'OFF_TRACK', risks: null, decisionsNeeded: null })).toBe(true);
  });

  test('requires manager attention for at-risk updates with risks or decisions', () => {
    expect(projectHealthNeedsManagerAttention({ health: 'AT_RISK', risks: 'Vendor delay', decisionsNeeded: null })).toBe(true);
    expect(projectHealthNeedsManagerAttention({ health: 'AT_RISK', risks: null, decisionsNeeded: 'Approve scope cut' })).toBe(true);
  });

  test('does not page managers for on-track or empty at-risk updates', () => {
    expect(projectHealthNeedsManagerAttention({ health: 'ON_TRACK', risks: '  ', decisionsNeeded: null })).toBe(false);
    expect(projectHealthNeedsManagerAttention({ health: 'AT_RISK', risks: '  ', decisionsNeeded: null })).toBe(false);
  });
});
