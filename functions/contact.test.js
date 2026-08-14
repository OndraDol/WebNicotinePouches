const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ContactError,
    buildMailOptions,
    createContactHandler,
    createIdentifier,
    reserveRateLimit,
    validateContactPayload
} = require('./contact');

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);
const SECRET = 'unit-test-secret';

function validPayload(overrides = {}) {
    return {
        name: '  Ondrej  ',
        email: '  Ondrej@example.com ',
        topic: 'feature',
        message: '  Please add a compact weekly export.  ',
        website: '',
        openedAt: NOW - 5000,
        ...overrides
    };
}

function assertContactError(fn, code) {
    assert.throws(fn, (error) => error instanceof ContactError && error.code === code);
}

function createFakeDb(seed = {}) {
    const store = new Map(Object.entries(seed));
    const writes = [];
    return {
        store,
        writes,
        collection(name) {
            assert.equal(name, 'contactRateLimits');
            return {
                doc(id) {
                    return { id };
                }
            };
        },
        async runTransaction(callback) {
            const transaction = {
                async get(ref) {
                    const value = store.get(ref.id);
                    return {
                        exists: value !== undefined,
                        data: () => value
                    };
                },
                set(ref, value) {
                    writes.push({ id: ref.id, value });
                    store.set(ref.id, value);
                }
            };
            return callback(transaction);
        }
    };
}

test('valid payload is trimmed and email is normalized', () => {
    assert.deepEqual(validateContactPayload(validPayload(), NOW), {
        name: 'Ondrej',
        email: 'ondrej@example.com',
        topic: 'feature',
        message: 'Please add a compact weekly export.',
        website: '',
        openedAt: NOW - 5000
    });
});

test('validates name, email, topic and message limits', () => {
    assertContactError(() => validateContactPayload(validPayload({ name: 'x'.repeat(81) }), NOW), 'invalid-argument');
    assertContactError(() => validateContactPayload(validPayload({ email: '' }), NOW), 'invalid-argument');
    assertContactError(() => validateContactPayload(validPayload({ email: `${'x'.repeat(245)}@example.com` }), NOW), 'invalid-argument');
    assertContactError(() => validateContactPayload(validPayload({ email: 'not-an-email' }), NOW), 'invalid-argument');
    assertContactError(() => validateContactPayload(validPayload({ email: 'person,@example.com' }), NOW), 'invalid-argument');
    assertContactError(() => validateContactPayload(validPayload({ email: '"person"@example.com' }), NOW), 'invalid-argument');
    assertContactError(() => validateContactPayload(validPayload({ topic: 'sales' }), NOW), 'invalid-argument');
    assertContactError(() => validateContactPayload(validPayload({ message: 'too short' }), NOW), 'invalid-argument');
    assertContactError(() => validateContactPayload(validPayload({ message: 'x'.repeat(3001) }), NOW), 'invalid-argument');
});

test('rejects forms submitted too quickly or from a stale form', () => {
    assertContactError(() => validateContactPayload(validPayload({ openedAt: NOW - 1999 }), NOW), 'failed-precondition');
    assertContactError(() => validateContactPayload(validPayload({ openedAt: NOW - (2 * 60 * 60 * 1000) - 1 }), NOW), 'failed-precondition');
    assertContactError(() => validateContactPayload(validPayload({ openedAt: 'yesterday' }), NOW), 'failed-precondition');
});

test('HMAC identifiers are deterministic, scoped and contain no source value', () => {
    const email = 'person@example.com';
    const source = '203.0.113.25';
    const emailId = createIdentifier(SECRET, 'email', email);
    const repeated = createIdentifier(SECRET, 'email', email);
    const sourceId = createIdentifier(SECRET, 'source', source);

    assert.equal(emailId, repeated);
    assert.notEqual(emailId, sourceId);
    assert.match(emailId, /^[a-f0-9]{64}$/);
    assert.equal(emailId.includes(email), false);
    assert.equal(sourceId.includes(source), false);
});

test('source rate limit allows three attempts in fifteen minutes and rejects the fourth', async () => {
    const db = createFakeDb();
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await reserveRateLimit({
            db,
            secret: SECRET,
            source: '203.0.113.25',
            email: `person${attempt}@example.com`,
            now: NOW + attempt,
            updatedAt: 'SERVER_TIME'
        });
    }
    await assert.rejects(
        reserveRateLimit({
            db,
            secret: SECRET,
            source: '203.0.113.25',
            email: 'fourth@example.com',
            now: NOW + 3,
            updatedAt: 'SERVER_TIME'
        }),
        (error) => error instanceof ContactError && error.code === 'resource-exhausted'
    );
});

test('email rate limit allows five attempts in twenty-four hours and rejects the sixth', async () => {
    const db = createFakeDb();
    for (let attempt = 0; attempt < 5; attempt += 1) {
        await reserveRateLimit({
            db,
            secret: SECRET,
            source: `203.0.113.${attempt}`,
            email: 'same@example.com',
            now: NOW + attempt,
            updatedAt: 'SERVER_TIME'
        });
    }
    await assert.rejects(
        reserveRateLimit({
            db,
            secret: SECRET,
            source: '203.0.113.99',
            email: 'same@example.com',
            now: NOW + 5,
            updatedAt: 'SERVER_TIME'
        }),
        (error) => error instanceof ContactError && error.code === 'resource-exhausted'
    );
});

