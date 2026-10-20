const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const nodemailer = require("nodemailer");
const crypto = require("node:crypto");

initializeApp();
const db = getFirestore();
const SMTP_HOST = defineSecret("SMTP_HOST");
const SMTP_PORT = defineSecret("SMTP_PORT");
const SMTP_USER = defineSecret("SMTP_USER");
const SMTP_PASS = defineSecret("SMTP_PASS");
const SMTP_FROM = defineSecret("SMTP_FROM");
const OTP_HASH_SECRET = defineSecret("OTP_HASH_SECRET");
const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_WAIT_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

function hashCode(uid, code) {
  return crypto.createHmac("sha256", OTP_HASH_SECRET.value()).update(uid + ":" + code).digest("hex");
}
function requirePasswordUser(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const provider = request.auth.token.firebase?.sign_in_provider;
  if (provider !== "password") throw new HttpsError("failed-precondition", "Email OTP is only used for email/password sign-in.");
  const email = request.auth.token.email;
  if (!email) throw new HttpsError("failed-precondition", "This account has no email address.");
  return { uid: request.auth.uid, email };
}
async function clearOtpClaim(uid) {
  const auth = getAuth();
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, { ...(user.customClaims || {}), emailOtpVerified: false });
}
function mailTransport() {
  return nodemailer.createTransport({
    host: SMTP_HOST.value(),
    port: Number(SMTP_PORT.value() || 587),
    secure: Number(SMTP_PORT.value() || 587) === 465,
    auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() }
  });
}

exports.requestEmailOtp = onCall({
  enforceAppCheck: false,
  secrets: [SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, OTP_HASH_SECRET]
}, async (request) => {
  const { uid, email } = requirePasswordUser(request);
  const ref = db.collection("emailOtpChallenges").doc(uid);
  const now = Date.now();
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const expiresAt = now + OTP_TTL_MS;
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    if (data.lastSentAt && now - data.lastSentAt.toMillis() < RESEND_WAIT_MS) {
      throw new HttpsError("resource-exhausted", "Wait 60 seconds before requesting another code.");
    }
    if (data.windowStartedAt && now - data.windowStartedAt.toMillis() < 60 * 60 * 1000 && (data.sentCount || 0) >= 5) {
      throw new HttpsError("resource-exhausted", "Too many codes requested. Try again in an hour.");
    }
    tx.set(ref, {
      codeHash: hashCode(uid, code),
      expiresAt: Timestamp.fromMillis(expiresAt),
      lastSentAt: Timestamp.fromMillis(now),
      windowStartedAt: data.windowStartedAt && now - data.windowStartedAt.toMillis() < 60 * 60 * 1000 ? data.windowStartedAt : Timestamp.fromMillis(now),
      sentCount: data.windowStartedAt && now - data.windowStartedAt.toMillis() < 60 * 60 * 1000 ? (data.sentCount || 0) + 1 : 1,
      attempts: 0
    });
  });
  await clearOtpClaim(uid);
  try {
    await mailTransport().sendMail({
      from: SMTP_FROM.value(),
      to: email,
      subject: "Your Road Rush verification code",
      text: "Your Road Rush verification code is " + code + ". It expires in 10 minutes. If you did not request this, you can ignore this email.",
      html: "<div style=\"font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px\"><h2>Road Rush verification</h2><p>Use this six-digit code to finish signing in:</p><p style=\"font-size:32px;font-weight:bold;letter-spacing:8px\">" + code + "</p><p>This code expires in 10 minutes. Never share it with anyone.</p></div>"
    });
  } catch (error) {
    await ref.delete().catch(() => {});
    console.error("OTP email delivery failed", error);
    throw new HttpsError("unavailable", "Email delivery is temporarily unavailable. Try again later.");
  }
  return { sent: true, expiresInSeconds: 600 };
});

