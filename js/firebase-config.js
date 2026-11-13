/**
 * Your Firebase web-app configuration — this is the ONLY file you need to edit.
 *
 * Where to find it:
 *   Firebase console → Project settings (gear icon) → General → "Your apps"
 *   → pick your Web app → "SDK setup and configuration" → Config.
 *
 * Paste each value over the matching PASTE_... placeholder below.
 *
 * These values are safe to commit and publish: they only identify your project.
 * Who can read or write data is controlled by Firebase Authentication and the
 * rules in firestore.rules, not by keeping this config secret.
 */
export const firebaseConfig = {
  apiKey: 'PASTE_API_KEY',
  authDomain: 'PASTE_PROJECT_ID.firebaseapp.com',
  projectId: 'PASTE_PROJECT_ID',
  storageBucket: 'PASTE_PROJECT_ID.firebasestorage.app',
  messagingSenderId: 'PASTE_MESSAGING_SENDER_ID',
  appId: 'PASTE_APP_ID',
};
