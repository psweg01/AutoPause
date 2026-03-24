# AutoPause

Safari Web Extension prototype that pauses YouTube Music when another Safari tab starts playing standard HTML audio or video, then resumes YouTube Music after that competing audio stops.

## Repo Layout

- `extension/manifest.json`
- `extension/background.js`
- `extension/ytm-controller.js`
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

- If `music.youtube.com` is actively playing and another Safari tab starts normal HTML media playback, YouTube Music is paused.
- When the competing audio stops and remains stopped for about 1.5 seconds, YouTube Music resumes.
- If you interact with the YouTube Music page after the auto-pause, the extension cancels that auto-resume cycle.

## Known Limits

- Detection is limited to standard `audio` and `video` elements.
- Sites that use Web Audio API without a normal media element may not be detected.
- This prototype is Safari-only and intended for local development.
