import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForAppleScript, SAFE_ID_RE, parseTimestamp, shouldNotify } from '../task-health-monitor.js';

describe('sanitizeForAppleScript', () => {
  test('escapes double quotes', () => {
    assert.equal(sanitizeForAppleScript('hello"world'), 'hello\\"world');
  });

  test('escapes backslashes', () => {
    assert.equal(sanitizeForAppleScript('a\\b'), 'a\\\\b');
  });

  test('escapes both backslashes and quotes', () => {
    assert.equal(sanitizeForAppleScript('a\\"b'), 'a\\\\\\"b');
  });

  test('leaves normal text unchanged', () => {
    assert.equal(sanitizeForAppleScript('hello world'), 'hello world');
  });
});

describe('SAFE_ID_RE', () => {
  test('accepts alphanumeric ids', () => {
    assert.equal(SAFE_ID_RE.test('agent-1'), true);
    assert.equal(SAFE_ID_RE.test('my_agent'), true);
    assert.equal(SAFE_ID_RE.test('ABC123'), true);
  });

  test('rejects ids with special chars', () => {
    assert.equal(SAFE_ID_RE.test('id with spaces'), false);
    assert.equal(SAFE_ID_RE.test('id"quote'), false);
    assert.equal(SAFE_ID_RE.test('id\\slash'), false);
    assert.equal(SAFE_ID_RE.test('id.dot'), false);
  });
});

describe('parseTimestamp', () => {
  test('parses ISO string with Z', () => {
    const ms = parseTimestamp('2026-06-08T12:00:00Z');
    assert.ok(ms > 0);
  });

  test('parses ISO string without Z (appends Z)', () => {
    const withZ = parseTimestamp('2026-06-08T12:00:00Z');
    const withoutZ = parseTimestamp('2026-06-08T12:00:00');
    assert.equal(withZ, withoutZ);
  });

  test('parses ISO string with timezone offset', () => {
    const ms = parseTimestamp('2026-06-08T12:00:00+08:00');
    assert.ok(ms > 0);
  });

  test('returns 0 for null', () => {
    assert.equal(parseTimestamp(null), 0);
  });

  test('returns 0 for undefined', () => {
    assert.equal(parseTimestamp(undefined), 0);
  });

  test('returns 0 for empty string', () => {
    assert.equal(parseTimestamp(''), 0);
  });

  test('returns 0 for invalid date string', () => {
    assert.equal(parseTimestamp('not-a-date'), 0);
  });
});

describe('shouldNotify', () => {
  test('returns true on first call for a task', () => {
    assert.equal(shouldNotify('test-task-1'), true);
  });

  test('returns false on second call within dedup window', () => {
    assert.equal(shouldNotify('test-task-2'), true);
    assert.equal(shouldNotify('test-task-2'), false);
  });

  test('returns true after dedup window expires', () => {
    let t = 1000;
    const clock = { now: () => t };
    assert.equal(shouldNotify('test-task-3', clock), true);
    t += 30 * 60 * 1000 + 1; // NOTIFY_DEDUP_MS + 1
    assert.equal(shouldNotify('test-task-3', clock), true);
  });
});
