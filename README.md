# AutoPause

Safari Web Extension that pauses your selected main player when another tab starts playing audio or video, then resumes it after the competing audio stops.

Supports **YouTube Music** and **Spotify** in Safari.

## How It Works

- Choose YouTube Music or Spotify as your main player from the extension popup.
- When the selected player is actively playing and another Safari tab starts HTML media playback, the player is paused automatically.
- When the competing audio stops and stays stopped for ~1.5 seconds, the player resumes.
- If you manually interact with the player after an auto-pause, the auto-resume is cancelled.

## Installation (Safari on macOS)

Safari requires extensions to be packaged as a native macOS app. You will need **Xcode** (free from the Mac App Store) and a free Apple ID.

### 1. Clone the repo

```bash
git clone https://github.com/psweg01/AutoPause.git
cd AutoPause
```

### 2. Point Xcode tools to the full Xcode app

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

### 3. Convert the extension into an Xcode project

```bash
xcrun safari-web-extension-converter extension \
  --app-name AutoPause \
  --bundle-identifier com.yourname.autopause \
  --macos-only
```

> **Note:** If you get a "bundle identifier not prefixed" build error, open `AutoPause/AutoPause.xcodeproj/project.pbxproj` and change `com.yourname.AutoPause` → `com.yourname.autopause` (lowercase). This is a known converter quirk.

```bash
```

Replace `com.yourname.autopause` with any reverse-domain identifier you like.

### 4. Open in Xcode and sign

```bash
open AutoPause/AutoPause.xcodeproj
```

In Xcode:
1. Click the **AutoPause** project at the top of the navigator.
2. Select the **AutoPause** target → **Signing & Capabilities** tab.
3. Set **Team** to your personal Apple ID (add it via *Add an Account...* if needed).
4. Repeat for the **AutoPause Extension** target.

### 6. Build and run

Press **Cmd+R**. The wrapper app installs on your Mac.

### 7. Enable in Safari

Go to **Safari → Settings → Extensions**, enable **AutoPause**, and grant access to **All Websites**.

The extension stays enabled permanently across restarts — no re-enabling needed.

## Known Limits

- Detection is limited to standard `<audio>` and `<video>` elements. Sites using the Web Audio API directly may not be detected.
- Spotify support targets `https://open.spotify.com` in Safari only.

## Repo Layout

```
extension/
  manifest.json
  background.js
  player-controller.js
  media-observer.js
  popup.html
  popup.js
  icons/icon.svg
```

The Xcode wrapper project is not committed — generate it locally using the steps above.