exports.verifyEmailOtp = onCall({
  enforceAppCheck: false,
  secrets: [OTP_HASH_SECRET]
}, async (request) => {
  const { uid } = requirePasswordUser(request);
  const code = String(request.data?.code || "");
  if (!/^\d{6}$/.test(code)) throw new HttpsError("invalid-argument", "Enter the six-digit code.");
  const ref = db.collection("emailOtpChallenges").doc(uid);
  const now = Date.now();
  const valid = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("failed-precondition", "Request a new email code.");
    const data = snap.data();
    if (!data.expiresAt || data.expiresAt.toMillis() < now) {
      tx.delete(ref);
      throw new HttpsError("deadline-exceeded", "That code expired. Request a new one.");
    }
    if ((data.attempts || 0) >= MAX_ATTEMPTS) {
      tx.delete(ref);
      throw new HttpsError("resource-exhausted", "Too many attempts. Request a new code.");
    }
    if (hashCode(uid, code) !== data.codeHash) {
      tx.update(ref, { attempts: (data.attempts || 0) + 1 });
      return false;
    }
    tx.delete(ref);
    return true;
  });
  if (!valid) throw new HttpsError("permission-denied", "Incorrect code. Check the email and try again.");
  const auth = getAuth();
  const user = await auth.getUser(uid);
  await auth.updateUser(uid, { emailVerified: true });
  await auth.setCustomUserClaims(uid, { ...(user.customClaims || {}), emailOtpVerified: true });
  return { verified: true };
});


function requireCloudSaveUser(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to your Road Rush account first.");
  const provider = request.auth.token.firebase?.sign_in_provider;
  if (provider === "password" && request.auth.token.emailOtpVerified !== true) {
    throw new HttpsError("permission-denied", "Verify your six-digit email code before syncing or redeeming account rewards.");
  }
  return request.auth.uid;
}

// The client only reads/writes the save belonging to its authenticated Firebase UID.
// Admin SDK access keeps the existing deny-all Firestore client rules in place.
exports.savePlayerProgress = onCall({ enforceAppCheck: false }, async (request) => {
  const uid = requireCloudSaveUser(request);
  const action = String(request.data?.action || "");
  const ref = db.collection("playerSaves").doc(uid);

  if (action === "load") {
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : null;
    return { exists: !!(data && data.save), save: data && data.save ? data.save : null };
  }
  if (action !== "save") throw new HttpsError("invalid-argument", "Use the load or save action.");

  const save = request.data?.save;
  if (!save || typeof save !== "object" || Array.isArray(save)) {
    throw new HttpsError("invalid-argument", "The game save is missing or invalid.");
  }
  let serialized;
  try { serialized = JSON.stringify(save); }
  catch { throw new HttpsError("invalid-argument", "The game save could not be read."); }
  if (serialized.length > 180000) throw new HttpsError("invalid-argument", "The game save is too large.");
  if (!Number.isFinite(Number(save.cash)) || Number(save.cash) < 0) {
    throw new HttpsError("invalid-argument", "The saved cash balance is invalid.");
  }

  await ref.set({ save, updatedAt: Timestamp.now() }, { merge: true });
  return { ok: true, savedAt: Date.now() };
});

// A server-side transaction makes ROADRUSH1T a truly global single-use code:
// two accounts attempting it at the same time cannot both receive the reward.
exports.redeemRoadRushCode = onCall({ enforceAppCheck: false }, async (request) => {
  const uid = requireCloudSaveUser(request);
  const code = String(request.data?.code || "").trim().toUpperCase();
  if (code !== "KUW") throw new HttpsError("invalid-argument", "That special code is not recognized.");

  const claimRef = db.collection("redeemCodes").doc("KUW");
  const saveRef = db.collection("playerSaves").doc(uid);

  const result = await db.runTransaction(async (tx) => {
    const claimSnap = await tx.get(claimRef);
    const saveSnap = await tx.get(saveRef);

    if (claimSnap.exists) {
      const claim = claimSnap.data() || {};
      if (claim.uid === uid) throw new HttpsError("already-exists", "This unique code was already redeemed by your account.");
      throw new HttpsError("failed-precondition", "This unique code has already been redeemed by another player.");
    }

    const stored = saveSnap.exists ? saveSnap.data() : null;
    const current = stored && stored.save && typeof stored.save === "object" ? { ...stored.save } : {};
    const oldCash = Number(current.cash);
    current.cash = Math.max(0, Number.isFinite(oldCash) ? oldCash : 0) + 1000000000000;
    current.redeemedCodes = Array.isArray(current.redeemedCodes) ? current.redeemedCodes : [];
    if (!current.redeemedCodes.includes("KUW")) current.redeemedCodes.push("KUW");

    tx.set(claimRef, { uid, redeemedAt: Timestamp.now() });
    tx.set(saveRef, { save: current, updatedAt: Timestamp.now() }, { merge: true });
    return current;
  });

  return { ok: true, save: result, reward: 1000000000000 };
});
