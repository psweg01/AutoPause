# AutoPause

Safari Web Extension prototype that pauses your selected main player in Safari when another tab starts playing standard HTML audio or video, then resumes that player after the competing audio stops.

## Repo Layout

- `extension/manifest.json`
- `extension/background.js`
- `extension/player-controller.js`
- `extension/media-observer.js`
- `extension/popup.html`
- `extension/popup.js`
- `extension/icons/icon.svg`

## Load In Safari

1. Open Safari.
2. Use Safari's temporary web-extension install-from-disk workflow.
3. Select the `extension` folder in this repo.
4. Enable the extension.
5. Grant website access for `All Websites`.

## Expected Behavior

- You can choose `YouTube Music` or `Spotify` as the main player from the extension popup.
- If the selected main player is actively playing and another Safari tab starts normal HTML media playback, the selected player is paused.
- When the competing audio stops and remains stopped for about 1.5 seconds, the selected player resumes.
- If you interact with the selected player's page after the auto-pause, the extension cancels that auto-resume cycle.

## Known Limits

- Detection is limited to standard `audio` and `video` elements.
- Sites that use Web Audio API without a normal media element may not be detected.
- Spotify support currently targets `https://open.spotify.com` in Safari.
- This prototype is Safari-only and intended for local development.
