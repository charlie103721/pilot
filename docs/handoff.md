# Pilot MVP 01 — Handoff and open items

Status: Live document
Last updated: 2026-08-10

**This file is updated and merged with every PR** (runbook amendment 12). If a
PR raises something the user must decide, do or verify, it lands here in the
same merge — never only in a PR description or a chat message.

This is the single place to look for **things only the user can do**, and for
**decisions taken on the user's behalf** that they may want to reverse. Anything
that could be decided from the docs, the code or a spike was decided and
recorded in `docs/runbook.md`; only genuine external blockers land here.

Everything below is non-blocking for development on Linux. Work continues past
each item using the fallback stated.

---

## 1. Blocked on the user's Mac

None of this can be verified on the Linux development machine. The code is
written and merged; only the verification is outstanding.

**Confirmed by the user (2026-08-10): the Swift helper will be built on the Mac
later.** Development continues on Linux without it. Nothing in the plan waits
for it, and the batch below accumulates until there is a Mac to run it on. The
macOS lane (PR-012…PR-015) is therefore written blind on top of an uncompiled
helper, by design rather than by oversight.

Run from a clean checkout on macOS 13+ with Swift 5.9+:

```sh
nvm use && pnpm install

# 1. The Swift helper has never been compiled. This is the highest-value check.
swift build --package-path packages/platform-mac/native
swift test  --package-path packages/platform-mac/native

# 2. The helper transport demo against the real binary (not the Node stub).
pnpm build && pnpm --filter @pilot/platform-mac demo

# 3. A packaged bundle containing the REAL helper.
pnpm --filter @pilot/desktop run build:helper -- --require-native
pnpm package
pnpm --filter @pilot/desktop exec node scripts/verify-bundle.js   # expect `helper: native`

# 4. The desktop shell, visually. Linux only proves it launches headlessly.
pnpm dev

# 5. PR-011 — permissions and window enumeration. THIS ONE PROMPTS.
#    Run it from the SwiftPM build first (attribution should read `unknown`),
#    then from inside the packaged .app, which is the answer that matters.
pnpm --filter @pilot/platform-mac demo:permissions

PILOT_HELPER_BINARY="$(pwd)/apps/desktop/release/mac-arm64/Pilot.app/Contents/Resources/helper/PilotHelper" \
  pnpm --filter @pilot/platform-mac demo:permissions

# 6. PR-013 — pointer position and Accessibility grounding. Raises NO prompt of
#    its own (`AXIsProcessTrusted` does not prompt). Run it BOTH ways:
#    without an Accessibility grant, to confirm the degraded mode is real …
pnpm --filter @pilot/platform-mac demo:accessibility

#    … and again after granting Accessibility to the terminal (System Settings →
#    Privacy & Security → Accessibility), which is what makes elements appear.
pnpm --filter @pilot/platform-mac demo:accessibility

#    Then the same from inside the packaged .app, since that is the identity a
#    real grant would be given to.
PILOT_HELPER_BINARY="$(pwd)/apps/desktop/release/mac-arm64/Pilot.app/Contents/Resources/helper/PilotHelper" \
  pnpm --filter @pilot/platform-mac demo:accessibility
# 7. PR-014 — speech. THIS ONE PROMPTS, OPENS THE MICROPHONE AND MAKES NOISE.
#    Run it after step 5, so the two grants already exist. Turn the volume up:
#    part of what is being checked is audible, not printed.
pnpm --filter @pilot/platform-mac demo:speech
# 8. PR-012 — the first real pixel Pilot has ever captured. RUN STEP 5 FIRST:
#    without a Screen Recording grant this cannot work, and the failure would
#    look like a capture bug rather than a missing permission.
#    Open a window titled something recognisable before running it.
pnpm --filter @pilot/platform-mac demo:capture

PILOT_HELPER_BINARY="$(pwd)/apps/desktop/release/mac-arm64/Pilot.app/Contents/Resources/helper/PilotHelper" \
  pnpm --filter @pilot/platform-mac demo:capture
# 9. PR-015 — the global push-to-talk hotkey. THIS ONE PROMPTS TOO
#    (Accessibility, and possibly Input Monitoring — see below).
#    Section 1 of this demo is the *only* place anything in Pilot has ever
#    tried to observe a key press.
pnpm --filter @pilot/platform-mac demo:hotkey

#    Then the same thing from inside the packaged .app, which is the only
#    layout where TCC can plausibly attribute the tap to Pilot rather than to
#    a loose executable:
PILOT_HELPER_BINARY="$(pwd)/apps/desktop/release/mac-arm64/Pilot.app/Contents/Resources/helper/PilotHelper" \
  pnpm --filter @pilot/platform-mac demo:hotkey

# 10. PR-028 — the whole observation path inside the app. THIS ONE PROMPTS
#    (Screen Recording, and Accessibility for the pointer). Run it after step 5.
#    First the stub-driven walkthrough, which already passes on Linux, so a
#    difference on the Mac is a difference in the *platform*, not in the wiring:
pnpm demo:observe

#    Then the real thing. `pnpm dev` on a Mac finds the helper only through
#    PILOT_HELPER_BINARY or a packaged bundle — the bundled main process cannot
#    compute the SwiftPM path — so name it:
PILOT_HELPER_BINARY="$(pwd)/packages/platform-mac/native/.build/debug/PilotHelper" \
  PILOT_LOG_LEVEL=debug pnpm dev

#    …and from inside the packaged .app, which is the only layout where TCC can
#    plausibly attribute Screen Recording to Pilot:
open apps/desktop/release/mac-arm64/Pilot.app

# 11. PR-030 — the MODEL looking at a real window. Run it after step 10: it is
#    step 10's path plus the agent, so a failure here that step 7 did not show is
#    in the tool or the model, not in capture.
#    First the stub-driven walkthrough, which already passes on Linux:
pnpm demo:look

#    Then the real thing. Pick a window in the panel, then TYPE a question that
#    can only be answered by looking — "what does this toggle do?", "what is the
#    error message on this screen?" — and watch three things (below):
PILOT_HELPER_BINARY="$(pwd)/packages/platform-mac/native/.build/debug/PilotHelper" \
  PILOT_LOG_LEVEL=debug pnpm dev

#    And press **Look now** with no question in flight, which is the same
#    observation without the model in the way.

# 9. PR-031 — POINT AND ASK. This is the one the product exists for, and it is
#    the first time a real pointer or a real accessibility element has ever been
#    read by anything in this project. Run it after step 8.
#    First the stub-driven walkthrough, which already passes on Linux:
pnpm demo:ask

#    Then the real thing. Pick a window, PUT THE POINTER ON A SPECIFIC CONTROL
#    inside it — a button, a toggle, a labelled field — leave it there, and type
#    "what is this?". Then repeat with the pointer somewhere else in the same
#    window, and then with the pointer over a DIFFERENT application's window.
PILOT_HELPER_BINARY="$(pwd)/packages/platform-mac/native/.build/debug/PilotHelper" \
  PILOT_LOG_LEVEL=debug pnpm dev
```

Notes:

- **A Swift compile failure is a PR-003 defect** for the transport files, a
  **PR-011 defect** for `PermissionModel.swift`, `Attribution.swift`,
  `WindowModel.swift`, `PermissionProbes.swift` and `WindowEnumerator.swift`,
  and a **PR-014 defect** for `SpeechModel.swift` and `SpeechServices.swift`.
  Either way, send the compiler output; it gets fixed, not worked around. The
  authors could not compile any of it and deliberately avoided constructs they
  were unsure of.
- **Steps 1–4 and 6 raise no TCC prompt. Step 5 does.** That separation is
  deliberate: it isolates "does the helper build and talk" from "does macOS
  trust it". Do steps 1–4 first; if the helper does not build, steps 5 and 6
  cannot tell you anything.
- **Steps 1–4 raise no TCC prompt. Steps 5 and 6 do.** That separation is
  deliberate: it isolates "does the helper build and talk" from "does macOS
  trust it". Do steps 1–4 first; if the helper does not build, steps 5 and 6
  cannot tell you anything.
- **Step 6 is the only one that opens the microphone or makes a sound.** It is
  also the only one where part of the answer is audible rather than printed, so
  it needs speakers on and someone listening.
  and a **PR-012 defect** for `CaptureModel.swift` and `CaptureEngine.swift`.
  Either way, send the compiler output; it gets fixed, not worked around. The
  authors could not compile any of it and deliberately avoided constructs they
  were unsure of.
- **Steps 1–4 raise no TCC prompt. Steps 5 and 6 do.** That separation is
  deliberate: it isolates "does the helper build and talk" from "does macOS
  trust it". Do steps 1–4 first; if the helper does not build, steps 5 and 6
  cannot tell you anything.
- **Steps 1–4 raise no TCC prompt. Steps 5 and 6 do.** That separation is
  deliberate: it isolates "does the helper build and talk" from "does macOS
  trust it". Do steps 1–4 first; if the helper does not build, steps 5 and 6
  cannot tell you anything.
- `--require-native` in step 3 is the flag that matters. Without it the build
  silently stages a placeholder, and a bundle that cannot observe the screen is
  indistinguishable from one that can until someone tries it.

### What to look for in step 5 (PR-011)

This is the first observation of **TCC attribution**, the top structural risk
in the plan (§5 below). Four things, in order:

1. **Section 2, `verdict=`.** Run from `.build/debug` it should read
   `unknown (none)` — a loose executable is inside no `.app`, and that is a
   correct non-answer, not a bug. Run from inside the packaged `.app` it
   should read **`matched (direct)`**. Anything else — especially
   `helper-attributed` — is the risk materialising, and the whole permission
   model in `docs/system-design.md` §4 needs rework.
2. **`confidence=`.** `direct` means macOS answered which process it holds
   responsible. `inferred` means the
   `responsibility_get_pid_responsible_for_pid` SPI did not resolve and the
   verdict rests on bundle layout instead. `inferred` is still usable, but
   report it: it means the strongest available check is not working.
3. **Section 4, window titles.** If every title reads "(title unavailable —
   Screen Recording not granted)" while section 1 reports
   `screen-recording=granted`, that is the attribution bug showing itself from
   the other side, independently of the verdict. Report that combination even
   if the verdict says `matched`.
4. **System Settings → Privacy & Security → Screen Recording.** One entry
   named Pilot is correct. A second entry named `PilotHelper` is the failure,
   and it is visible without reading any output at all.

A crash worth expecting rather than reporting as a surprise: macOS kills a
process that requests Microphone or Speech Recognition without the matching
usage string in the responsible process's `Info.plist`. Both keys are already
declared for the packaged app (`apps/desktop/electron-builder.yml`,
`extendInfo`), so the packaged run in step 5 is covered — but the helper run
from `.build/debug` has no `Info.plist` of its own and may be killed. If it is
killed **in the packaged run too**, that is decisive: TCC is reading the
helper's own plist, so attribution is wrong whatever the verdict printed.
Either way the supervisor restarts it and the request fails as
`helper-unavailable`; nothing hangs.

Also worth capturing while you are there, since nothing else will produce it:

- Whether each permission prompt actually appears, and whether Screen
  Recording still reports the old state until Pilot is relaunched (the code
  assumes it does — `requiresRelaunch: true`).
- Whether the four `x-apple.systempreferences:` URLs land on the right panes.
- The raw values printed for Microphone and Speech Recognition, to confirm the
  two authorization enums map the way `PermissionStateMapper` assumes (they
  disagree: `1` is `restricted` for AVFoundation and `denied` for Speech).

### What to look for in step 6 (PR-013)

Pointer grounding is the input to every spoken question, and none of it has ever
touched a real pointer or a real accessibility tree. Four things:

1. **Does `trusted=` flip when you grant Accessibility?** It is printed at the
   top of every section. If it stays `false` after granting, the grant is going
   to the wrong identity — the same attribution question as step 5, from a
   different angle.
2. **Do the normalised coordinates match reality?** Put the pointer at the
   top-left corner of the observed window and then at its bottom-right; expect
   `0.000, 0.000` and `1.000, 1.000`. A **vertical mirror image** means the
   AppKit coordinate flip is being applied when it should not be (or vice
   versa); an offset by exactly a display's height means the wrong display's
   height was used. Repeat it with the window on a **second display**, ideally
   one placed to the left of or above the primary so its origin is negative,
   and with a **Retina and a non-Retina** display if you have both.
3. **Does a real password field report `[SECURE: value withheld]`?** This is the
   single most valuable observation in the batch. Try both a native app's login
   sheet and a web form in Safari — **they may not agree**, because AppKit
   exposes `AXSecureTextField` as a role in some places and as a subrole in
   others, and WebKit uses the subrole. Report the actual `AXRole`/`AXSubrole`
   you see. **If it never fires, the accessibility-based redaction PR-018 is
   built on never happens**, and §14's "best effort" becomes "no effort".
