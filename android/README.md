# Pixie for Android

The phone side of Pixie. It **senses** calls and WhatsApp/SMS notifications, forwards them to the Pixie brain
(Cloudflare Worker `pixie-orchestrator`), and **performs** replies only after you approve them. The phone app is
not the character; it is a quiet link. The contract with the brain is `../PROTOCOL.md`.

## Build

Requirements: JDK 17, Android SDK (platform 35), Gradle 8.10.2. No Gradle wrapper jar is committed.

```bash
cd android
gradle assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
```

CI runs the same command via `gradle/actions/setup-gradle` with Gradle 8.10.2. To open it in Android Studio,
open the `android/` folder (Studio can generate a wrapper with `gradle wrapper --gradle-version 8.10.2`).

## Install

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

or copy the APK to the phone and open it (allow "Install unknown apps" for your file manager).

## Permissions to grant

Open Pixie; the **Setup** cards show a live tick for each:

| Card | Why |
| --- | --- |
| Notification access | Read WhatsApp / WhatsApp Business / default SMS app previews and use their Reply action |
| Phone, call log & contacts | Detect ringing/answered/ended/missed calls, the number (Android only gives it with call-log access) and the contact name |
| Post notifications (Android 13+) | "Pixie is connected" status and "Call back …?" prompts |
| Run in background | Battery-optimisation exemption so the link survives Doze |
| Location for weather | Fine or approximate location, "while using the app" only; Pixie never asks for background location |

### Android 13+ "restricted settings" (sideloaded APKs)

Android 13 and newer block notification access for apps installed outside an app store. If the Pixie switch in
*Notification access* is greyed out or shows "Restricted setting":

1. Open **Settings → Apps → Pixie** (or tap **App info** on the Notification access card).
2. Tap the **⋮** menu (top right) → **Allow restricted settings**, confirm with your PIN/fingerprint.
3. Go back to *Notification access* and enable Pixie.

(On some phones the ⋮ menu only appears after you have tried to enable the setting once.)

## Pairing

1. On the Mac app, choose **Pair phone**. It calls `POST /v1/pair/start` and shows a 6-digit code plus a QR code
   of `pixie://pair?u=<brain url>&c=<code>`.
2. On the phone, scan the QR code with the camera app. Pixie opens, fills in the URL and code, and pairs
   automatically (`POST /v1/pair/claim` with `device: { kind: "android", name: <Build.MODEL> }`).
3. Fallback: type the brain URL (e.g. `https://pixie-orchestrator.<you>.workers.dev`) and the code, tap **Pair**.

The device token is kept in app-private SharedPreferences (a future version should encrypt it with an Android
Keystore key). **Unpair** stops the link, forgets the token and asks the brain to revoke it.

## What it sends (PROTOCOL.md §2)

- `hello` on every connect: `kind: "android"`, capabilities `["calls","whatsapp","notify"]`.
- `phone.call`: `ringing` / `answered` / `ended` / `missed` with number and contact name (or null).
- `phone.message`: app, package, sender, conversation (groups), preview, `is_group`, the notification `key`,
  and `replyable` (whether the notification has an inline Reply action).
- `exec.result` after each `bot.execute`.
- `location.update` (§4.1): `{ lat, lon, accuracy_m, source: "phone" }`, lat/lon **rounded to 2 decimals**
  (~1 km) on the phone. Sent from the last known fix when the link starts (if under an hour old), then when the
  phone moves > 2 km, at most every 15 min. It uses the platform `LocationManager` (GPS, with the network
  provider as fallback), not Play Services. Only runs while the link service runs, the toggle is on and a
  location permission is granted. The activity log shows "Location updated" without coordinates.
- Plain-text `ping` every 30 s; reconnect with backoff 1 s → 30 s; up to 100 events are queued while offline.

It executes `bot.execute` for:

- `whatsapp.reply`: fills the stored notification's Reply action with the approved text. If the notification
  is gone the result is `notification_gone`.
- `call.back`: posts a "Call back <name>?" notification; tapping it opens the dialer with the number. Pixie
  never places calls itself and does not request `CALL_PHONE`.

Toggles on the main screen turn forwarding of WhatsApp, SMS and calls on or off, plus **Share location for
weather** (on by default, has no effect until location access is granted).

The link service is a `specialUse` foreground service. While location sharing is on it also declares the
`location` type (with `FOREGROUND_SERVICE_LOCATION` on Android 14+), because Android 10+ stops delivering fixes to
a backgrounded app that only has "while using" access unless a location-type foreground service is running.
Android 14+ refuses that type when the service is started from the background (boot, a phone call), so in that
case the service runs without it and adds it the next time you open Pixie.

## Privacy

- Only notification previews are read; chat databases and SMS inboxes are never touched.
- A reply is only ever sent in response to a `bot.execute` from the brain, which the brain sends only after
  you approve the proposal on one of your devices. There is no other code path that sends a message.
- Messages you wrote yourself (shown in WhatsApp's notification after a reply) are never forwarded.
