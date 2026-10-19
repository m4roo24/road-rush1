# Road Rush Firebase Authentication Setup

This adds Firebase Google sign-in, email/password sign-up/sign-in, and a six-digit email OTP after both email/password signup and every email/password login. Google sign-in does not require the email OTP. Existing gameplay and the legacy game-server cloud-save login are preserved separately.

## 1. Create/configure Firebase

1. Open https://console.firebase.google.com/ and create a project.
2. In **Authentication → Sign-in method**, enable **Email/Password** and **Google**.
3. In **Authentication → Settings → Authorized domains**, add `road-rush1.vercel.app` and any custom domain you use.
4. In **Project settings → General → Your apps**, create/register a Web app and copy its Firebase config.
5. In `index.html`, replace the four `REPLACE_WITH_...` values in `firebaseConfig` with the web app's `apiKey`, `authDomain`, `projectId`, and `appId`.
6. In **App Check**, register the web app and configure reCAPTCHA Enterprise or reCAPTCHA v3. The callable functions enforce App Check; don't disable it for production.

Firebase web config is not a server secret. Never put service-account keys or SMTP credentials in `index.html`.

## 2. Configure email OTP delivery

The Cloud Functions send OTP mail using an SMTP provider you control. From the repository root, install the Firebase CLI, sign in, select your project, then set secrets:

```sh
npm install -g firebase-tools
firebase login
firebase use YOUR_FIREBASE_PROJECT_ID
firebase functions:secrets:set SMTP_HOST
firebase functions:secrets:set SMTP_PORT
firebase functions:secrets:set SMTP_USER
firebase functions:secrets:set SMTP_PASS
firebase functions:secrets:set SMTP_FROM
firebase functions:secrets:set OTP_HASH_SECRET
```

Use your SMTP provider's hostname, port (usually 587 or 465), username, password/app password, and a verified sender address. For `OTP_HASH_SECRET`, set a long random secret (at least 32 random bytes). Keep all values private.

Deploy backend functions and Firestore rules:

```sh
cd functions
npm install
cd ..
firebase deploy --only functions,firestore:rules
```

The project may ask you to enable billing for Cloud Functions. The functions use Firestore to store only a salted/HMAC hash of the code, expire codes after 10 minutes, rate-limit resends, and limit verification attempts.

## 3. Important security integration note

The OTP is verified server-side and the function sets the Firebase custom claim `emailOtpVerified: true` only after a valid code. For any future API or database that uses Firebase ID tokens, verify the token server-side and require this claim for email/password sessions. Google sign-in can use its normal Firebase identity.

The existing Road Rush cloud-save login is a separate legacy game-server account system. This commit does not rewrite an external server that is not present in this repository; therefore Firebase identity and legacy cloud-save identity are not automatically linked. Do not treat a client-side UI state as authorization for sensitive server operations.

## 4. Test

After Vercel deploys the updated `index.html`, open the account panel:
- Google button: opens Google sign-in.
- Email sign-up: creates a Firebase user and sends an OTP.
- Email sign-in: sends a fresh OTP on each login.
- OTP: verify the most recent code before the custom claim is granted.

If you change Firebase config, commit and redeploy the site. Do not share passwords, SMTP secrets, service account keys, or OTPs.
