const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { ContactError, createContactHandler } = require('./contact');
const { AccountDeletionError, createDeleteAccountHandler } = require('./delete-account');

admin.initializeApp();

// Pevně nastavený admin email
const ADMIN_EMAIL = 'andy0517@gmail.com';

// Nastavení odesílatele - čte data ze souboru .env
// (Node.js umí číst process.env automaticky v nových verzích Firebase)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_EMAIL,
        pass: process.env.GMAIL_PASSWORD
    }
});

/**
 * TRIGGER 1: Nový uživatel (Klasická V1 syntaxe - nejstabilnější)
 */
exports.notifyNewUser = functions.auth.user().onCreate((user) => {
    const mailOptions = {
        from: `PouchLog Bot <${process.env.GMAIL_EMAIL}>`,
        to: ADMIN_EMAIL,
        subject: '🎉 Nový uživatel v PouchLog!',
        html: `
            <h2>Někdo se právě zaregistroval</h2>
            <p><strong>Email:</strong> ${user.email || 'Neznámý (Google/Anonym)'}</p>
            <p><strong>UID:</strong> ${user.uid}</p>
            <p><strong>Čas:</strong> ${new Date().toLocaleString('cs-CZ')}</p>
        `
    };
    return transporter.sendMail(mailOptions)
        .then(() => console.log('New user email sent'))
        .catch(err => console.error('Error sending email:', err));
});

/**
 * TRIGGER 2: Nový záznam v historii (Klasická V1 syntaxe)
 */
exports.notifyNewEntry = functions.firestore
    .document('users/{userId}/history/{entryId}')
    .onCreate((snap, context) => {
        const data = snap.data();
        const userId = context.params.userId;

        const mailOptions = {
            from: `PouchLog Bot <${process.env.GMAIL_EMAIL}>`,
            to: ADMIN_EMAIL,
            subject: '📝 Nový záznam v PouchLog',
            html: `
                <h2>Uživatel přidal záznam</h2>
                <p><strong>Uživatel ID:</strong> ${userId}</p>
                <hr>
                <p><strong>Značka:</strong> ${data.brand}</p>
                <p><strong>Název:</strong> ${data.name}</p>
                <p><strong>Síla:</strong> ${data.mg} mg</p>
                <p><strong>Čas pořízení:</strong> ${new Date(data.date).toLocaleString('cs-CZ')}</p>
            `
        };

        return transporter.sendMail(mailOptions)
            .then(() => console.log('New entry email sent'))
            .catch(err => console.error('Error sending entry email:', err));
    });

/**
 * Veřejný kontaktní formulář. Obsah zprávy se odesílá pouze e-mailem;
 * Firestore uchovává jen HMAC identifikátory a čítače pro rate limiting.
 */
exports.submitContact = onCall({
    secrets: ['GMAIL_EMAIL', 'GMAIL_PASSWORD', 'CONTACT_RATE_SECRET'],
    cors: [
        'https://pouchlog.com',
        'https://www.pouchlog.com',
        /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/
    ]
}, async (request) => {
    const contactTransport = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.GMAIL_EMAIL,
            pass: process.env.GMAIL_PASSWORD
        }
    });
    const handler = createContactHandler({
        db: admin.firestore(),
        transport: contactTransport,
        secret: process.env.CONTACT_RATE_SECRET,
        adminEmail: ADMIN_EMAIL,
        senderEmail: process.env.GMAIL_EMAIL,
        updatedAt: () => admin.firestore.FieldValue.serverTimestamp(),
        logger
    });

    try {
        return await handler({
            data: request.data,
            source: request.rawRequest?.ip || request.rawRequest?.socket?.remoteAddress || 'unknown'
        });
    } catch (error) {
        if (error instanceof ContactError) {
            throw new HttpsError(error.code, error.message);
        }
        console.error('Unexpected contact submission failure.');
        throw new HttpsError('internal', 'The message could not be sent. Please try again later.');
    }
});

/**
 * Odstraní celý Firestore strom právě přihlášeného uživatele a následně
 * jeho účet Firebase Authentication. Čerstvé přihlášení ověřuje handler.
 */
exports.deleteAccount = onCall({
    cors: [
        'https://pouchlog.com',
        'https://www.pouchlog.com',
        /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/
    ]
}, async (request) => {
    const handler = createDeleteAccountHandler({
        db: admin.firestore(),
        auth: admin.auth()
    });

    try {
        return await handler(request);
    } catch (error) {
        if (error instanceof AccountDeletionError) {
            throw new HttpsError(error.code, error.message);
        }
        console.error('Unexpected account deletion failure.', error);
        throw new HttpsError('internal', 'The account could not be deleted. Please try again.');
    }
});
