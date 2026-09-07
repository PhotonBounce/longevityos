# app/audio — generated on a runner, never committed

This directory holds the console's instrument sounds (`sfx/*.mp3`), the
spoken guide (`voice/*.mp3`) and the `manifest.json` that lists what exists.
None of those files are in git: `.gitignore` excludes `app/audio/**/*.mp3`
and `app/audio/manifest.json`. They are rendered by `tools/gen-audio.mjs`
on a GitHub Actions runner that holds the ElevenLabs key (`XI_KEY`) and are
FTP-uploaded beside the app; this sandbox has no route to api.elevenlabs.io
and the repository must never carry a credential or a binary it did not
need.

The inputs are the app's own exports — `NARRATION` in `js/view/guide.js`
and `SFX` in `js/view/sound.js` — so a recording can never drift from its
caption: change a word and that item's hash changes and only that item is
re-rendered. The generator is idempotent on the manifest's hashes, refuses
any SFX over 200 KB or voice line over 1 MB, and `--selftest` proves the
offline half without a network.

The page is complete without a byte of audio: a missing manifest or file
means silence, every spoken line is printed as text, and nothing is fetched
from here until a person presses something.