4. **Do elements come back at all, and quickly?** All `no target (none)` while
   `trusted=true` means `AXUIElementCopyElementAtPosition` is not behaving as
   assumed. Slowness matters too: the helper's accessibility calls are capped at
   200 ms and the sampler runs at 30 Hz, so a busy application should cost
   dropped samples, never a stalled helper. If the helper is restarted by its
   supervisor while you move the pointer around, the timeout is wrong.
### What to look for in step 7 (PR-014)

Nothing here has ever run: no microphone has been opened and no utterance has
been spoken by this project. Five things, in order of how much they would cost
to be wrong:

1. **Do partial transcripts appear at all?** Section 2 should print three
   `partial` lines and then a `final`. If it prints only a `final`, or nothing,
   the recognition callbacks are not reaching the helper. The helper's main
   thread is blocked in its stdio read loop and runs no run loop, so a callback
   delivered on the main queue would never fire;
   `SFSpeechRecognizer.queue` is set explicitly to avoid that. **This is the
   single most likely failure in the PR**, and the fix if it happens is to move
   the stdio loop off the main thread — a PR-003-shaped change, so report it
   rather than patching around it.
2. **Is `finished` ever reported for a spoken chunk?** Section 9 leaves a chunk
   playing. If no `finished` arrives, neither `AVSpeechSynthesizerDelegate` nor
   the `isSpeaking` reconciliation that backs it up is working, and PR-026's
   TTS buffer will stall after the first sentence.
3. **Section 1, `onDevice`.** `true` means this Mac recognises English locally
   and no audio leaves. `false` would mean Pilot refuses to listen by default —
   correct behaviour, but a surprising answer worth reporting, because it makes
   voice input unusable on that Mac without opting into remote recognition.
4. **Section 9, audibly.** Are both chunks spoken? Does the second follow the
   first without a gap? Does the interruption stop the sound *immediately*? The
   printed `stop()` round trip is only the IPC cost; the number that matters
   against the 300 ms budget in `docs/system-design.md` §17 is when the sound
   actually stops, which only a person in the room can judge.
5. **Sections 3–5: what the real recogniser actually does.** These sections
   script a recogniser that finalises early, finalises twice, and calls back
   after cancel, because Apple Speech is reported to do all three. Against the
   real recogniser they will instead show whatever it really does. Both the
   adapter and PR-025's binding handle every case, so nothing breaks either
   way — but the answer is worth writing down, because every later voice PR is
   designed around it.

Also worth capturing while you are there:

- Whether the Speech Recognition prompt appears separately from the Microphone
  one, and in which order.
- Whether recognition still works with the network off. If it does, on-device
  recognition is genuinely in force; if it does not, the privacy guarantee in
  `docs/system-design.md` §14 needs rethinking rather than adjusting.
- The raw error numbers behind any recognition failure.
  `SpeechErrorMapper` in `SpeechModel.swift` classifies
  `kAFAssistantErrorDomain` codes that Apple does not document — the numbers in
  it are community folklore and have never been checked. A wrong guess degrades
  to a correct-but-generic `recognizer-failed`, so this is a quality
  improvement rather than a bug hunt.
### What to look for in step 8 (PR-012)

The demo targets a hard-coded fixture window on the stub. Against the real
helper it enumerates and picks one, and **prints which window it selected on
its second line** — check that line first: everything below it is scoped to
that window and to nothing else.

Then, in order:

1. **Does it capture at all.** Frames should appear with non-zero byte counts.
   Zero frames with `state=starting` means the stream never delivered; zero
   frames with `state=protected` means the window blocks capture (try a plain
   TextEdit window before concluding anything).
2. **`age=` on each frame.** This is `Date.now() - capturedAt`, and it is the
   mach → epoch timestamp conversion showing its work. Tens of milliseconds is
   right. **Hours, or a negative number, means the conversion is wrong** — the
   frame ring would then reject every frame as stale and Pilot would observe
   nothing while reporting no error at all. Report the number either way.
3. **Byte counts.** A 1440×960 JPEG of a normal UI window should be roughly
   100–400 KB. Consistently over ~1.8 MB would exhaust the 16 MiB ring in under
   three seconds and is worth reporting; the fix is the `quality` option.
4. **A motionless window.** Leave the window untouched for ten seconds. Frames
   should keep arriving at ~3 FPS with `contentChanged: false` — that is the
   re-send that keeps the ring populated. If they stop, the assumption that
   ScreenCaptureKit delivers `idle` frames at the configured interval is wrong,
   and a static window will have no frame to answer questions from.
5. **A window that blocks capture.** Try a DRM-protected video or a password
   manager. Expected: `protected-content` and a stopped stream. If instead a
   frame arrives that is entirely black, `SCFrameStatus.blank` is not being
   reported and §16's protected-content path never fires — say so, because the
   model would then describe a black rectangle as if it were the application.
6. **System Settings → Privacy & Security → Screen Recording**, again. Capture
   is the first thing that really uses the grant; a second entry named
   `PilotHelper` appearing here would be the attribution risk (§5) showing up
   at the moment it matters most.
### What to look for in step 9 (PR-015)

This is the first time anything in Pilot has tried to observe a key press. Five
things, in order:

1. **Does the demo's first line say "Swift helper"?** If it says "Node stub",
   the build did not land where `resolveHelperBinary()` looks and everything
   below is the Linux simulation again, not a real tap.
2. **Section 1, the normal press.** Hold Right Option for about a second and
   release it. Expect exactly one `hotkey-down` and one `hotkey-up`, with a
   plausible `held` time. **Then do it again with another application in
   front** — a browser, Terminal, anything — because that, not the first run, is
   the actual requirement. A shortcut that only works when Pilot is focused is
   not push-to-talk.
3. **Whether it prompts for Accessibility, or for Input Monitoring, or both.**
   This is the open question. The code gates on `AXIsProcessTrusted()`, which is
   the permission Pilot models. If macOS instead (or additionally) demands
   **Input Monitoring**, `CGEventTapCreate` returns null with Accessibility
   already granted, and the demo prints `listener-rejected` with Input
   Monitoring named in the detail. **Report that**: it means Pilot needs a fifth
   permission kind, which is a contract change across `@pilot/shared`, the
   onboarding UI and the helper.
4. **Whether Left Option triggers it.** Hold *Left* Option: nothing should
   happen. The left/right distinction comes from a hand-written device-flag
   table (`HotkeyDeviceMask` in `HotkeyModel.swift`) checked against Apple's
   headers and nothing else. If Left Option fires, that table is wrong.
5. **Hold the key and switch Spaces, or open Mission Control, then release it
   somewhere else.** macOS can lose the key-up. Pilot should either see the real
   release or, after 30 seconds, print a synthetic one
   (`SYNTHETIC (held-too-long)`). What it must never do is stay held forever —
   in the real app that is an open microphone.

Also worth capturing while you are there:

- Whether holding a rebound *normal* key (section 8 uses F13) produces
  auto-repeat that the native gate drops, or whether repeats reach the host and
  are only folded there. Both work; which one happens tells us whether
  `kCGKeyboardEventAutorepeat` behaves as assumed.
- Whether the tap is ever disabled by timeout in ordinary use. If the counters
  in section 3 move during a real run, the callback is too slow and that is a
  defect, not a curiosity.

### What to look for in step 10 (PR-028)

This is the first time the *application* has tried to watch a window: PR-012's
demo drives the capture adapter alone, and this drives it through the window
picker, the interaction table, the frame ring and the screen policy. Six things,
in order:

1. **Does the log line at startup say `platform: "macos"`?** `pnpm dev` prints
   `shell ready` with `platform`, `platformReason` and `capture`. If it says
   `platform: "fakes"` with a `no helper binary` reason, everything below is the
   Linux build again and nothing was observed. `usesRealPlatform` in the panel's
   app info says the same thing.
2. **Does the picker list your real windows, with real titles?** Titles reading
   "(title unavailable…)" while Screen Recording reports `granted` is the
   attribution bug from the other side — the same combination step 5 item 3 asks
   about, now in the product.
3. **Does selecting a window start capture, and does the ring fill?** With
   `PILOT_LOG_LEVEL=debug` the observation scope logs `capture started` and then
   `observation allowed` with a frame count and byte totals. Zero frames means
   the stream never delivered; that is PR-012's `starting` case, step 8 item 1.
4. **Look now.** The developer diagnostics surface should gain
   `capture-to-observation`, `image-bytes` and `active-images`. **The number
   that matters is `capture-to-observation`**: system-design §17 budgets image
   preprocessing at under 150 ms, and PR-018 measured 71–135 ms for a `png`
   source on this Linux container. Report the Mac's number either way.
5. **Pause, and watch the buffers go.** The panel's Pause must empty the ring
   *immediately*, not at the next observation. The retention guard logs
   `retention clear` with the counts; a `Buffers were not empty after clearing`
   error would be the one retention failure that must never be silent.
6. **Close the observed window while Pilot is watching it.** Expect: capture
   stops, the ring empties, the panel shows "The window Pilot was watching
   closed. Choose another window." Then try a **DRM-protected video or a
   password manager** as the selected window — expect `protected-content` and a
   stopped stream, never a black rectangle described as the application.

Also worth capturing while you are there:

- Whether a **motionless window** keeps the ring populated. Leave the selected
  window untouched for ten seconds and then Look now: an observation that
  refuses with `frame-available` means ScreenCaptureKit is not re-sending idle
  frames and PR-012's assumption is wrong (step 6 item 4, from the other side).
- The **frame byte sizes**, now that capture is asked for `png` rather than
  `jpeg` (runbook follow-up 18). PNG is bigger on the wire and the ring holds
  16 MiB; if a normal UI window produces frames over ~1.8 MB the ring will hold
  under three seconds and that is worth reporting, because the trade would then
  need revisiting.
- Whether the **pointer target** is ever identified. ~~The observation
  metadata's `targetRole` stays null until PR-031 wires the question anchor~~ —
  **PR-031 wired it**, so `targetRole` is populated for a question asked with
  the pointer inside the selected window, and step 9 is where that is checked
  properly. The pointer *timeline* records the element on every sample either
  way; `PILOT_LOG_LEVEL=debug` shows whether grounding is degraded.

### What to look for in step 11 (PR-030)

This is the first time the **model** has been able to see a screen at all. Four
things, in order:

1. **Does the panel show "Looking at the screen" while it looks?** The
   conversation state badge says it, and the observation indicator beside the
   window picker gains "Pilot is reading an image of this window right now —
   this window only." Both appear only while an observation is in flight. If the
   answer arrives with neither ever appearing, the tool never called the facade
   and the model answered from nothing — check the debug log for `observation
   allowed`.
2. **Does the answer describe the window you actually selected?** Ask about
   something visible only in that window, then repeat the question with a
   *different* window selected. A model that answers the first correctly and the
   second from the first window's contents is a lineage failure, and it is the
   one failure in this PR that is a privacy breach rather than a bug. Report it
   with the `scene` ids from the debug log.
3. **`capture-to-observation` in the developer diagnostics.** §17 budgets image
   preprocessing under 150 ms; the Linux container measures 71–135 ms for a
   `png` source (PR-018), and the stub's frames are 3 KB rather than a real
   window's. This is the first honest number.
