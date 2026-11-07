# Piano Trainer

A falling-notes piano teacher that runs in any modern browser — laptop, Android tablet or iPad.
Notes fall toward an on-screen keyboard lined up with your real keys. In **Follow me** mode the notes
**only move when you play them** (single notes and chords, both hands). Personal use.

## Start it

1. Double-click **`start.bat`**. The first time, it installs what it needs. It then opens `http://localhost:8000`.
2. If Windows Firewall asks, click **Allow** (private networks), so your tablet can connect.

**On a tablet / another laptop:** open the `https://192.168.x.x:8443` address printed in the
start window (same Wi-Fi). The browser warns about the certificate once — choose
*Advanced → Proceed* (Safari: *Show details → visit this website*). HTTPS is required for
the microphone and MIDI.

Tip: on a tablet use *Add to Home Screen* for a full-screen app.

## Connect your piano (top-right button)

| Option | Best for | Notes |
|---|---|---|
| 🎹 **USB / Bluetooth MIDI** | Digital pianos | Exact, instant, perfect chords. Chrome / Edge / Android Chrome. *iPad Safari has no Web MIDI.* |
| 🎤 **Microphone** | Acoustic pianos, iPad | Hears single notes **and chords**. Stay quiet for 1 s while it measures the room. Adjust *Sensitivity* if notes are missed (raise) or trigger by themselves (lower). |
| 👆 Tap the keys | Trying it out | Works everywhere. |

## Practise

- **Follow me**: notes wait at the line until you play every note shown, then glide to the next chord.
- **Wait**: notes flow at the song's tempo, and pause whenever you haven't played the next notes yet.
- **Listen**: hear the song (and watch the keys) first.
- **Both / Left / Right**: practise one hand. The other hand plays itself (it's only heard with MIDI or tapping).
- **− 100% +** speed; drag the progress bar to jump; ⏮ restarts.
- Keyboard shortcuts: Space play/pause · ← back a chord · → skip a chord · R restart.
- ⚙ Settings: note names, fit keyboard to the song vs. all 88 keys, note scroll speed, hand-split point.

Colours: **blue** = right hand, **orange** = left hand, **green** = played, red key = wrong note (MIDI/tap).

## Add songs (♫ button)

- **Upload MIDI**: most accurate. Two-track files are split into hands automatically (the higher part goes to the right hand).
- **From YouTube**: paste a link to a piano tutorial. The helper downloads the audio, then Spotify's
  *basic-pitch* AI turns it into notes on your device (allow ~10–30 s per minute of music).
  Needs **yt-dlp** on the computer running `start.bat`:
  ```
  winget install yt-dlp.yt-dlp
  ```
  then restart `start.bat`.
- **From audio file**: the same conversion for an MP3/M4A/WAV you already have.

Converted songs are a good starting point, not perfect sheet music. Use **Listen** to check one first.
They work best with solo-piano videos without talking or background music. Songs are saved in the
`songs/` folder and shared by every device that uses the helper.

## Files

- `public/` – the app (`app.js` engine & UI, `listener.js` chord-aware microphone, `vendor.js` bundled libraries)
- `server.js` – small local helper (library, YouTube download, HTTPS for tablets)
- `public/tests/mic-selftest.js` – synthetic-audio tests for the microphone listener. Run it in the browser console:
  `await import('./tests/mic-selftest.js').then(m => m.runAll())`
- Rebuild `vendor.js` after updating libraries: `npm install` then `npm run build`

## Built with (open source)

- [spotify/basic-pitch-ts](https://github.com/spotify/basic-pitch-ts): audio → MIDI (Apache-2.0)
- [@tonejs/midi](https://github.com/Tonejs/Midi): MIDI read/write (MIT)
- [TensorFlow.js](https://github.com/tensorflow/tfjs) (Apache-2.0), [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense), [selfsigned](https://github.com/jfromaniello/selfsigned) (MIT)

Projects considered as a fork base: [sightread](https://github.com/sightread/sightread) (web falling-notes app;
development moved private in 2026; no microphone input), PianoBooster / Neothesia (desktop only), and
Synthesia-video-to-MIDI tools such as [video2midi](https://github.com/svsdval/video2midi) and
[syn2midi](https://github.com/minyor/syn2midi).
