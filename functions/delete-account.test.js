const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
    AccountDeletionError,
    createDeleteAccountHandler
} = require('./delete-account');

const NOW_MS = Date.UTC(2026, 7, 14, 12, 0, 0);
const freshAuth = {
    uid: 'user-123',
    token: { auth_time: Math.floor((NOW_MS - 60_000) / 1000) }
};

function createFakes({ recursiveFailure, authFailure } = {}) {
    const calls = [];
    const userReference = { path: 'users/user-123' };
    const db = {
        doc(path) {
            calls.push(['doc', path]);
            return userReference;
        },
        async recursiveDelete(reference) {
            calls.push(['recursiveDelete', reference.path]);
            if (recursiveFailure) throw recursiveFailure;
        }
    };
    const auth = {
        async deleteUser(uid) {
            calls.push(['deleteUser', uid]);
            if (authFailure) throw authFailure;
        }
    };
    return { auth, calls, db };
}

function makeHandler(fakes) {
    return createDeleteAccountHandler({
        db: fakes.db,
        auth: fakes.auth,
        now: () => NOW_MS,
        maxAuthAgeMs: 5 * 60 * 1000
    });
}

test('rejects a request without an authenticated user', async () => {
    const fakes = createFakes();
    const handler = makeHandler(fakes);

    await assert.rejects(
        () => handler({ auth: null }),
        (error) => error instanceof AccountDeletionError && error.code === 'unauthenticated'
    );
    assert.deepEqual(fakes.calls, []);
});

test('rejects a missing, malformed, stale, or future auth_time', async (t) => {
    const cases = [
        ['missing', {}],
        ['malformed', { auth_time: 'now' }],
        ['stale', { auth_time: Math.floor((NOW_MS - 301_000) / 1000) }],
        ['future', { auth_time: Math.floor((NOW_MS + 61_000) / 1000) }]
    ];

    for (const [name, token] of cases) {
        await t.test(name, async () => {
            const fakes = createFakes();
            const handler = makeHandler(fakes);
            await assert.rejects(
                () => handler({ auth: { uid: 'user-123', token } }),
                (error) => error instanceof AccountDeletionError && error.code === 'failed-precondition'
            );
            assert.deepEqual(fakes.calls, []);
        });
    }
});

test('recursively deletes the user document before deleting the Auth account', async () => {
    const fakes = createFakes();
    const handler = makeHandler(fakes);

    const result = await handler({ auth: freshAuth });

    assert.deepEqual(result, { deleted: true });
    assert.deepEqual(fakes.calls, [
        ['doc', 'users/user-123'],
        ['recursiveDelete', 'users/user-123'],
        ['deleteUser', 'user-123']
    ]);
});

test('does not delete the Auth account if recursive data deletion fails', async () => {
    const failure = new Error('Firestore unavailable');
    const fakes = createFakes({ recursiveFailure: failure });
    const handler = makeHandler(fakes);

    await assert.rejects(() => handler({ auth: freshAuth }), failure);
    assert.deepEqual(fakes.calls, [
        ['doc', 'users/user-123'],
        ['recursiveDelete', 'users/user-123']
    ]);
});

test('treats auth/user-not-found as an idempotent successful retry', async () => {
    const missingUser = Object.assign(new Error('Already deleted'), { code: 'auth/user-not-found' });
    const fakes = createFakes({ authFailure: missingUser });
    const handler = makeHandler(fakes);

    assert.deepEqual(await handler({ auth: freshAuth }), { deleted: true });
    assert.deepEqual(fakes.calls.at(-1), ['deleteUser', 'user-123']);
});

test('propagates unexpected Auth deletion failures after data deletion', async () => {
    const failure = Object.assign(new Error('Auth unavailable'), { code: 'auth/internal-error' });
    const fakes = createFakes({ authFailure: failure });
    const handler = makeHandler(fakes);

    await assert.rejects(() => handler({ auth: freshAuth }), failure);
    assert.deepEqual(fakes.calls, [
        ['doc', 'users/user-123'],
        ['recursiveDelete', 'users/user-123'],
        ['deleteUser', 'user-123']
    ]);
});

test('Firebase index exposes the handler through a v2 authenticated callable', () => {
    const source = readFileSync(join(__dirname, 'index.js'), 'utf8');
    assert.match(source, /require\(['"]\.\/delete-account['"]\)/);
    assert.match(source, /exports\.deleteAccount\s*=\s*onCall\(/);
    assert.match(source, /createDeleteAccountHandler\(\{[\s\S]*?db:\s*admin\.firestore\(\)[\s\S]*?auth:\s*admin\.auth\(\)/);
    assert.match(source, /error instanceof AccountDeletionError/);
    assert.match(source, /new HttpsError\(error\.code,\s*error\.message\)/);
    assert.match(source, /new HttpsError\(['"]internal['"]/);
});