4. **Press Look now with no question in flight, and again while paused.** The
   first should produce an observation and return to *Watching*; the second is
   refused by the transition table before anything is captured. Then revoke
   Screen Recording in System Settings while Pilot is watching and press Look
   now: the panel must show a sentence ("Pilot needs Screen Recording permission
   to look at your screen.") plus "Looking again will not help until this is
   fixed", **and the text box must stay usable** (§16). A raw message like
   "Screen policy [...]" reaching the banner is a PR-030 defect.

Also worth capturing while you are there: whether a real model calls
`observe_screen` **at all** without being told to, and how often. Nothing here
can answer that — the demo and the tests script the call.

### What to look for in step 9 (PR-031)

This is the first time anything in Pilot has read a **real pointer** or
hit-tested a **real accessibility element**, and it is what the whole product
rests on. Five things, in order:

1. **Is the pointer crop centred on the control you were pointing at?** Not
   "near it" — look at the image the model received. `PILOT_LOG_LEVEL=debug`
   logs `question anchored` with `insideWindow`, `skewMs` and `targetRole` at
   submission, and `observation allowed` with `targetRole` when the tool runs.
   **This is the single most valuable observation in the whole batch**: every
   test and every demo here proves only that the crop is centred on the pointer
   sample the anchor selected, and nothing has ever checked that sample against
   a real screen. A crop centred half a window away means the §5 coordinate
   conversion is wrong (step 6 item 2 asks about the same thing from the other
   side, and answering it there first will save time).
2. **Does `targetRole` name the control you were pointing at?** Expect
   `AXButton`, `AXCheckBox`, `AXTextField` and so on, with a label that matches
   what you can read on screen. All `null` while `trusted=true` means
   `AXUIElementCopyElementAtPosition` is not behaving as PR-013 assumes — the
   same finding as step 6 item 4, now with a consumer. Try a **password field**
   too: the anchor carries `isSecure` into §10's redaction step, so this is
   where "best effort masking" either happens or is revealed never to.
3. **`skewMs` at the moment you ask.** It is `anchor sample time − submission
   time` and it is bounded at ±1000 ms; anything near that bound means the
   30 Hz pointer poller is not keeping up on a real Mac, and the question is
   being grounded on where the pointer was up to a second earlier.
4. **Point at something, then move the mouse away *before* pressing enter.**
   The answer must describe where the pointer was when you submitted, which is
   the §6 rule. Then do the opposite — ask, then move the mouse while the model
   is looking — and check the answer still describes the original spot.
5. **Put the pointer over a different application's window and ask.** Two cases
   and they behave differently on purpose. *Outside* the selected window's
   frame: the panel and the log should show `insideWindow=false`, `targetRole`
   `null`, and the model is told "outside the selected window; no element was
   identified". *Inside* the frame but over a floating palette, a notification
   or another app's window stacked on top: the point is inside `[0,1]`, so the
   foreign-application rule is what has to fire — `targetRole` `null` again.
   **If either one names the other application's control, stop and report it**;
   that is a privacy breach rather than a bug, and it is the failure runbook
   cross-lane issue 12 records this PR having already found once.

Also worth capturing: how often a real window's ring actually holds a frame at
or before the anchor. `moment: 'question'` refuses with `frame-unavailable`
when it does not, and on a motionless window that is the same assumption step 6
item 4 is about — from the third side.

**Fallback in use:** Mac-gated code is written unverified and batched here
(runbook amendment 8, user decision). Accepted risk: PR-011 through PR-015
accumulate on top of an uncompiled helper. PR-011 additionally ships an
attribution check whose *logic* is fully tested on Linux but whose *answer* is
unknown until step 5 runs. PR-013 ships pointer grounding whose *rules* are
fully tested on Linux but which has never read a pointer or an accessibility
element; step 6 is what produces that answer.
unknown until step 5 runs. PR-014 ships an entire voice path — recognition,
synthesis, and the privacy guarantee that audio stays on the Mac — whose logic
is fully tested on Linux and none of whose *behaviour* has ever been observed.
unknown until step 5 runs. PR-015 ships an event tap that has never been
created, for a key that has never been pressed; its coalescing, pairing and
permission-fallback logic is fully tested on Linux against a scripted stub, but
whether macOS lets the tap exist at all is unknown until step 6 runs.
PR-028 wires all of that into the application and is verified the same way — the
whole path from the window picker to the frame ring to the screen policy runs
here against the Node helper stub (`pnpm demo:observe`, and
`apps/desktop/test/main/observation-runtime.test.ts`), and **not one pixel,
permission prompt or accessibility element in it has ever been real**. Step 7 is
what produces that answer.
PR-030 puts the model on the end of that same path — `observe_screen` reaches
the real `PilotScreenContextService`, a real image reaches the provider's inbox
(`pnpm demo:look`, `apps/desktop/test/main/model-observation.test.ts`) — and
inherits both gaps at once: the image is the stub's bytes and the provider is
Pi's faux one. Step 8 is what produces that answer.
PR-031 makes the question *point at something* — the §6 anchor is resolved at
submission and handed to that same facade, so `moment: 'question'` selects the
frame from when the question was asked, the crop is taken around the anchor and
the element under it reaches the model (`pnpm demo:ask`,
`apps/desktop/test/main/question-anchor.test.ts`). It inherits both gaps and
adds a third, which is the most important one in this file: **no real pointer
has ever been read and no real accessibility element has ever been
hit-tested**, so nothing anywhere has checked that the crop is centred on what
the user was actually pointing at. The frames it crops are real decodable
screenshots rendered by `renderSyntheticScreen`, because the stub's own frames
do not decode. Step 9 is what produces that answer.

---

## 2. Blocked on Codex sign-in

The user chose Codex subscription for model access (runbook amendment 7). Pi
0.84.1 supports it (`openai-codex`, `isSubscription: true`), verified by the
PR-005 spike. **No sign-in has happened**, and there is no API key in the Linux
environment, so no live provider call has ever been made.

Steps are in `docs/pi-notes.md` §9.1. Two findings to carry into it:

- **Use the device-code flow, not browser login.** Browser login binds local
  port 1455 and does *not* open a browser — it emits an `auth_url` the
  application must handle. The device-code flow is headless and is the right
  choice for a packaged app. PR-037 is written against this.
- Vision-capable models observed: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`,
  `gpt-5.6-luna`. `gpt-5.3-codex-spark` is text-only and must fail the
  capability gate rather than silently ignoring images.

**Fallback in use:** everything runs against the mock provider. Phase 2 is
unaffected. Phase 3 integration (PR-029 onward) can be *built* but cannot be
*demonstrated against a real model* until sign-in happens.

**PR-029 has now built it.** The desktop app holds real multi-turn text
conversations through a real `PiAgentSession`; the only thing standing in for a
model is Pi's own faux provider, reached through
`createDevelopmentModelSource()` in `@pilot/agent`. What that means in practice:

- `pnpm dev` and `pnpm demo:agent` both work today, end to end, with no
  credentials and no network. The answers are generated by
  `@pilot/agent`'s `answerFor` and say so in their own text, so nobody can
  mistake the demo for a model.
- Everything above the provider is the shipping path: the capability gate,
  `Agent.prompt`, streamed deltas, tool calls, `waitForIdle`, abort.
- **When you sign in, PR-037 changes one call site.** Everything downstream
  consumes the `ModelSource` interface (profile, `Models`, `Model`,
  `toolSupport`, a request counter, one line of description) and nothing else.

**What the mock cannot prove**, and therefore what the first real session must
be watched for: provider-side image encoding, real streaming timing, and
compaction summary quality. Add one more now that a real session exists: **how a
real model behaves when a run is aborted mid-sentence.** Pi reports an abort as a
final assistant message rather than an event (`docs/pi-notes.md`), and the faux
provider's version of that is necessarily tidier than a real provider's.

**PR-030 added the largest one yet: whether a model *decides* to look.** The
tool now reaches a real screen-context service, and an image really does arrive
in the provider's inbox — but the faux provider does not read it, and *that* it
called `observe_screen` is scripted by the demo and the tests
(`createScriptedModelSource`). So nothing here says anything about the two
questions that decide whether point-and-ask works at all: does the model call
the tool when answering needs the screen, and does it call it *again* when its
last observation is stale (system-design §11's whole premise). The first real
session should be watched for both, and for the third question underneath them:
whether a JPEG/PNG of a 1440-px window is legible enough for the model to read
small UI text at all. PR-043's grounding checklist is where that gets measured;
until then it is unknown, not assumed.

**PR-031 adds the question the whole product turns on: does the model answer
about the thing you were pointing at?** The envelope now carries a real
coordinate and a real element role, `moment: 'question'` selects the frame from
when the question was asked, and `view: 'pointer'` hands over a crop centred on
the anchor. What the faux provider cannot say is whether any of that *helps*:
it does not read the image and its answers are scripted, so nothing here shows
whether a model prefers the crop to the full frame, whether it uses
`pointer target: AXButton — …` at all, or whether it notices
"the window changed while the question was being asked". Watch the first real
session for all three, and for the failure that would be invisible in a
transcript: an answer that is confidently about the wrong control.

---

## 3. Accepted gaps against the MVP definition of done

Recorded so they are not discovered at release time.

| Gap | Why | Owner |
| --- | --- | --- |
| No notarization | No Developer ID account (user decision). A packaged app needs `xattr -dr com.apple.quarantine` or right-click → Open on any machine that did not build it, and TCC grants are re-prompted whenever the signature changes. | PR-042 |
| Development signing only | Same. `mac.identity` is null, hardened runtime off. | PR-042 |
| No CI | User decision. The five local commands in `docs/runbook.md` §6 are the only gate, run before every merge. | — |
| Grounding metric is a manual checklist | User decision — real apps rather than a purpose-built test app. ~30 cases, ≥90% required. | PR-043 |

---

## 4. Decisions taken without asking

Made under the standing instruction to use my own recommendation. Each is
reversible; raise any that look wrong.

| Decision | Reasoning |
| --- | --- |
| **PR-022 split into 022a/022b** | The PR-005 spike found compaction far larger than planned: Pi has no orchestrator, `AgentHarness.compact` is a stub, and the primitives operate on session `Entry[]` rather than the `AgentMessage[]` the agent holds. Pruning (022a) is nearly done; compaction (022b) is close to a full PR on its own. |
| **PR-007 sequenced after PR-002** | Both own root config and `apps/desktop`. Running them in parallel worktrees guaranteed a conflict in exactly the files PR-007 restructures. Cost: nothing on the critical path. |
| **PR-008 held until PR-007 landed** | Same collision, same reasoning — PR-007 rewrote the bundler under `apps/desktop` while PR-008 builds UI in it. |
| **`docs/system-design.md` corrected in place** | User-confirmed. Three claims were disproved by the spike; leaving them in a doc marked authoritative would mislead every future session. |
| **Agent worktrees excluded from lint/format** | `eslint .` was descending into other agents' half-written worktrees, making the verification gate nondeterministic — it failed and then passed with no code change. |
| **`dismiss-error` added to the desktop IPC validator** | The contract and the state machine had it; the renderer's validator did not, so the `error` state had no exit from the UI. Typecheck did not catch it because a narrower zod union stays assignable. |
| **The capability gate ANDs profile and probe in both directions** (PR-020) | A first draft let the Pi probe *override* a profile's `supportsVision: false`. That is backwards: setting it false on a capable model is how an operator selects the degraded accessibility-only mode of system-design §12, so overriding it would send screen images to a model the user asked not to show them to. The reverse case (profile claims vision, Pi disagrees) reports a distinct `profile-model-mismatch` so a stale profile stays diagnosable. |
| **`QuestionEnvelope.pointer` carries a sentinel, not `null`** (PR-024) | system-design §8 types it as a required numeric pair, so "no pointer recorded" is `UNKNOWN_NORMALIZED_POINT` (`-1,-1`, outside `[0,1]`) plus `grounding: 'pointer-unknown'`, read via `envelopePointerKnown()`. Nullable is the cleaner shape but needs a coordinated change across two readers. **Say if you would rather have `null`** — it is a small, contained change now and a wider one later. |
| **Replacement records say more than §11's example** (PR-022a) | §11 shows `[Observation scene-17/revision-4 removed. <summary>]` but its prose forbids a record that "claims an old screen description remains current". A past tense alone is a weak signal to a model, so every record also ends with "This is a past record of scene-17 at revision 4, not a description of the screen now", and names the scene the screen has since moved to when that is known. It also names which image went — full frame, pointer crop, or comparison half — because one observation can contribute several blocks and identical repeated sentences read as a bug. Longer than the example, and deliberately so: this is the difference between the model saying "you were on the billing page" and "you are on the billing page". |
| **`AgentRunHandle.completed` now waits for Pi to go idle** (PR-022a) | Found by this PR's own demo. `agent_end` fires before `Agent.prompt()` unwinds, so two questions in a row — `await submit(q1).completed; await submit(q2).completed` — produced `run-failed: "Agent is already processing a prompt"` on the second and every one after. Events were always correct; only the promise resolved a tick early. `completed` now also awaits `Agent.waitForIdle()`. Nothing else changed, but any caller that relied on `completed` resolving *before* the agent settled now resolves slightly later. |
| **Compaction summaries are extractive, not model-generated** (PR-022b) | §11 requires a summary to preserve goals, decisions, named UI elements, unresolved questions and safety-relevant facts, and to never claim an old screen description is current. Pi's `compact()` would ask the model to do that — a live provider call, a token cost per compaction, and a requirement a generative summariser can violate silently. Pilot's summariser instead quotes and derives every line from the transcript, so it cannot invent a screen it never saw, it is free, and the truthfulness bar is asserted by test rather than hoped for. The trade is richness: an extractive summary of a very long conversation is a list, not prose. `buildCompactionSummary` is a pure function of a typed input, so swapping in a model-backed one later is contained — **say if you would rather pay for generated summaries.** |
| **Compaction is on by default** (PR-022b) | §11 makes it a requirement, and a compactor nobody switches on is dead code. It is a no-op until a conversation is longer than the retained tail, so short sessions behave exactly as before; `compaction: { enabled: false }` turns it off entirely. |
| **The retained tail wins over the triggers** (PR-022b) | §11 asks for compaction "when any condition is met" *and* for the "last 6–10 text turns" in active context. Four observations can land inside six turns, so early in a conversation the two disagree. The tail wins and the outcome is reported as `nothing-to-compact` — compaction that discarded a turn the user is still talking about would be the worse failure. |
| **A compaction summary is a plain `user` message** (PR-022b) | Pi has a `compactionSummary` message type, but `Agent`'s default `convertToLlm` filters it out, so using it would have meant the model silently losing the history (`docs/pi-notes.md` §8). Pilot's summary is a `user` message whose first line says "Pilot's own record … not something the user said", so the framing does the work the message type would have. |
| **Pi's `shouldCompact` is consulted only above a 16384-token window** (PR-022b) | Its rule is `tokens > window − 16384` with the reserve fixed, so at or below that window it is always true and would drive a compaction every turn on any 8k or 16k local model. Reported as `provider-headroom`, kept separate from §11's three conditions. |
| **Observation is start/stop *and* pause/resume, not one switch** (PR-009) | system-design §6 lists "the user enabled observation" and "Pilot is not paused" as two separate conditions for capture, and the interaction contract has separate commands for them, so the panel offers both. Start/stop is "may Pilot watch this window at all"; pause/resume suspends everything, including anything the agent is doing. The indicator therefore has a distinct `paused` state that is not capture even when observation is switched on. **Say if you would rather have one switch** — collapsing them is easy, splitting them again later is not. |
| **"Change window" is selecting a different one, not its own command** (PR-009) | Adding a `clear-window-selection` member to `InteractionCommand` would have broken `@pilot/interaction`'s 330-cell transition table while PR-025/026/027 are in flight, and the contract already models the change: `select-window` stops the previous capture and clears its buffers before selecting. So the panel's change affordance is the per-window "Switch to this window" button plus a "Change window" control that takes you back to the list. Nothing in the shared contract changed. |
| **The window picker refuses a minimised window** (PR-009) | A window with `isOnScreen: false` cannot be selected, and one that becomes hidden while selected raises a warning rather than a stop. There is no design ruling on this; the reasoning is that offering a window there is nothing to see in is worse than explaining why it is unavailable. Revisit when PR-012 establishes what ScreenCaptureKit actually returns for a minimised window. |
| **Speech events are polled, not pushed** (PR-014) | Recognition callbacks arrive asynchronously, but the helper's stdio loop is single-threaded and blocking. Pushing would need a second thread writing frames concurrently with the request loop — a write lock and a second failure surface, in Swift that cannot be compiled here. PR-011 made the same call for window lifecycle. Callbacks queue inside the helper and the host drains every 60 ms; the two latency-critical paths (stopping speech, and the on-device decision) are request/response and do not poll at all. |
| **Stopping any spoken chunk stops all of them** (PR-014) | `AVSpeechSynthesizer` has one queue and one `stopSpeaking`, with no API to remove a single entry. Rather than fake per-utterance stopping, `stop(id)` returns every id it discarded and the adapter emits `stopped` for each, so PR-026 never waits on a chunk that will never be spoken. Documented on the contract; the signature is unchanged. |
| **Pilot refuses to record when recognition would leave the Mac** (PR-014) | `requireOnDevice` defaults to `true`, which is what PR-025's binding already sends and what PR-008's onboarding copy already promises the user. The alternative — recording and uploading with a warning — was rejected because `SFSpeechRecognizer` gives no signal after the fact that it happened. **Consequence worth knowing:** on a Mac that cannot recognise the user's language locally, voice input is unavailable until they opt in. The refusal carries a renderable disclosure explaining exactly that. |
| **`QuestionAnchorSource` declared on the interaction side** (PR-024) | No contract exposed scene plus pointer-by-instant/interval to that lane, and editing `packages/observation` mid-flight would have collided with PR-016. It mirrors `PointerTimeline` exactly, so PR-031's adapter is the identity function. Moving it onto `ScreenContextService` later is mechanical. |
| **The screen policy grew four groups beyond the interface printed in system-design §10** (PR-017) | §10's printed `ScreenPolicy` has no field for a ring byte ceiling (§17 requires one), for pointer retention (an utterance outlives the three-second frame ring), for image byte limits (§14 requires size *and* count limits on image tool results), or for the secure-content rule (§10 step 4 and §14 require one). `ScreenContextPolicy` in `packages/observation` adds them; `toScreenPolicyContract()` projects back onto the printed shape and a test pins that projection to `MVP_SCREEN_CONTEXT_POLICY`, so the numbers cannot drift. **`packages/shared` was not changed** — three lanes were running in parallel and none of the additions needed to cross a package boundary. |
| **New image byte ceilings were chosen, not derived** (PR-017) | Nothing in the docs states one. 4 MiB per image and 8 MiB per observation: a 1440-px JPEG at quality 0.75 is a few hundred kilobytes, so these only fire on a pathological encode, and they bound the base64 payload (4/3 inflation) at ~10.7 MiB. **Say if you want them tighter** — they are one field in a frozen record. |
| **Secure content defaults to `redact`, and refuses when it cannot mask** (PR-017) | §14 allows masking password fields but demands the product warn that screenshots can still contain secrets. Where macOS reports a secure field *without* bounds, Pilot cannot mask it; the default (`requireMaskableBounds: true`) refuses the observation rather than shipping it under a redaction claim it does not meet. The alternative — send it and warn — is available as a one-field policy override. |
| **No native image dependency; `sharp` was not adopted** (PR-018) | PR-018 owned the recorded `sharp`-on-arm64 packaging risk and chose not to take it on. PNG goes through Node's built-in `node:zlib` (native C, already in the runtime, nothing to prebuild, and asynchronous so it runs off the JS thread); JPEG goes through `jpeg-js@0.4.4` (pure JavaScript, BSD-3, zero dependencies, no install scripts, no binaries); `bgra` is a channel swap. Nothing new to unpack from an asar and nothing architecture-specific, so **PR-042 has no image-related packaging work**. The cost is stated below and in §5: pure-JS JPEG decoding is slow. `FrameCodec` is an interface precisely so a WASM or native codec can be injected later without a caller changing. |
| **The full frame is passed through unencoded whenever nothing has to change** (PR-018) | When a request needs no mask, no crop and no marker and the frame is already JPEG or PNG inside the 1440 px bound, the pipeline returns the capture's own bytes. This is the ordinary `view: 'window'` case. It removes the second JPEG generation entirely and costs ~0 ms. The safety conditions are all-or-nothing: anything to mask, crop or annotate takes the decode path. |
| **PNG is chosen over JPEG for interface content** (PR-018) | mvp-01 §10 makes JPEG the default and permits PNG "when compression makes small text unreadable". The pipeline measures the image (fraction of pixels identical to their left neighbour) and encodes interface content losslessly, photographic content as JPEG. Measured in the PR-018 demo: a second JPEG generation on a pointer crop taken at a non-block-aligned offset raises the mean luma error from 1.80 to 3.20 and the share of visibly-moved pixels from 3.2% to 7.6%. Lossless costs none of that, is usually *smaller* for flat interface content, and through `zlib` is roughly an order of magnitude faster than the pure-JS JPEG encoder. **Say if you would rather always ship JPEG** — it is one constant (`DEFAULT_ENCODING_SELECTION.flatRunRatioForLossless`). |
| **The content fingerprint was *not* replaced with a pixel-aware one** (PR-018) | PR-016 left the seam for this and asked PR-018 to consider it. It is deferred, on a measurement rather than a preference: a pixel-aware fingerprint has to decode **every sampled frame**, at 2–3 FPS, for as long as observation is on. The pure-JS JPEG decode measured ~165 ms for a policy-bounded 1440×960 frame, so at 3 FPS that is roughly half a CPU core burning continuously — a straight regression against §17's sampling budget, to fix a blind spot that PR-043 has not yet shown to matter. It becomes cheap the moment capture hands over `bgra` or `png` (see the row below), at which point the replacement is a small class behind the same `observe(frame) → ContentFingerprintUpdate` shape. Left for PR-043's evidence to decide, as §5 already says. |
| **`ImageRenderRequest.maxBytes` and `RenderedImage.stats` were added** (PR-018) | Both additive and optional, both inside `packages/observation`. `maxBytes` is the policy's own `image.maxImageBytes` passed *down*: the number stays a policy decision and the policy still enforces it, but the pipeline can now choose an encoding that fits instead of handing back a lossless image the enforcer must reject. `stats` is a content-free record of what the pipeline did and what each stage cost, which is how the §17 budget is measured rather than assumed. `FakeImageProcessor` does not set `stats`, so every reader handles `undefined`. |
| **Push-to-talk gets a new contract file rather than a seat on `PlatformAdapter`** (PR-015) | `HotkeyAdapter` lives in a new `packages/platform/src/hotkey.ts` with its own fake, exported by one added line in each index. Extending the `PlatformAdapter` composite would have forced every implementer — including the fakes the other four lanes are building against right now — to grow a member, which is not an additive change. PR-032 injects the hotkey adapter alongside the platform adapter. **Say if you would rather it be a member of the composite**; moving it later is mechanical, moving it now would collide with three PRs in flight. |
| **The helper pushes hotkey events, breaking PR-011's snapshot-diff rule** (PR-015) | PR-011 deliberately avoided helper-side events (a background thread writing frames means a write lock and a second failure surface). That is still right for windows. It is wrong for a key press: key-down is what stops speech against a 300 ms budget (system-design §17), and polling fast enough would be tens of round trips a second forever. So the hotkey is the one subsystem that pushes, and the Swift side gained a lock-protected `FrameWriter`. Cost: `HelperServer` and `HelperRuntime` changed (additively — see the README's contract note). |
| **Accessibility denial is a state, not an exception** (PR-015) | `hotkey.start` with no Accessibility grant *succeeds* and reports `unavailable(permission-missing)`. Throwing would tempt a caller into treating a routine, user-fixable condition as a crash, and system-design §16 requires the user always keep a way to ask a question. The panel pairs this with PR-025's `isTextFallbackAvailable(state)` — that pairing is runbook follow-up 4 and is still PR-032's to wire. |
| **Numbers chosen, not derived, for push-to-talk coalescing** (PR-015) | Nothing in the docs states them. A press within **30 ms** of the previous release is switch chatter and is dropped; a press held longer than **30 s** gets a synthetic release; the event tap may be re-enabled **5 times per 60 s** before being declared dead. All three are single fields. **Say if any looks wrong** — the 30 s ceiling in particular is a guess about how long a person might reasonably hold a push-to-talk key. |
| **`before-and-after` takes a comparison *window*, not two moments** (PR-017) | §9 says "two bounded frames around a relevant scene transition" but the tool input carries no timestamps, so someone has to choose them. The enforcer takes `comparisonWindow: {from, to}` and returns the earliest frame at or after `from` and the latest at or before `to`; PR-019 sets the window around the transition it finds in the scene lineage. The default window is the whole local buffer up to the question anchor. |
| **`before-and-after` takes a comparison *window*, not two moments** (PR-017) | §9 says "two bounded frames around a relevant scene transition" but the tool input carries no timestamps, so someone has to choose them. The enforcer takes `comparisonWindow: {from, to}` and returns the earliest frame at or after `from` and the latest at or before `to`; PR-019 sets the window around the transition it finds in the scene lineage. The default window is the whole local buffer up to the question anchor. **Discharged by PR-019** — see the `minSceneRevision` row below for what it chose and why time alone was not enough. |
| **Speech events are answered in `thinking` and `observing-screen`, not only in `speaking`** (PR-026) | Seven new transition cells. PR-006 only needed them in `speaking` because speech began when the run ended; once completed sentences enter TTS mid-run (system-design §7) a stream is live while the model is still working — and "Let me look at your screen" followed by an `observe_screen` call is the ordinary case, not an exotic one. Without the cells that `speech-started` is an `illegal-transition`, which writes a user-visible error. Every one of them is still behind the `activeSpeechId` identity guard. |
| **One `SpeechId` per answer, several adapter utterances behind it** (PR-026) | system-design §15 gives a *stream* an identifier, but an answer is spoken in pieces. The binding names them `<speechId>#<n>` and reports one `speech-started` and one `speech-finished` for the whole answer, so a synthesiser that completes chunk 1 cannot end the turn mid-sentence. PR-014/PR-033 map the native callbacks onto the same chunk identifiers. |
| **The phrase timeout is evaluated on the clock, not by a timer** (PR-026) | The machine is pure and owns no timers, so an unterminated fragment is released when the next run event arrives at or after `pendingAnswerSince + phraseTimeoutMs` (default 1200 ms), and unconditionally when the run ends. **No tail is ever lost.** What is *not* covered: a run that stalls and emits no further event at all speaks its tail only when it finally ends. Closing that gap needs either a new machine input or a scheduler in library code; say if you want it, and PR-027 is the natural place. |
| **Cancellation effects get their own queue** (PR-027) | `stop-speech` and `interrupt-run` are performed on a second promise chain that ordinary effects cannot block, because system-design §17 budgets TTS interruption at under 300 ms and a single queue cannot honour that — an interruption arriving while a "Look now" observation or a slow envelope build is in flight would have waited for it. Ordering within each chain is intact, and a barrier keeps each transition's own "stop before start" order (without it, a *later* interrupt could abort the run that had just replaced the one it was meant to stop — found by the PR-026 demo, which went silent). |
| **Every question and observation runs under an `AbortSignal`** (PR-027) | The machine can forget a run, but only a signal can stop work already in flight on the far side of an adapter. The controller aborts them the moment the machine stops waiting, which closes a window nothing else covers: a question interrupted *while it is being submitted* has no run id yet, so `interrupt()` is a documented no-op, and the agent would otherwise start a run nobody wants and hold the one-run-per-conversation slot against the next question. Cancelled work is reported on a new `subscribeCancellations` stream and never as `lastError` — a cancellation is not a failure. `ObservationControlPort.observe` gained an optional `signal` (additive; the only implementer was this lane's own fake). |
| **A steer carries a message written for the model, not the internal reason** (PR-027) | `AgentSession.interrupt(mode, detail)` reads `detail` differently per mode: for `abort` it never leaves Pilot, but for `steer` Pi injects it into the transcript as a user message **verbatim**. The machine was passing "interrupted by the user" / "paused" / "superseded by a new question", which the model would have read as the user's own words. Steers now carry `STEER_INTERRUPTION_MESSAGE`; aborts are unchanged. One PR-006 test assertion moved with it. |
| **The stalled-run tail was accepted, as an input plus a port — not a timer** (PR-027, runbook follow-up 6) | The gap PR-026 left is real (a model that emits a clause and then goes quiet says nothing until its run ends), and closing it needed real time. It is closed *without* the machine owning a timer: a new `phrase-timeout` input carries the identity of the fragment it is about (`pendingSince`, checked against `pendingAnswerSince` by the same guard that discards late transcripts), and a `Scheduler` port decides when to send it. Production passes `createTimeoutScheduler()`; tests pass `ManualScheduler` and fire it by hand. **It is opt-in**: without a scheduler the controller behaves exactly as PR-026 did, which is why every pre-existing test stayed deterministic and unchanged. The app must pass one — runbook follow-up 6. |
| **A `stopped` callback for speech Pilot itself stopped no longer reaches the machine** (PR-026) | It used to arrive as a `stale-speech` rejection — harmless but noise in the diagnostics, and indistinguishable from a genuine platform-initiated stop. The output binding now recognises its own teardown and reports `self-initiated` as a diagnostic; an *unsolicited* stop is still forwarded. |
| **`AccessibilityAdapter` gained two *optional* methods** (PR-013) | `availability()` and `ground()`, added the same way PR-011 added `PermissionAdapter.attribution?()`: optional, so every existing implementation and fake still satisfies the interface untouched, and no other lane has to change. system-design §5's two original methods are unchanged. The alternative — a second interface — would have split "the accessibility adapter" in two for no gain. |
| **Accessibility element *values* are off by default** (PR-013) | A value is arbitrary screen content, and the secure-field flag that would keep a password out of it is best effort (§14). So `MacAccessibilityAdapter` does not read `AXValue` unless a host opts in with `includeElementValues`, and never for a secure element. Cost: a consumer that wants the text in a field must ask for it deliberately. **Say if you would rather have values on by default** — PR-018/PR-028 are the consumers this affects. |
| **The accessibility hit test is scoped to the window's application** (PR-013) | `AXUIElementCreateApplication(ownerPid)` rather than the system-wide element, because a point inside the selected window can be covered by a notification or a floating palette from another app, and describing it would leak from a window Pilot is not observing. Cost: an element genuinely owned by a *different* process — a plugin host, an out-of-process web view — will not be found, and shows as `no target`. If real apps turn out to be full of those, the scoping is the first thing to loosen. |
| **Capture is pulled by the host, not pushed by the helper** (PR-012) | The helper's stdio loop is a single blocking read/answer cycle and a ScreenCaptureKit stream delivers on its own queue. Pushing frames would need a second writer racing the request loop for stdout — a write lock and an interleaving hazard on a *binary* body, in Swift nobody here can compile. The stream callback enqueues into a bounded in-helper queue and `capture.pull` drains it. Cost: one IPC round trip per frame (3/s). Benefit: one writer, explicit backpressure, and the drain rule lives in TypeScript where it is tested. |
| **Capture encodes JPEG in the helper at quality 0.9** (PR-012) | Raw BGRA at 1440×960 is 5.2 MB a frame; a three-second ring at 3 FPS would need ~47 MB against a 16 MiB bound. So capture must encode, and PR-018 encodes again — the double-JPEG risk already recorded in §5. `encoding: 'png'` is a one-line switch on `MacObservationAdapter` that removes the first lossy pass if PR-043 finds small text illegible; it costs ring bytes. **Say if you would rather start with `png`.** |
| **A motionless window is re-sent rather than left to age out** (PR-012) | ScreenCaptureKit only produces pixels when something changes, so a user reading a static page would fill the ring once and let it empty — and a question asked thirty seconds in would find no frame at all. On an idle frame the helper re-sends its retained encoding with a new instant and sequence, flagged `contentChanged: false`. It costs no new encoding and the frame is honest. It does assume idle frames arrive at the configured interval, which is unverified (§1 step 6, item 4). |
| **Unwired permissions default to `unknown`, which is refused** (PR-019) | `ScreenContextConditions` lets the app supply the three things the observation session cannot read — the pause switch, the TCC states and the capture source. The permission default is `'unknown'`, so a facade nobody has wired refuses every observation with `permission-denied` rather than proceeding on a guessed grant. The two failure modes are not symmetrical: guessing `'granted'` means Pilot tries to look at a screen it has no permission for and reports the resulting emptiness as a capture bug, while guessing `'unknown'` is a loud typed error that names the missing wiring. Recorded as runbook follow-up 18 so PR-028 cannot miss it. |
| **`ScreenContextService.clear()` takes an optional retention event** (PR-019) | §5 types it `clear(): void` and that call still works unchanged — the parameter is additive and source-compatible, so a `ScreenContextService`-typed reference is unaffected. The default is `'pause'`: it is the occasion §10 names first ("cleared on pause or lock") and it is non-terminal, so the scene lineage survives and a result that lands after the clear is refused as `superseded` rather than silently unknown. `clear('shutdown')` drops the lineage too. |
| **A `before-and-after` is bounded by a scene *revision*, not only by time** (PR-019) | PR-017 left the choice of `comparisonWindow` to this PR. The facade takes the most recent revision at or before the question anchor that actually changed something, finds the last frame captured before it, and asks for `from` = that frame, `to` = the anchor, plus `minSceneRevision` = the transition on the `after` half only. The time bound alone is not enough: frames arrive at 2–3 FPS and a transition lands between two of them, so "later than the transition" and "captured after the transition" are different claims. With no transition in the retained lineage the enforcer's own default (the whole local buffer up to the anchor) is used, and it either finds two frames or refuses — it never invents a comparison. |
| **Compact metadata rides beside `ScreenObservation`, not inside it** (PR-019) | §9's schema is strict and two other lanes parse it (PR-021) and prune it (PR-022a), so widening it would have been a contract change to both. `observeDetailed()` returns the same observation plus a `ScreenObservationMetadata` carrying frame provenance, image sizes and byte totals, the redaction report, the lineage verdict on the requested scene, and the `ActiveContextPlan` PR-022a evicts from. It is content-free by construction — a test asserts no image payload appears in its JSON — so it is safe to log and safe to show in the diagnostics panel. `observe()` is unchanged and still returns the bare observation, which is right for the tool: it may not see anything the model may not. |
| **An abort is honoured even by an adapter that ignores its signal** (PR-019) | `ObservationAdapter.captureFresh` takes the signal and the Mac adapter honours it, but §15 is a promise about the tool call rather than about every adapter. The facade races the capture against the signal, refuses promptly with the existing `request-cancelled` rule, and discards a frame that lands late instead of letting it enter the ring. It also checks the signal *before* the rate limiter takes a slot, so a cancelled call does not spend the next one's budget. |
| **`WriterLeaseHeldError` carries `code: 'internal'`, not a new error code** (PR-023) | "Another Pilot process is writing this conversation" deserves its own `PilotErrorCode`, but `PILOT_ERROR_CODES` feeds `PILOT_ERROR_DOMAIN_BY_CODE` — an exhaustive `Record` — and several lanes were in flight, so widening the union was not an additive change. The stable discriminators are `instanceof WriterLeaseHeldError` and `details.reason === 'writer-lease-held'`, exported with an `isWriterLeaseHeld()` helper. **Say if you would rather have a real `session-locked` code**; it is a ten-line change once the lanes are merged. |
| **Clear conversation reclaims the SQLite pages, at the cost of closing and reopening the database** (PR-023) | Deleting rows leaves the text readable in the file — `grep` finds it — and §13's "clear conversation" would then be a lie of the kind PR-041 exists to catch. `clear()` closes the repository, switches the file to `journal_mode=DELETE` (a `VACUUM` in WAL mode does not truncate), vacuums, and reopens. It is a user-initiated, once-in-a-while operation, and the demo greps for the text afterwards. |
| **A restored transcript that ends with an unanswered question keeps it** (PR-023) | Pilot writes at turn boundaries only, so a crash truncates the durable log between turns and this case should not arise; if it does, restoring the question is the kinder reading than deleting the user's own words on the strength of a guess about why the process stopped. Structurally impossible states — an assistant turn whose tool call nothing answered, an orphan tool result — *are* dropped, because several providers reject them outright. |
| **The durable transcript keeps a record of every withheld image** (PR-023) | A stripped image block becomes `[image withheld: image/png, 131072 base64 chars]`, and the pruning and compaction records around it name the scene and the window. So the pixels never reach disk, but *that an observation happened, of which window* does — which is what system-design §11 asks a persistent session to contain ("scene metadata, and tool audit metadata") and what makes a restored conversation legible. **Say if you would rather the audit record went too**; it is one line in `stripImageBlocks`, and it would leave a restored conversation unable to say why it once talked about a screen. |
| **Developer diagnostics are timings and counts by *type*, not by convention** (PR-010) | system-design §17 says metrics record timings and counts and §13 lists what is never logged, but a diagnostics panel is exactly where that gets broken by one `details: unknown`. So a telemetry sample is five numeric fields plus one field drawn from a closed vocabulary (abort reasons, or `PilotErrorCode`), `TelemetryRing` has no recording method that accepts a string, and the panel re-checks every sample against that vocabulary and withholds anything that does not fit. **Cost:** a future measurement that genuinely needs a free-text dimension cannot be added without changing the wire type — deliberately, so it is a visible contract change rather than a quiet one. |
| **The panel asks the transition table whether a control is available** (PR-010) | Every affordance calls `lookupRule(state, command)` from `@pilot/interaction`, and the text box calls `isTextFallbackAvailable(state)`. No hand-written `switch` decides what is possible. This is what makes runbook follow-up 4 closable rather than re-openable: the panel cannot disable the text box in `error` even by accident, because the table accepts `submit-text` there (system-design §16). **Consequence:** `apps/desktop` now depends on `@pilot/interaction`, and the package is bundled into the Chromium renderer. It has no Node built-ins, so this is safe today; keep it that way. |
| **The §17 timings are derived in the shell from the view-state stream** (PR-010) | STT duration, time to first token, time to first spoken sentence and observation calls per question are all edges of the `PilotViewState` stream the shell already subscribes to, so `ConversationGate` measures them once rather than asking PR-028/029/032/033 to each measure them slightly differently. It reads state names, booleans and the `pending` flag — never the transcript text. The four that genuinely cannot be seen from the view state (capture-to-observation latency, image bytes, active image count, the compaction counters) are left to explicit `telemetry.timing/count` calls whose owners are named in the gate's doc comment. |
| **A conversation panel with no shortcut still gets the fake hotkey adapter** (PR-010) | `main/index.ts` wires `FakeHotkeyAdapter` so the panel has a real `HotkeyAvailability` to render, and `PILOT_HOTKEY_FIXTURE=permission-missing pnpm dev` reaches the "no way to speak at all" state without editing source. **It wires availability only** — turning `hotkey-down`/`hotkey-up` into commands is runbook follow-up 6 and stays PR-032's, so the mapping never exists in two places. |
| **`context-compacted` is surfaced as counts, and its summary text is not recorded** (PR-010, runbook follow-up 9) | The panel has `context-tokens-before` / `context-tokens-after` metrics for PR-036 to fill from `PiAgentSession.lastCompaction`. The event's `summary` is deliberately not among them: it is a description of the conversation, which §17 does not permit a metric to hold. **Say if you want the summary visible somewhere** — it belongs in the transcript, not in diagnostics. |
| **Selecting a window switches observation on** (PR-029, and it is a *change of behaviour* in the app) | The interaction table has always said so — `select-window` sets `observationEnabled: true` and starts capture — but the fake controller the panel ran on said otherwise, so until PR-029 choosing a window left Pilot idle until you pressed Start. Replacing the fake with the real controller made the table's answer the app's answer, and three tests plus one demo that asserted the fake's answer were updated rather than the table. Reasoning: PR-010 deliberately made the panel *ask* the transition table what is possible instead of deciding for itself, and a panel that disagrees with the machine is the defect. Start, Stop and Pause all still work, so nothing became unreachable. **Say if you would rather choosing a window did not start capture** — it is one line in `packages/interaction/src/table.ts`, and it is a privacy-visible choice, so it is yours rather than mine. |
| **The panel's "Fake state" row was removed** (PR-029) | It forced the *fake* controller into a named view state by patching it. With the real controller there is no such door and there should not be one: a state is reached by sending the machine an input. The channel, the schema and the driver went with it. What replaced it, with no forced state anywhere: the Replay row now holds real conversations, and `PILOT_PERMISSION_FIXTURE`, `PILOT_HOTKEY_FIXTURE`, `PILOT_SPEECH_DISCLOSURE` and the new `PILOT_MODEL_FIXTURE` reach the states nothing can cause on demand. `shell.ts` had asked for exactly this ("Omit once PR-029 lands"). |
| **The panel's Replay row now holds real conversations** (PR-029) | PR-010's replay patched scripted view states onto the fake controller because nothing in that build could cause a conversation. This build can, so the five controls now dispatch the same commands the panel's own buttons dispatch. The scripted replay survives, but only for PR-010's headless walkthrough and the diagnostics privacy tests, which need exact words and an exact clock. Cost: a replay is now as slow as a real answer, so the IPC call that starts it is awaited. |
| **`QuestionEnvelope.pointer` keeps its sentinel** (PR-029, deciding runbook follow-up 2) | PR-024 asked whether `null` would be better. With `renderAnchoredQuestionEnvelope` now wired at the composition root, the sentinel never reaches the model as a coordinate — that was the whole risk. What is left is a shape preference, and changing a required field of a system-design §8 contract inside an integration PR is the kind of change the phase rules exclude. **Say if you would rather have `null`**; it is still a small, contained change. |
| **Speech output is a silent adapter, not the shared fake** (PR-029) | The shell needs something behind `SpeechOutputAdapter` until PR-033. `FakeSpeechOutputAdapter` reports `started` and then waits for a test to call `finish()`, which would leave the app in `speaking` for ever after its first answer. The replacement reports `started` then `finished` immediately and makes no sound. Consequence worth knowing: the panel briefly shows *Speaking* for an answer nobody hears. The alternative — no speech state at all — would have meant a different machine path in development from the one in production. |
| **The development model source lives in `@pilot/agent`, not in the app** (PR-029) | `apps/desktop` gained `@pilot/agent` as a dependency, which pulls Pi into the main bundle; it did **not** gain a dependency on `@earendil-works/*`. Every Pi type stays behind `@pilot/agent`'s door, which is what `packages/platform`'s facade comment asks for, and it is why the demo script and the desktop tests can build a scripted provider without importing Pi. Cost: the main bundle grew from ~90 KB to ~1.1 MB. It is inlined, not external, so the packaged asar still contains no `node_modules`. |
| **A refused capability is an agent that refuses, not a missing agent** (PR-029) | When the gate rejects the configured profile the app still builds a controller, over an `AgentSession` whose `submit` throws the refusal. The panel opens in `error` with the model's own `userMessage` and remedy, and the text box stays live (system-design §16). The alternative — no agent at all — would have made an unsupported model look like a broken Pilot. |
| **Capture is started with `encoding: 'png'` at the composition root, not by changing PR-012's default** (PR-028, confirming runbook follow-up 18) | PR-018 measured a `jpeg` *source* frame at ~165 ms of pure-JS decode per observation that needs a pointer crop — the only path over §17's 150 ms budget — plus a second generation of compression loss on exactly the small text grounding depends on. `bgra` avoids both but a three-second ring at 1440×960 needs ~47 MB against a 16 MiB bound, so `png` is the choice. It is set in `apps/desktop/src/main/platform-runtime.ts` (`CAPTURE_ENCODING`), which is the only place in the product that starts a capture stream. `MacObservationAdapter`'s own default is left at `jpeg`, because changing another lane's default inside an integration PR would rewrite PR-012's tests to mean something else. **Cost worth knowing:** PNG frames are larger on the wire than JPEG, so the ring holds fewer seconds of a busy window. Nobody has measured a real one — §1 step 7 asks for the number. **Say if you would rather pay the decode and keep JPEG.** |
| **A build with no helper runs on the fakes and says so, rather than failing to start** (PR-028) | `createPlatformRuntime` chooses the macOS adapters when there is a helper binary to talk to and the fake window/permission adapters otherwise, and reports which and **why** — in the startup log (`platform`, `platformReason`), in the panel's `usesRealPlatform`, and in the demo's first line. The alternative, refusing to start without a helper, would make every Linux development run impossible; the alternative of falling back quietly is the failure this project has been avoiding everywhere else. The fake build has **no capture adapter at all**: `FakeObservationAdapter` only produces a frame when a test calls `emitNext()`, which is the shape runbook cross-lane issue 10 records as wrong in an app. So on Linux the ring stays empty and every observation is refused with a typed error naming the missing capture source. |
| **The fake window-lifecycle controls survive, scoped to the fake build** (PR-028) | They were PR-028's to remove. Real enumeration is now wired, but only where there is a helper: on Linux the picker is still `FakeWindowAdapter`, and closing the observed window mid-observation is precisely the §16 behaviour that needs demonstrating. So `main/window-demo.ts` stays, and `main/index.ts` builds the driver only when the platform runtime reports a fake adapter — a build on the real enumeration passes `demoEvents: false` and the panel does not offer a control the main process would refuse. **Say if you would rather they went entirely**; it is one deletion plus one option. |
| **"Look now" asks for `view: 'window'`, `moment: 'current'`** (PR-028) | `moment: 'current'` is the honest reading of "look now" — a fresh capture rather than whichever frame is in the ring. `view: 'window'` rather than `'both'` because a pointer crop is cropped around the *question* anchor and there is no anchor until PR-031 wires one; cropping around a pointer nobody pointed with would be a picture of the wrong thing. It also means an unchanged frame is passed through unencoded (PR-018), so the ordinary look costs no re-encode. The model's own `observe_screen` chooses its own view and moment and reaches the same facade through PR-030. |
| **A failing attribution verdict makes the observation path read the permissions as `denied`** (PR-028, closing runbook follow-up 16) | PR-011's verdict answers a different question from the permission API: "macOS says granted" and "the grant reaches this process" are not the same claim. Under the `enforce` policy the adapter throws before reporting anything, but under `warn` — and against the stub, where the identity is invented — a `granted` state would otherwise flow straight into `ScreenContextConditions` and Pilot would capture nothing while reporting no error. `observationPermissionConditions` maps `helper-attributed` and `bundle-mismatch` onto `denied`; `unknown` is deliberately left alone, because PR-011 calls it a non-answer rather than a failure. |
| **`ObservationAdapter.subscribeEvents` added as an *optional* member** (PR-012) | Capture has to report why it stopped — window lost, screen locked, protected content — and how many frames it refused; the four verbatim methods from system-design §5 carry none of that. Optional keeps it source-compatible: every existing implementation, including the shared fakes, still satisfies the interface untouched. Same shape as PR-011's `PermissionAdapter.attribution?()`. |
| **The model and the user share one `ScreenContextService` instance, not two** (PR-030) | `createAgentRuntime({ screenContext: observation.screenContext })` passes the object the interaction port already drives, rather than building a second facade over the same session. Consequence worth knowing: §10's rate limiter (2 observations/second) counts a model look and a "Look now" **together**, so a user who presses Look now twice while the model is looking will see a `policy-rejected` refusal. That is the intended reading — the limit exists to bound how much of the screen leaves the machine, and it would be meaningless if a second caller had its own budget — and it also means one scene lineage, one retention guard and one decoded frame. `pnpm demo:look` §6 shows the refusal happening. **Say if you would rather the user's own looks were exempt**; it is a second rate limiter, and it would be a deliberate weakening of a §10 bound. |
| **A "Look now" refusal is rewritten into PR-021's shape, but a curated sentence survives** (PR-030) | The tool already attaches `describeObserveScreenFailure`'s sentence and a `retryable` flag; the manual path threw whatever the facade threw, and `PilotError.userMessage` defaults to the *technical* message. `main/observation-failure.ts` now maps every manual refusal onto the same coarse failure kind — but keeps the `userMessage` when the producer wrote a distinct one, because PR-017's §10 rule table is more specific than the eleven coarse kinds: `unmaskable-secure-region` ("Pilot cannot hide a password field it cannot locate") would otherwise be flattened into `protected-content` ("This application blocks screen capture"), which is coarser *and false*. Cost: the two paths can show two different sentences for the same code. **Say if you would rather one sentence per failure kind everywhere**; it is deleting one conditional. |
| **The failure mapping happens in the main process and crosses IPC as data** (PR-030) | `describeObserveScreenFailure` lives in `@pilot/agent`, which pulls Pi in with it, and the panel's view models are bundled into Chromium — so importing it renderer-side would have put a Pi type in the renderer, which PR-029 recorded as the thing to keep out. The mapping runs where the refusal is produced and the result rides on `SerializedPilotError.details`, which `serializedPilotErrorSchema` already validates, so **no IPC contract changed**. `src/observation/failure-view.ts` is the renderer-safe reader, and a compile-time assertion in `main/observation-failure.ts` fails the build if the two ever disagree about the tool's name. |
| **`QuestionAnchorSource` stays on the interaction side** (PR-031, deciding runbook follow-up 3) | PR-024 asked whether it belongs on `ScreenContextService` instead and called the adapter mechanical. It stays where it is, and the adapter (`createObservationAnchorSource`, 25 lines in the composition root) stays too. The deciding reason is not effort: `ScreenContextService` is the *entire* surface `observe_screen` may reach screen state through, so three pointer-timeline methods on it would give the model's tool a raw read of pointer history — accessibility roles and labels included — that bypasses §10's seven-step policy. The second reason is that it would be a contract change to a system-design §5 interface inside an integration PR, which the phase rules exclude. The third is that writing the adapter was worth it: the predicted identity function is not quite one (`PointerTimeline.select` has a `scene-mismatch` failure the port has no name for, and `core.selectPointer` scopes to the current scene by default), and both differences are now stated in one place instead of being discovered later. **Say if you would rather have it on `ScreenContextService`** — still mechanical, and it becomes a `packages/` change rather than an app one. |
| **The anchor's element is retained separately from the pointer timeline** (PR-031) | The timeline keeps a `GroundedPointer`, whose `accessibilityTarget` is a summary — role, label, normalised bounds — with any secure value already dropped. §10's redaction step needs two fields that summary does not carry, `isSecure` and screen-point `bounds`, so handing it to the facade would have quietly disabled masking of a password field under the user's own pointer. `PointerTargetLog` (`main/question-anchor.ts`) keeps the platform's own `AccessibilityNode` beside the timeline, keyed by the instant of the sample it belongs to, bounded at 4096 records, **and it refuses to retain anything for a pointer outside the selected window** — so there is nothing to leak rather than a filter that could be got wrong. It is dropped by the retention guard in the same call that empties the ring: a role and a label read off a screen are screen content (§13). |
| **The pending anchor is withdrawn when the question is answered, and the record is kept** (PR-031) | `moment: 'current'` still reads the anchor — for its pointer, its `requestedScene` and its element — so a "Look now" pressed after an answer would otherwise be grounded on the previous question's pointer and told to validate a scene reference nobody asked about. The live anchor is therefore cleared the moment the machine stops waiting for an utterance. What is *not* cleared is the diagnostic record of what the last question was grounded on (`lastAnchor()`), because that is what the panel and the demo want to show afterwards. |
| **A question that cannot be anchored is still a question** (PR-031) | No pointer sample, no scene, or a scene belonging to a window other than the selected one: each drops the anchor and records why (`lastSkip()`), and the question is submitted anyway. The envelope already says so in words (`grounding: 'pointer-unknown'`, with a note), the facade reads a `null` anchor as "a look at now" — which is what an unanchored question is — and system-design §16 keeps the text box the way out of every degraded state. The alternative, refusing to submit, would make a momentarily-missing pointer look like a broken Pilot. |
| **The app now sends `ownerPid` with every pointer grounding** (PR-031, runbook cross-lane issue 12) | `AccessibilityGroundingTarget.ownerPid` is optional and **both** of PR-013's defences against describing another application's element are conditional on it. PR-028 omitted it, which cost nothing until PR-031 made the element reach a prompt — and then it put a label from the *other* stub window straight into the model's request. `ownerPidFor` reads the pid off `MacWindowAdapter.lastSnapshot` structurally, so a `WindowAdapter` without that getter still works and simply falls back to the geometric check. **The real fix is `ownerPid` on the window contract** (runbook follow-up 29); until it lands, any new caller of `ground`/`groundFast` must pass it by hand, and nothing in the type system will say so. |
| **`ScreenContextAnchor.at` is the pointer sample's instant, not the submission's** (PR-031) | `screenContextAnchor` (PR-019) projects `QuestionAnchor.at`, which is when the anchoring *sample* was taken, and the facade selects the frame at or before it. In the app the two are within the same skew bound the envelope uses (±1000 ms, and in practice a few milliseconds at 30 Hz), so it behaves as "the screen when you asked". It was left as PR-019 wrote it rather than overridden with `askedAt`: selecting a frame at or before the sample the question is grounded on is the more defensible reading, and changing another lane's projection inside an integration PR is what the phase rules exclude. **Consequence worth knowing:** on a Mac where pointer sampling falls behind, `moment: 'question'` selects an older frame than it needs to — §1 step 9 item 3 asks for the number. |
| **`ObservationView` gained `looking`, and `capturing` was left alone** (PR-030) | system-design §14 asks the user be able to see Pilot looking at their screen. PR-009's indicator answers a different question — "may Pilot watch this window" — and it is the app's single answer to it, so it was not touched and no seventh indicator state was added. `looking` is a second boolean, true in exactly the one interaction state (`observing-screen`) that both the model's tool call and "Look now" pass through. Both are rendered, side by side, because "Pilot may watch this" and "Pilot is reading this right now" are different promises and collapsing them would make the more sensitive one invisible. |

---

## 4a. Progress

| Phase | State |
| --- | --- |
| Phase 1 — foundations (PR-001…007) | **Complete.** All seven merged. |
| Phase 2 — capability lanes | In progress. **The observation lane (PR-016 → 017 → 018 → 019) is complete.** **Merged:** PR-008, PR-011, PR-016, PR-017, PR-018, PR-019, PR-020, PR-021, PR-022a, PR-024, PR-025, PR-026, PR-027. **In flight:** PR-009, PR-012, PR-013, PR-014, PR-022b. **Remaining:** PR-010, PR-015, PR-023. |
| Phase 2 — capability lanes | In progress. **Merged:** PR-008, PR-011, PR-016, PR-017, PR-020, PR-021, PR-022a, PR-024, PR-025. **In flight:** PR-009, PR-012, PR-013, PR-014, PR-018, PR-022b, PR-026. **Remaining:** PR-010, PR-015, PR-019, PR-023, PR-027. |
| Phase 2 — capability lanes | In progress: PR-008, PR-011, PR-016, PR-020, PR-021, PR-022a, PR-024, PR-025 merged; PR-009 ready; PR-012, PR-013, PR-014, PR-017, PR-022b, PR-026 in flight. |
| Phase 2 — capability lanes | In progress: PR-008, PR-011, PR-016, PR-020, PR-021, PR-024, PR-025 merged; PR-012, PR-013, PR-014, PR-017, PR-022a, PR-026 in flight. |
| Phase 2 — capability lanes | In progress. **Merged:** PR-008, PR-011, PR-016, PR-017, PR-020, PR-021, PR-022a, PR-024, PR-025, PR-026, PR-027 (the voice and interaction lane is complete). **In flight:** PR-009, PR-012, PR-013, PR-014, PR-018, PR-022b. **Remaining:** PR-010, PR-015, PR-019, PR-023. |
| Phase 2 — capability lanes | In progress: PR-008, PR-011, PR-016, PR-017, PR-018, PR-020, PR-021, PR-022a, PR-024, PR-025 merged; PR-009, PR-012, PR-013, PR-014, PR-022b, PR-026 in flight. |
| Phase 2 — capability lanes | In progress. **Merged:** PR-008, PR-011, PR-015, PR-016, PR-017, PR-020, PR-021, PR-022a, PR-024, PR-025. **In flight:** PR-009, PR-012, PR-013, PR-014, PR-018, PR-022b, PR-026. **Remaining:** PR-010, PR-019, PR-023, PR-027. |
| Phase 2 — capability lanes | In progress. **Merged:** PR-008, PR-011, PR-015, PR-016, PR-017, PR-018, PR-020, PR-021, PR-022a, PR-022b, PR-024, PR-025, PR-026, PR-027. **In flight:** PR-009, PR-010, PR-012, PR-013, PR-014, PR-019. **Landing now:** PR-023 — the agent runtime lane (PR-020 → 021 → 022 → 023) is complete. |
| Phase 2 — capability lanes | **The desktop lane (PR-008 → 009 → 010) is complete.** PR-010 closed runbook follow-up 4 (both copies) and the panel halves of follow-ups 9 and 13. |
| Phase 3 — integration (028…036) | **In progress.** PR-029 (text conversation with a real Pi session) first, because it is the one integration step fully verifiable on Linux. PR-028 and everything from PR-030 onward also need the Mac (§1); nothing past PR-029 can be *demonstrated against a real model* until the Codex sign-in (§2). |
| Phase 3 — integration (028…036) | In progress. **PR-029 is merged**: the desktop app holds real, multi-turn, interruptible text conversations through a real `PiAgentSession` — against a faux provider, because §2 is still open. Observation, speech, permissions, the window list and persistence are still fake. The remaining steps mostly need the Mac (§1) and a signed-in model (§2). |
| Phase 3 — integration (028…036) | In progress. **PR-028 is merged**: the observation boundary is real. The window picker, the permission states and the capture lifecycle run on `MacWindowAdapter`, `MacPermissionAdapter`, `MacAccessibilityAdapter` and `MacObservationAdapter`, the frames land in a real `ObservationCore` ring, and PR-019's `PilotScreenContextService` answers behind it — verified end to end against the Node helper stub, and **never once against macOS** (§1 step 7). Speech, the model, persistence and the agent-side `observe_screen` (PR-030) are still fake. |
| Phase 3 — integration (028…036) | In progress. **PR-030 is merged**: the model can see the selected window. `observe_screen` reaches PR-019's real `PilotScreenContextService` — the same instance "Look now" drives — and a real image reaches the provider's inbox; the observing state is visible while it happens and a refusal reaches the user as a sentence. Selected-window-only was re-proved against the real service. **Never once against macOS, and never once against a real model** (§1 step 8, §2): the pixels are the Node helper stub's and the tool call is scripted. Speech, persistence, the question anchor and the model itself are still fake. |
| Phase 3 — integration (028…036) | In progress. **PR-031 is merged: point-and-ask works.** The §6 question anchor is resolved at submission from the real pointer timeline and handed to the same `PilotScreenContextService` the tool holds, so `moment: 'question'` answers from the frame that was on screen when the question was asked, `view: 'pointer'` crops around the anchor, and the element under it reaches the model as `targetRole`. `FakeQuestionAnchorSource` is gone from the real path and `ScreenContextInputs` has no unwired input left. It also fixed a real leak PR-028 left (runbook cross-lane issue 12). **Never once against macOS, and never once against a real model**: no real pointer has ever been read and no real accessibility element has ever been hit-tested (§1 step 9, §2). Speech, persistence and the model itself are still fake. |
| Phase 4 — providers (037…039) | Not started. PR-037 (Codex) is the one the user's decision selects. |
| Phase 5 — hardening and release (040…044) | Not started. |

Last full regression on `main` (after PR-017 and PR-022a): 997 tests across 66
files, and **all twelve demos executed green** — observation, scene, policy,
interaction, envelope, voice, `observe_screen`, visual-context, permissions,
helper transport, helper permissions, and the real-Electron headless smoke.

Verification standard on every merge: `pnpm lint`, `typecheck`, `test`, `build`
re-run by the orchestrator — never taken on a subagent's word — plus each PR's
demo executed against the merged tree.
---

## 5. Risks worth watching

- **The SQLite writer lease is a launch-time failure mode nobody has seen yet**
  (PR-023). The session database is single-writer: the backend claims a row in
  `writer_leases`, renews it every 10 s, and releases it on `close()`. A second
  Pilot instance, or a relaunch inside 30 s of a crash, fails to open the
  conversation — deliberately, with a typed error and a user-facing sentence,
  rather than corrupting anything. Two things have to be true in the app for
  that to read as "wait a moment" instead of "Pilot is broken": `close()` must
  run on quit (runbook follow-up 18), and the error must reach the UI rather
  than a log. Until PR-036 wires it, neither is true. The mechanism itself is
  tested — second writer, crashed writer, and a zombie whose write is rejected
  after a takeover — but only against a temporary directory on Linux, never
  against a real Electron quit or a real force-quit on macOS.

- **TCC attribution for the spawned Swift helper** remains the top structural
  risk in the plan. PR-011 has landed the *detection* for it — a typed
  `permission-attribution-mismatch` that fires instead of reporting a
  permission Pilot cannot actually use — but the **answer is still unverified**.
  §1 step 5 is what produces it. If macOS attributes permissions to the helper
  rather than the parent bundle, the permission model in
  `docs/system-design.md` §4 needs rework, and PR-012 through PR-015 are all
  built on the assumption that it does not.
  - What PR-011 guarantees today: if attribution *is* wrong, Pilot says so
    loudly and specifically rather than reporting `granted` and capturing
    nothing. What it does not guarantee: that attribution is right.
  - If it turns out wrong, the likely remedies are an XPC service with its own
    bundle inside the app (so the identity is deliberate rather than
    accidental) or moving these calls into the Electron main process. Both are
    larger than PR-011 and neither has been designed.
- **Secure-field detection may never fire** (PR-013). The product promises
  best-effort masking of password fields (system-design §14) and PR-018's
  redaction is driven entirely by the `isSecure` flag this PR produces. That
  flag is set only when macOS marks an element `AXSecureTextField` as a role, as
  a subrole, or within four ancestors — and **whether real applications expose
  it that way has never been checked** (§1 step 6). Deliberately no heuristic on
  labels: guessing "Password" from a placeholder would create the appearance of
  coverage while leaving every non-English and unlabelled field uncovered.
  Either way the guarantee stays honest — `SECURE_FIELD_DISCLOSURE` is exported
  as the exact sentence the UI must show, and `secureBasis: 'none'` means
  "macOS did not mark this", never "this is safe". **The product must not
  describe this as redaction of secrets; it is redaction of recognised fields.**
  **PR-031 is what connected it.** Until this PR the flag had no consumer in the
  app: `ScreenContextInputs.anchor` was never set, so `pointerTarget` never
  reached §10's redaction step and no mask was ever computed from a real
  element. It does now — the anchor carries the platform's own
  `AccessibilityNode`, `isSecure` and screen-point `bounds` and all — so §1 step
  9 item 2 (point at a real password field and ask) is the first observation
  that can tell whether the redaction path fires at all. If it never does, the
  chain is: no `AXSecureTextField` → no `isSecure` → no mask → a password in a
  pointer crop, with the caveat text still promising best effort.
- **The helper has no run loop, and speech frameworks may want one** (PR-014).
  `HelperRuntime.run` blocks the main thread in `read()` for the life of the
  process. Anything Apple delivers on the main queue therefore never fires.
  `SFSpeechRecognizer.queue` is set to a queue the helper owns, and
  `AVSpeechSynthesizer`'s completion is additionally reconciled from
  `isSpeaking` so it does not depend on its delegate at all — but neither
  mitigation has been observed working. If §1 step 6 shows no partial
  transcripts, the remedy is to run the stdio loop on a background thread and
  spin a run loop on the main one. That is a PR-003-shaped change to the
  helper's threading model and would affect PR-012 and PR-013 as well, which is
  exactly why it was not done speculatively.
- **Nothing about ScreenCaptureKit has ever run** (PR-012). The capture engine
  is the largest piece of unverified Swift in the tree, and three of its
  assumptions are load-bearing enough to be worth stating on their own:
  - **Idle frames arrive at the configured interval.** If they do not, a
    motionless window puts nothing in the ring and a question about a static
    page finds no frame. §1 step 6, item 4 is the check.
  - **A protected window reports `SCFrameStatus.blank`.** If it instead hands
    over black pixels, `protected-content` never fires and the model describes
    a black rectangle as though it were the application. §1 step 6, item 5.
  - **The mach → epoch timestamp conversion is right.** If it is not, every
    frame is rejected by the ring as stale and Pilot observes nothing *while
    reporting no error at all*. The host substitutes its own clock when the
    skew is implausible, which turns a silent failure into a logged one, but
    the conversion is what should be correct. §1 step 6, item 2.
- **Push-to-talk may need a permission Pilot does not model** (PR-015). The
  event tap is gated on Accessibility, which is one of the four permission kinds
  in `@pilot/shared`. On macOS 10.15+ a keyboard tap may *also* require **Input
  Monitoring** (`kTCCServiceListenEvent`), which is a separate TCC service with
  its own System Settings pane and its own prompt. Nothing in the code models
  it, because adding a fifth `PermissionKind` is a contract change across
  `@pilot/shared`, the onboarding UI, the helper and four lanes' fakes — and it
  would have been a guess.

  What is in place today: if `CGEventTapCreate` returns null while Accessibility
  is granted, that is reported as a distinct `listener-rejected` state naming
  Input Monitoring in its detail, rather than being blamed on Accessibility and
  sending the user to a pane that will not help. §1 step 6 is what settles it.
  If it turns out to be required, expect a small, contained follow-up: one more
  permission kind, one more settings URL, one more onboarding row.
- **`sharp` prebuilds inside packaged Electron (arm64)** — PR-018 owns image
  encoding; the packaging interaction has not been tested.
- ~~**`sharp` prebuilds inside packaged Electron (arm64)**~~ — **CLOSED by
  PR-018, by not taking the risk.** There is no native image dependency: PNG
  through `node:zlib`, JPEG through pure-JS `jpeg-js`, `bgra` through a channel
  swap. Nothing to prebuild, nothing architecture-specific, nothing for PR-042
  to unpack from the asar. The risk it was traded for is the next bullet.
- **Pure-JS JPEG decoding is the pipeline's one over-budget number** (PR-018,
  measured, replaces the `sharp` risk). §17 targets under 150 ms of image
  preprocessing per observation. Measured on the Linux development machine for
  one full frame plus one pointer crop at the capture size the policy actually
  requests (1440 px longest edge — `toCaptureOptions` bounds it there):

  | source frame | secure field in view | total |
  | --- | --- | ---: |
  | `bgra` | no / yes | 74 / 102 ms |
  | `png` | no / yes | 71 / 135 ms |
  | `jpeg` | no / yes | **165 / 259 ms** |

  The full frame is free when nothing has to change (the bytes are passed
  through); the cost is decoding a JPEG *source* to get pixels for the crop, at
  ~165 ms for 1440×960 in `jpeg-js`. Three ways out, cheapest first:

  1. **Have PR-012 deliver `bgra` or `png` frames** rather than JPEG. This is
     the recommended one: it removes the decode cost *and* the double-JPEG
     generation loss below, and needs no contract change — `FrameEncoding`
     already admits all three. A 3-second ring at 1440×960 `bgra` does not fit
     the 16 MiB ring ceiling (§17), so `png` is the realistic choice there and
     `bgra` the right one for a fresh `captureFresh` capture.
  2. Inject a WASM or native codec through `FrameCodec`. One line at the
     construction site; no caller changes.
  3. Host the pipeline in a `worker_threads` worker (PR-019/PR-028). This does
     not make it faster, but §17 and mvp-01 §10 require it anyway — the main and
     renderer processes must not block on image encoding. The pipeline is a pure
     function of bytes and numbers, with no handles and no platform state, so it
     is worker-transferable as written.

  A Mac is faster than this container, so the real numbers will be lower; the
  ordering will not change. **Nothing is blocked on this** — it is a latency
  target, not a correctness bound.
- **Double-JPEG legibility of small text** — capture encodes once, the
  processing pipeline encodes again. **Measured by PR-018 and largely
  mitigated.** On a pointer crop taken at a non-block-aligned offset (which is
  every pointer crop), a second JPEG generation at q0.75 raises the mean luma
  error against the compositor's pixels from 1.80 to 3.20 and the share of
  pixels moved by more than 8 from 3.2% to 7.6%. The pipeline avoids paying it:
  a full frame that needs no change is passed through unencoded, and interface
  content is re-encoded losslessly as PNG. It is still paid on photographic
  content, and on any frame where the model asks for a crop of a JPEG capture.
  If grounding accuracy on small UI text disappoints in PR-043, check this
  first, and check it together with the row above — both are solved by capture
  handing over `bgra` or `png`.
- **The content fingerprint cannot see a small, high-meaning change** (PR-016,
  and worth understanding because it shapes product behaviour). Scene revisions
  are minted when ≥15% of the *encoded* payload changes. A toggle flipping or a
  single digit changing is roughly 3% — below the bar. That is precisely the
  kind of change a user points at and asks about.

  Mitigations already in place: window title and accessibility-root changes are
  separate revision components, so many such changes are caught another way; the
  threshold is biased to over-report, because a false positive costs one
  observation while a false negative lets the model answer from a screen that no
  longer exists; and the model can always call `observe_screen` with
  `moment: 'current'` to force a fresh look regardless of revision state.

  The residual risk is a stale `lastObservedRevision` making the model *believe*
  its old observation is current after a small change. If acceptance testing
  (PR-043) shows wrong answers after toggles and small edits, the fix is a
  pixel-aware fingerprint — `ContentFingerprinter` is a standalone injectable
  component precisely so it can be replaced behind the same interface.
  **PR-018 considered doing exactly that and did not**, for a reason worth
  keeping: a pixel-aware rule must decode every sampled frame, and the pure-JS
  JPEG decode is ~165 ms for a policy-bounded frame, which at the 2–3 FPS
  sampling rate would burn most of a core continuously for as long as
  observation is on. It becomes cheap as soon as capture delivers `bgra` or
  `png` (see the JPEG-decode bullet above), so the two decisions are the same
  decision. PR-018 left the seam untouched and the code path unused.
  Two further blind spots are documented in `content-fingerprint.ts`: the same
  edit scores very differently near the top versus the bottom of a window in an
  entropy-coded format, and non-deterministic encoders or animation cause
  continuous false positives that keep `lastObservedRevision` permanently
  behind.
- **Redaction is best effort, and the product must say so out loud** (PR-017).
  The policy masks only fields the accessibility tree marks `isSecure`. A secret
  in a plain text field, a token in a terminal, a recovery code rendered as an
  image, or a notification banner from another app overlapping the window all
  pass through untouched. Every allowed observation therefore carries
  `SCREEN_REDACTION_CAVEAT` — "a screenshot can still contain secrets outside
  recognised fields" — whether or not anything was masked, so no caller can read
  "redaction applied" as "safe". **This sentence needs to reach the user
  interface, not only the model**: PR-021 surfaces it to the model, and the
  onboarding/observation UI (PR-009/PR-010) is where a person should see it.
  Nothing in the current UI says it yet.

  PR-018 added the pixels behind the promise and nothing to the promise. Masks
  are painted on the source frame **before** the crop and before the resize, with
  rectangles rounded outward, so a downscale cannot leave a rim of a password
  field outside a rounded mask; the pipeline reports how many rects it painted
  and how many lay outside the frame entirely, rather than dropping either
  silently; and pass-through — returning the capture's own bytes — is refused
  outright whenever there is anything at all to mask. The pipeline still does
  not *detect* anything: it paints what PR-013's `isSecure` flag produced, and a
  frame with no masks remains a frame that may be full of secrets.
- **One decoded screenshot outlives an observation, on purpose** (PR-019).
  `PilotImageProcessor` keeps at most one decoded frame so a `view: 'both'`
  request decodes its source once rather than twice, and so a repeat look at the
  same moment costs nothing. It is memory-only and never written anywhere, but
  between two observations it *is* a screenshot sitting in the heap. PR-019
  wired it into `RetentionGuard`, so pause, screen lock, window loss, shutdown,
  logout, permission loss, window change and observation-disabled all drop it in
  the same call that empties the frame ring, and the report says whether a cache
  was wired rather than assuming one was. **The residual is the door, not the
  lock:** `ObservationSession` clears the core *directly* on window loss and
  screen lock, which is not the guard. The facade notices at the next
  observation and drops the cache then, which is a backstop. Routing lifecycle
  events through `RetentionGuard.clearFor` (runbook follow-up 19) closes the
  window between the event and the next look, and PR-041 should assert it.
  **PR-028 closed that door**: every lifecycle path in
  `main/observation-runtime.ts` — stop, pause, screen lock, window loss,
  permission loss, shutdown — ends in `RetentionGuard.clearFor`, which drops the
  ring, the pointer timeline and the decoded frame in one call and then throws
  rather than reporting a clear that did not work. The occasion is named by the
  event that caused it, so the retention log says `screen-lock` rather than
  guessing. What is *not* closed: none of it has cleared a real screenshot,
  because none has ever existed here.
- ~~**Nothing supplies the facade's permission states yet** (PR-019).~~
  **CLOSED by PR-028.** `apps/desktop/src/main/observation-runtime.ts` feeds
  `MutableScreenContextInputs.setConditions` from the permission gate's
  snapshot plus PR-011's attribution verdict, and `paused`/`enabled` from the
  interaction controller's view state. `captureSource` is pinned to
  `'selected-window'`, which is the only thing `MacObservationAdapter` can
  produce. If a Mac that plainly has the grant still refuses, read the verdict
  first: a `helper-attributed` or `bundle-mismatch` attribution is deliberately
  reported as `denied`, because a grant credited to the helper is one Pilot
  cannot use.
- **The whole observation path is now real code that has never touched a
  screen** (PR-028). This is the largest gap in the tree. Every object between
  the window picker and the frame ring is the shipping one and every one of them
  is exercised end to end — but against the Node helper stub, whose "frames" are
  deterministic bytes with meaningful headers and meaningless contents. In
  particular: **the decode-and-crop half of §10 step 5 is not reachable through
  the stub at all** (its bytes are not a decodable PNG), so the only place a real
  pointer crop is rendered is one test that encodes a synthetic screen with the
  pipeline's own codec. On a Mac that path runs on every observation the model
  asks a pointer question about. §1 step 7 is what settles it.
- **PNG frames are larger than JPEG ones, and the ring is 16 MiB** (PR-028,
  following PR-018's recommendation). Choosing `png` removes ~165 ms of pure-JS
  decode and a second generation of compression loss; it costs ring seconds, and
  nobody has measured a real window's PNG frame. If a normal UI window turns out
  to produce frames over ~1.8 MB the three-second ring will not hold three
  seconds, and the fix is either `quality`/scale on the capture options or going
  back to JPEG and paying the decode. §1 step 7 asks for the number.
- **The model can now see a screen, and no model has ever decided to** (PR-030).
  This is the gap PR-030 opens rather than closes. The path is real end to end —
  tool, §10 policy, image pipeline, frame ring, tool result, provider inbox — but
  the two facts that make point-and-ask work are untested by construction:
  whether a model calls `observe_screen` when answering needs the screen, and
  whether it can *read* the resulting image well enough to answer about small UI
  text. Both need a signed-in model (§2) and a real window (§1 step 8), and
  neither exists here. If the first turns out to be unreliable, the lever is the
  tool description and the system prompt (`packages/agent/src/system-prompt.ts`,
  `observe-screen.ts`), both of which are one string; if the second is, the
  levers are the encoding decisions PR-018 recorded, and PR-043's grounding
  checklist is where the evidence comes from.
- **One rate limiter now serves two callers** (PR-030). §10 allows 2
  observations a second and the model and the user share the budget, because
  they share the facade. Nobody has yet seen a real conversation where the model
  looks two or three times in one turn — the faux provider looks exactly when it
  is scripted to — so whether the limit is *right* for a real model is unknown.
  A model that looks three times in a second sees the third refused as
  `policy-rejected` and is told, in the tool's own words, to answer from the
  observations it already has. That is the designed behaviour; whether it is the
  useful one is a PR-043 question. It is one field in
  `MVP_SCREEN_CONTEXT_POLICY`.
- **Nothing has ever spoken to a real provider** (PR-029). The whole agent path
  now runs — capability gate, envelope, `Agent.prompt`, streamed deltas, tool
  calls, abort — but always against Pi's faux provider, which is a cooperative,
  local, instant, perfectly-formed correspondent. The first real session is
  where provider latency, partial failures, rate limits, refusals and
  abort-mid-sentence behaviour appear for the first time, and PR-029's tests
  cannot say anything about any of them. §2 lists what to watch for.
- **The main bundle now contains Pi** (PR-029). `apps/desktop` depends on
  `@pilot/agent`, so `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`
  are inlined into `dist/main/index.js` (~1.1 MB, up from ~90 KB). Two knock-on
  facts worth knowing: the packaged asar still ships no `node_modules`, and the
  bundle now imports the unprefixed built-ins `process` and `buffer`, which the
  development-build test had to be widened to allow. Nothing renderer-side
  changed — no Pi type reaches Chromium, and it must stay that way.

- **Effort calibration** — `docs/implementation.md` PR size bands sum to
  roughly 2–3× the estimate in `dp/m1.md`. Treat any date derived from them
  with suspicion until several PRs have calibrated actual velocity.
