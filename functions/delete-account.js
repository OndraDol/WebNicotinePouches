class AccountDeletionError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AccountDeletionError';
        this.code = code;
    }
}

function createDeleteAccountHandler({
    db,
    auth,
    now = Date.now,
    maxAuthAgeMs = 5 * 60 * 1000,
    futureClockSkewMs = 60 * 1000
}) {
    if (!db || typeof db.doc !== 'function' || typeof db.recursiveDelete !== 'function') {
        throw new TypeError('A Firestore adapter with doc and recursiveDelete is required.');
    }
    if (!auth || typeof auth.deleteUser !== 'function') {
        throw new TypeError('An Auth adapter with deleteUser is required.');
    }

    return async function deleteAccount(request) {
        const uid = request?.auth?.uid;
        if (typeof uid !== 'string' || !uid) {
            throw new AccountDeletionError('unauthenticated', 'You must be signed in to delete an account.');
        }

        const authTimeSeconds = request.auth.token?.auth_time;
        const currentTime = Number(now());
        const authTimeMs = Number(authTimeSeconds) * 1000;
        const authAgeMs = currentTime - authTimeMs;
        if (
            !Number.isFinite(authTimeSeconds)
            || !Number.isFinite(currentTime)
            || authAgeMs > maxAuthAgeMs
            || authAgeMs < -futureClockSkewMs
        ) {
            throw new AccountDeletionError(
                'failed-precondition',
                'Sign in again immediately before deleting the account.'
            );
        }

        const userReference = db.doc(`users/${uid}`);
        await db.recursiveDelete(userReference);

        try {
            await auth.deleteUser(uid);
        } catch (error) {
            if (error?.code !== 'auth/user-not-found') throw error;
        }

        return { deleted: true };
    };
}

module.exports = {
    AccountDeletionError,
    createDeleteAccountHandler
};
