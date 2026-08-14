const { createHmac } = require('node:crypto');

const TOPICS = new Set(['general', 'feature', 'bug', 'other']);
const TOPIC_LABELS = {
    general: 'General message',
    feature: 'Feature request',
    bug: 'Bug report',
    other: 'Other'
};
const SOURCE_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_FORM_AGE_MS = 2000;
const MAX_FORM_AGE_MS = 2 * 60 * 60 * 1000;

class ContactError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ContactError';
        this.code = code;
    }
}

function invalid(message) {
    throw new ContactError('invalid-argument', message);
}

function validateContactPayload(data, now = Date.now()) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        invalid('Invalid contact form data.');
    }

    const name = typeof data.name === 'string' ? data.name.trim() : '';
    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    const topic = typeof data.topic === 'string' ? data.topic : '';
    const message = typeof data.message === 'string' ? data.message.trim() : '';
    const website = typeof data.website === 'string' ? data.website.trim() : '';
    const openedAt = data.openedAt;

    if (name.length > 80) invalid('Name must be at most 80 characters.');
    const safeEmailPattern = /^[a-z0-9._%+-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
    if (!email || email.length > 254 || !safeEmailPattern.test(email)) {
        invalid('Enter a valid email address.');
    }
    if (!TOPICS.has(topic)) invalid('Select a valid topic.');
    if (message.length < 10 || message.length > 3000) {
        invalid('Message must be between 10 and 3000 characters.');
    }
    if (typeof data.website !== 'string') invalid('Invalid contact form data.');
    if (!Number.isFinite(openedAt)) {
        throw new ContactError('failed-precondition', 'Please reopen the contact form and try again.');
    }

    const formAge = now - openedAt;
    if (formAge < MIN_FORM_AGE_MS || formAge > MAX_FORM_AGE_MS) {
        throw new ContactError('failed-precondition', 'Please reopen the contact form and try again.');
    }

    return { name, email, topic, message, website, openedAt };
}

function createIdentifier(secret, kind, value) {
    if (typeof secret !== 'string' || !secret) {
        throw new ContactError('internal', 'Contact form configuration is unavailable.');
    }
    return createHmac('sha256', secret)
        .update(`${kind}\0${String(value).trim().toLowerCase()}`)
        .digest('hex');
}

function nextCounter(current, now, windowMs) {
    if (!current || !Number.isFinite(current.windowStartedAt) || now - current.windowStartedAt >= windowMs) {
        return { windowStartedAt: now, count: 1 };
    }
    return { windowStartedAt: current.windowStartedAt, count: Number(current.count || 0) + 1 };
}

async function reserveRateLimit({ db, secret, source, email, now = Date.now(), updatedAt = now }) {
    const sourceRef = db.collection('contactRateLimits')
        .doc(`source_${createIdentifier(secret, 'source', source || 'unknown')}`);
    const emailRef = db.collection('contactRateLimits')
        .doc(`email_${createIdentifier(secret, 'email', email)}`);

    await db.runTransaction(async (transaction) => {
        const [sourceSnapshot, emailSnapshot] = await Promise.all([
            transaction.get(sourceRef),
            transaction.get(emailRef)
        ]);
        const sourceCounter = nextCounter(sourceSnapshot.exists ? sourceSnapshot.data() : null, now, SOURCE_WINDOW_MS);
        const emailCounter = nextCounter(emailSnapshot.exists ? emailSnapshot.data() : null, now, EMAIL_WINDOW_MS);

        if (sourceCounter.count > 3 || emailCounter.count > 5) {
            throw new ContactError('resource-exhausted', 'Too many contact attempts. Please try again later.');
        }

        transaction.set(sourceRef, { ...sourceCounter, updatedAt });
        transaction.set(emailRef, { ...emailCounter, updatedAt });
    });
}

function buildMailOptions(payload, { from, to }) {
    return {
        from,
        to,
        replyTo: payload.email,
        subject: `[PouchLog Contact] ${TOPIC_LABELS[payload.topic]}`,
        disableFileAccess: true,
        disableUrlAccess: true,
        text: [
            'New message from the PouchLog contact form',
            '',
            `Name: ${payload.name || 'Not provided'}`,
            `Email: ${payload.email}`,
            `Topic: ${TOPIC_LABELS[payload.topic]}`,
            '',
            payload.message
        ].join('\n')
    };
}

function createContactHandler({
    db,
    transport,
    secret,
    adminEmail,
    senderEmail,
    clock = Date.now,
    updatedAt = clock
}) {
    return async ({ data, source }) => {
        if (data && typeof data.website === 'string' && data.website.trim()) {
            return { ok: true };
        }

        const now = clock();
        const payload = validateContactPayload(data, now);
        await reserveRateLimit({
            db,
            secret,
            source: source || 'unknown',
            email: payload.email,
            now,
            updatedAt: updatedAt()
        });

        try {
            await transport.sendMail(buildMailOptions(payload, {
                from: `PouchLog <${senderEmail}>`,
                to: adminEmail
            }));
        } catch (_error) {
            throw new ContactError('internal', 'The message could not be sent. Please try again later.');
        }

        return { ok: true };
    };
}

module.exports = {
    ContactError,
    buildMailOptions,
    createContactHandler,
    createIdentifier,
    reserveRateLimit,
    validateContactPayload
};
