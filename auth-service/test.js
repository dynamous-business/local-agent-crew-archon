'use strict';
// Run with: node auth-service/test.js

const assert = require('node:assert/strict');
const { createHmac, timingSafeEqual } = require('node:crypto');

// ── isSafeRedirect ─────────────────────────────────────────────────────────
const { isSafeRedirect } = require('./server.js');

// Safe paths (must return true)
assert.equal(isSafeRedirect('/'), true, 'root path');
assert.equal(isSafeRedirect('/dashboard'), true, 'normal path');
assert.equal(isSafeRedirect('/api/health'), true, 'nested path');
assert.equal(isSafeRedirect('/api/v1/resource'), true, 'deep nested path');

// Open redirect attempts (must return false)
assert.equal(isSafeRedirect('//evil.com'), false, 'protocol-relative //');
assert.equal(isSafeRedirect('/\\evil.com'), false, 'backslash after slash');
assert.equal(isSafeRedirect('https://evil.com'), false, 'absolute https');
assert.equal(isSafeRedirect('http://evil.com'), false, 'absolute http');
assert.equal(isSafeRedirect('javascript://'), false, 'javascript scheme');
assert.equal(isSafeRedirect('//'), false, 'bare //');
assert.equal(isSafeRedirect(''), false, 'empty string');
assert.equal(isSafeRedirect('relative/no-leading-slash'), false, 'no leading slash');

console.log('isSafeRedirect: all assertions passed');

// ── signCookie / verifyCookie ──────────────────────────────────────────────
// Session payload format: `authenticated.<expUnixSeconds>.<credFingerprint>`.
const { signCookie, verifyCookie, CRED_FINGERPRINT } = require('./server.js');

const now = Math.floor(Date.now() / 1000);
const payload = (exp, fp = CRED_FINGERPRINT) => `authenticated.${exp}.${fp}`;

// Round-trip: a fresh session cookie verifies
assert.equal(
  verifyCookie(signCookie(payload(now + 3600)), now),
  'authenticated',
  'fresh cookie round-trip'
);

// Cookie is rejected once COOKIE_MAX_AGE has passed (exp must be > now)
assert.equal(
  verifyCookie(signCookie(payload(now + 10)), now + 10),
  null,
  'cookie at its expiry instant is rejected'
);
assert.equal(
  verifyCookie(signCookie(payload(now + 10)), now + 11),
  null,
  'expired cookie returns null'
);

// Cookie whose exp is in the past returns null against the current clock
assert.equal(verifyCookie(signCookie(payload(now - 1))), null, 'past-exp cookie returns null');

// Correctly signed but bound to different credentials returns null
assert.equal(
  verifyCookie(signCookie(payload(now + 3600, 'deadbeefdeadbeef'))),
  null,
  'wrong credential fingerprint returns null'
);

// Legacy single-segment payload (`authenticated.<sig>`) returns null
assert.equal(verifyCookie(signCookie('authenticated')), null, 'legacy cookie returns null');

// Tampered signature on a multi-segment payload returns null
const multi = signCookie(payload(now + 3600));
const tamper = multi.slice(-3) === 'AAA' ? 'BBB' : 'AAA';
assert.equal(verifyCookie(multi.slice(0, -3) + tamper), null, 'tampered signature returns null');

// Non-numeric exp returns null
assert.equal(
  verifyCookie(signCookie(`authenticated.notanumber.${CRED_FINGERPRINT}`)),
  null,
  'non-numeric exp returns null'
);

// Missing dot returns null
assert.equal(verifyCookie('nodothere'), null, 'missing dot returns null');

// Empty string returns null
assert.equal(verifyCookie(''), null, 'empty string returns null');

// Wrong secret returns null — construct a cookie signed with a different secret
const fresh = payload(now + 3600);
const wrongSig = createHmac('sha256', 'wrong-secret').update(fresh).digest('base64url');
assert.equal(verifyCookie(`${fresh}.${wrongSig}`), null, 'wrong secret returns null');

console.log('signCookie/verifyCookie: all assertions passed');
console.log('All tests passed.');
