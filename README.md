# Handi

A personal handicap tracker that runs entirely in the browser. It is a static site (no build step) hosted on GitHub Pages, with Firebase providing sign-in and storage, so your rounds and courses are there whenever you log in, on any device.

**Live site:** https://kylemccalgan.github.io/fairway-tracker/

## Features

- Accounts: email + password or Google, with password reset, profile settings and account deletion.
- Friends: add by code, accept or decline requests, and choose which handicap, round and game statistics accepted friends can see.
- Rounds: add, edit, delete; mark rounds as qualifying or not.
- Handicap estimate in two modes: over par, or course differential `(score − Course Rating) × 113 / Slope Rating`.
- WHS score-count schedule, or a custom "best X of latest Y" window.
- Forecast of which scores drop out of the window, and a "what if I shoot…" simulator.
- Statistics: trends, score distribution, per-course breakdown.
- Shared course catalogue: search for a course before adding it, and use the rating and slope someone already entered. If a value is wrong for you, save your own; it applies only to your account.
- JSON backup export and import.
- **Play**: Handi Golf, a small golf minigame. Endless mode is a new random hole every time; Daily is the same three holes for everyone each day (UTC), one attempt, with a friends leaderboard (add friends by code) and a global "better than X% of players" score. See `docs/game.md`.

The result is an **estimate**, not an official Handicap Index. See the in-app guide for what is left out.

## How the data is stored

| Path (Firestore)                   | Contents                                                          | Who can access          |
| ---------------------------------- | ----------------------------------------------------------------- | ----------------------- |
| `courses/{courseId}`               | Shared catalogue: name, rating, slope, who added it               | Any signed-in user      |
| `users/{uid}`                      | Your settings                                                     | Only you                |
| `users/{uid}/rounds/{roundId}`     | Your rounds (each points at a course)                             | Only you                |
| `users/{uid}/myCourses/{courseId}` | Your course list, plus optional personal rating and slope         | Only you                |
| `users/{uid}/game/{docId}`         | Game stats, profile and sharing preferences                       | Only you                |
| `friendCodes/{code}`               | Friend code lookup and display name                               | Signed-in users with the code |
| `friendships/{pair}`               | Friend requests and accepted friendships                          | The two players         |
| `sharedStats/{uid}`                | Profile summary according to your sharing choices                 | You and accepted friends |
| `dailyScores/{date_uid}`           | Daily game result                                                 | You and accepted friends |
| `dailyStats/{date}`                | Daily score histogram                                             | Any signed-in user      |

A course id is the name lower-cased with everything except letters and digits removed, so the same course can only exist once. Rules are in [`firestore.rules`](firestore.rules).

## Setup

You need a free Firebase project. Do this once.

### 1. Create the project

1. Open the [Firebase console](https://console.firebase.google.com) → **Add project**. Analytics is not needed.
2. **Build → Firestore Database → Create database**. Choose **production mode** and the region closest to you (it cannot be changed later).

### 2. Turn on sign-in

1. **Build → Authentication → Get started → Sign-in method**.
2. Enable **Email/Password** and **Google**.
3. **Authentication → Settings → Authorized domains → Add domain**: `kylemccalgan.github.io` (and any other domain you serve the app from). `localhost` is already allowed for local testing.

### 3. Publish the security rules

**Firestore Database → Rules** → replace everything with the contents of [`firestore.rules`](firestore.rules) → **Publish**.

### 4. Connect the app to your project

1. **Project settings** (gear icon) → **General** → **Your apps** → add a **Web** app (`</>`).
2. Copy the `firebaseConfig` values it shows.
3. Paste them into [`js/firebase-config.js`](js/firebase-config.js), replacing each `PASTE_...` placeholder.
4. Commit and push. GitHub Pages republishes within a minute or two.

The config only identifies your project and is safe to commit. Access is enforced by sign-in and the Firestore rules.

### 5. GitHub Pages

**Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/ (root)`.**

## Run locally

The app uses ES modules, so it must be served over HTTP rather than opened as a file:

```sh
npx serve .
# or: python -m http.server 8000
```

## Moving existing data in

1. In the old version of the app, use **Export backup** (this includes your saved course ratings).
2. Sign in here, then use **Import backup** and pick that file.

Importing adds courses to the shared catalogue when they are new, reuses ones that already exist, and keeps your own rating and slope as personal values if they differ from the shared ones. Importing the same file again overwrites rather than duplicates.

## Project structure

```
.
├── index.html            Page markup
├── css/
│   └── styles.css        All styling
├── js/
│   ├── app.js            Handicap logic, rendering and UI behaviour
│   ├── firebase.js       Sign-in and every Firestore read/write
│   ├── firebase-config.js  Your Firebase project settings (the one file to edit)
│   ├── play.js           The Play view and Friends dialog
│   ├── game-firebase.js  Firestore adapters and friends logic for the game
│   └── game/             Handi Golf itself (no Firebase, no app imports)
├── game/                 Standalone game page, game styles, local adapters
├── tools/  tests/        Hole gallery, balance bot; `node --test`
├── docs/game.md          How the game works
├── firestore.rules       Firestore security rules (publish after every change)
└── README.md
```