test('expired rate-limit windows reset their counters', async () => {
    const sourceId = `source_${createIdentifier(SECRET, 'source', '203.0.113.25')}`;
    const emailId = `email_${createIdentifier(SECRET, 'email', 'person@example.com')}`;
    const db = createFakeDb({
        [sourceId]: { windowStartedAt: NOW - (15 * 60 * 1000) - 1, count: 3, updatedAt: 'OLD' },
        [emailId]: { windowStartedAt: NOW - (24 * 60 * 60 * 1000) - 1, count: 5, updatedAt: 'OLD' }
    });

    await reserveRateLimit({
        db,
        secret: SECRET,
        source: '203.0.113.25',
        email: 'person@example.com',
        now: NOW,
        updatedAt: 'SERVER_TIME'
    });

    assert.deepEqual(db.store.get(sourceId), { windowStartedAt: NOW, count: 1, updatedAt: 'SERVER_TIME' });
    assert.deepEqual(db.store.get(emailId), { windowStartedAt: NOW, count: 1, updatedAt: 'SERVER_TIME' });
});

test('rate-limit storage contains only anonymous counter metadata', async () => {
    const db = createFakeDb();
    await reserveRateLimit({
        db,
        secret: SECRET,
        source: '203.0.113.25',
        email: 'person@example.com',
        now: NOW,
        updatedAt: 'SERVER_TIME'
    });

    assert.equal(db.writes.length, 2);
    for (const write of db.writes) {
        assert.match(write.id, /^(source|email)_[a-f0-9]{64}$/);
        assert.deepEqual(Object.keys(write.value).sort(), ['count', 'updatedAt', 'windowStartedAt']);
        const serialized = JSON.stringify(write);
        assert.equal(serialized.includes('person@example.com'), false);
        assert.equal(serialized.includes('203.0.113.25'), false);
        assert.equal(serialized.includes('Please add'), false);
    }
});

test('mail is plain text with a safe subject and sender reply-to', () => {
    const payload = validateContactPayload(validPayload(), NOW);
    const mail = buildMailOptions(payload, {
        from: 'PouchLog <sender@example.com>',
        to: 'owner@example.com'
    });

    assert.equal(mail.from, 'PouchLog <sender@example.com>');
    assert.equal(mail.to, 'owner@example.com');
    assert.equal(mail.replyTo, 'ondrej@example.com');
    assert.equal(mail.subject, '[PouchLog Contact] Feature request');
    assert.match(mail.text, /Name: Ondrej/);
    assert.match(mail.text, /Email: ondrej@example\.com/);
    assert.match(mail.text, /Please add a compact weekly export\./);
    assert.equal('html' in mail, false);
    assert.equal(mail.disableFileAccess, true);
    assert.equal(mail.disableUrlAccess, true);
});

test('honeypot submissions succeed silently without rate-limit or email side effects', async () => {
    let mailCalls = 0;
    const db = createFakeDb();
    const handler = createContactHandler({
        db,
        transport: { sendMail: async () => { mailCalls += 1; } },
        secret: SECRET,
        adminEmail: 'owner@example.com',
        senderEmail: 'sender@example.com',
        clock: () => NOW,
        updatedAt: () => 'SERVER_TIME'
    });

    assert.deepEqual(await handler({ data: validPayload({ website: 'spam.example' }), source: '203.0.113.25' }), { ok: true });
    assert.equal(mailCalls, 0);
    assert.equal(db.writes.length, 0);
});

test('valid handler call reserves limits and sends one email', async () => {
    const sent = [];
    const db = createFakeDb();
    const handler = createContactHandler({
        db,
        transport: { sendMail: async (mail) => { sent.push(mail); } },
        secret: SECRET,
        adminEmail: 'owner@example.com',
        senderEmail: 'sender@example.com',
        clock: () => NOW,
        updatedAt: () => 'SERVER_TIME'
    });

    assert.deepEqual(await handler({ data: validPayload(), source: '203.0.113.25' }), { ok: true });
    assert.equal(db.writes.length, 2);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].replyTo, 'ondrej@example.com');
});

test('mail transport failures become internal contact errors', async () => {
    const logged = [];
    const transportError = Object.assign(new Error('SMTP unavailable for private-user@example.com'), {
        code: 'EAUTH',
        responseCode: 535,
        command: 'AUTH PLAIN'
    });
    const handler = createContactHandler({
        db: createFakeDb(),
        transport: { sendMail: async () => { throw transportError; } },
        secret: SECRET,
        adminEmail: 'owner@example.com',
        senderEmail: 'sender@example.com',
        clock: () => NOW,
        updatedAt: () => 'SERVER_TIME',
        logger: { error: (message, metadata) => logged.push({ message, metadata }) }
    });

    await assert.rejects(
        handler({ data: validPayload(), source: '203.0.113.25' }),
        (error) => error instanceof ContactError && error.code === 'internal' && !error.message.includes('SMTP')
    );
    assert.deepEqual(logged, [{
        message: 'Contact email transport failed.',
        metadata: { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }
    }]);
    assert.equal(JSON.stringify(logged).includes('private-user@example.com'), false);
});
