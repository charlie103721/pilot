# Pilot MVP 01 — Handoff and open items

Status: Live document
Last updated: 2026-08-11

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

# The packaged helper's path depends on your Mac's architecture, so resolve it
# once rather than hardcoding mac-arm64 (an Intel Mac produces mac-x64):
packaged_app()    { find apps/desktop/release -maxdepth 2 -name 'Pilot.app' | head -1; }
packaged_helper() { echo "$(packaged_app)/Contents/Resources/helper/PilotHelper"; }

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

PILOT_HELPER_BINARY="$(packaged_helper)" \
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
PILOT_HELPER_BINARY="$(packaged_helper)" \
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

PILOT_HELPER_BINARY="$(packaged_helper)" \
  pnpm --filter @pilot/platform-mac demo:capture

# 9. PR-015 — the global push-to-talk hotkey. THIS ONE PROMPTS TOO
#    (Accessibility, and possibly Input Monitoring — see below).
#    Section 1 of this demo is the *only* place anything in Pilot has ever
#    tried to observe a key press.
pnpm --filter @pilot/platform-mac demo:hotkey

#    Then the same thing from inside the packaged .app, which is the only
#    layout where TCC can plausibly attribute the tap to Pilot rather than to
#    a loose executable:
PILOT_HELPER_BINARY="$(packaged_helper)" \
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
open "$(packaged_app)"

# 11. PR-030 — the MODEL looking at a real window. Run it after step 10: it is
#    step 10's path plus the agent, so a failure here that step 10 did not show is
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

# 11b. PR-031 — POINT AND ASK. This is the one the product exists for, and it is
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

# 12. PR-032 — PUSH-TO-TALK, FOR REAL. THIS ONE PROMPTS (Accessibility for the
#    tap, Microphone and Speech Recognition for the recogniser), OPENS THE
#    MICROPHONE AND LISTENS TO YOU. Run it after steps 5, 7 and 9.
#
#    NOTHING IN THIS PROJECT HAS EVER PRESSED A KEY OR RECORDED A SECOND OF
#    AUDIO. This step is the first.
#
#    First the stub-driven walkthrough, which already passes on Linux — so a
#    difference on the Mac is a difference in the *platform*, not in the wiring:
pnpm demo:talk

#    Then the real thing, and the instruction matters: put ANOTHER APPLICATION
#    IN FRONT — a browser, Notes, anything — before you touch the key. A
#    shortcut that only works while Pilot has focus is not push-to-talk.
#    Pick a window in Pilot's panel first, then click away, then HOLD RIGHT
#    OPTION, speak a question about that window, and let go.
PILOT_HELPER_BINARY="$(pwd)/packages/platform-mac/native/.build/debug/PilotHelper" \
  PILOT_LOG_LEVEL=debug pnpm dev

#    …and then from inside the packaged .app, which is the only layout where TCC
#    can plausibly attribute Accessibility and the Microphone to Pilot:
open "$(packaged_app)"

# 13. PR-033 — THE SPOKEN ANSWER. This one MAKES NOISE. It raises no new TCC
#    prompt of its own — synthesis needs no permission — so it can be run right
#    after step 1 if you only want to know whether this Mac speaks at all.
#    TURN THE VOLUME UP: most of what is being checked is audible, not printed.
#
#    NOTHING IN THIS PROJECT HAS EVER BEEN SPOKEN ALOUD. This step is the first.
#
#    First the stub-driven walkthrough, which already passes on Linux — so a
#    difference on the Mac is a difference in the *platform*, not in the wiring:
pnpm demo:speak

#    Then PR-014's own speech demo, whose section 9 speaks two chunks and
#    interrupts them. It is the smallest thing here that can make a sound, so if
#    the app is silent, run this to find out which half is quiet:
pnpm --filter @pilot/platform-mac demo:speech

#    Then the real thing. Pick a window, ask a question — typed or held — and
#    LISTEN while you watch the panel: the text and the voice are two renderings
#    of the same answer and they must agree.
PILOT_HELPER_BINARY="$(pwd)/packages/platform-mac/native/.build/debug/PilotHelper" \
  PILOT_LOG_LEVEL=debug pnpm dev

#    …and from inside the packaged `.app`, which is the layout that ships:
open "$(packaged_app)"

# 14. PR-034 — THE WHOLE THING, AS ONE TRACE. This is the MVP scenario
#    (docs/mvp-01-point-ask-hear.md §2) and it is the run the product exists
#    for. It PROMPTS (Screen Recording, Accessibility, Microphone and Speech
#    Recognition), OPENS THE MICROPHONE and MAKES NOISE. Run it LAST, after
#    steps 5, 7, 8, 9, 12 and 13, so that every prompt has already been
#    answered and a failure here is a failure of the *flow* rather than of a
#    grant.
#
#    First the stub-driven walkthrough, which already passes on Linux — so a
#    difference on the Mac is a difference in the *platform*, not in the wiring:
pnpm demo:flow

#    Then the real thing, and the instructions matter, because this is the only
#    step where all six pieces are on trial at once:
#      - put ANOTHER APPLICATION IN FRONT before you touch the key;
#      - PUT THE POINTER ON A SPECIFIC CONTROL inside the selected window — a
#        button, a toggle, a labelled field — and leave it there;
#      - HOLD RIGHT OPTION, ask "what is this?", and let go;
#      - watch the panel and LISTEN at the same time.
#    Four things have to be true together: the transcript is what you said, the
#    answer is about the control you were pointing at (not the window in
#    general), the text and the voice agree, and the first word is spoken before
#    the last word is written.
PILOT_HELPER_BINARY="$(pwd)/packages/platform-mac/native/.build/debug/PilotHelper" \
  PILOT_LOG_LEVEL=debug pnpm dev

#    Then, in the same session and without restarting: ask a FOLLOW-UP that does
#    not need the screen ("can I turn that off?"), and then INTERRUPT an answer
#    mid-sentence by holding the key again. The sound must stop before you have
#    finished the first word of the new question, and the abandoned answer must
#    never resume.
#
#    …and finally from inside the packaged `.app`, which is the only layout
#    where TCC can plausibly attribute any of it to Pilot:
open "$(packaged_app)"

# 15. PR-035 — INTERRUPTION, WHERE IT IS HARD. This one MAKES NOISE and raises
#    no new TCC prompt. Run it after step 14, in the same session if you can.
#    Everything Pilot does here is verified on Linux; the ONE thing that is not
#    is the thing that matters: whether the SOUND stops.
#
#    First the stub-driven walkthrough, which already passes on Linux:
pnpm demo:interrupt-flow

#    Then the real thing, with the volume up. Four presses, in this order:
PILOT_HELPER_BINARY="$(pwd)/packages/platform-mac/native/.build/debug/PilotHelper" \
  PILOT_LOG_LEVEL=debug pnpm dev

#      (a) ask something that makes it LOOK, and hold the key again WHILE the
#          panel is showing it looking — before the answer starts. Then ask a
#          different question. This is the case PR-035 decided (follow-up 14);
#          what must NOT happen is the error "Pilot is still working on the
#          previous question", and what must happen is that the second question
#          is answered.
#      (b) interrupt a spoken answer mid-sentence. TIME IT BY EAR: the voice
#          must stop before you have finished the first word of the new
#          question. §17 budgets 300 ms and Linux measures ~1 ms of Pilot's own
#          half; the rest is AVSpeechSynthesizer and the audio device, and this
#          is the only place that part has ever been exercised.
#      (c) interrupt twice in quick succession — press, speak, release, and
#          interrupt that answer too. Only the last answer may be spoken to the
#          end, and no abandoned answer may resume.
#      (d) interrupt in the moment between the answer appearing on screen and
#          the first word being spoken. It is a narrow window on a Mac; if you
#          cannot hit it, say so and it stays a Linux-only result.
#
#    …and from inside the packaged `.app`:
open "$(packaged_app)"

# 16. PR-036 — MEMORY THAT SURVIVES A QUIT. This one writes a FILE, which is the
#    first thing in this project that outlives the process. It raises no new TCC
#    prompt and makes no sound; run it after step 14 if you want it grounded in
#    real screens, or on its own if you only want to know whether the file
#    behaves.
#
#    First the stub-driven walkthrough, which already passes on Linux — nine
#    screen questions across two scene changes, a relaunch and a clear:
pnpm demo:memory

#    Then the real thing, and there are four questions only this Mac can answer.
PILOT_HELPER_BINARY="$(pwd)/packages/platform-mac/native/.build/debug/PilotHelper" \
  PILOT_LOG_LEVEL=debug pnpm dev

#      (a) WHERE THE FILE IS, and that it is the one you think. On the dev run
#          the `durable conversation opened` line at startup prints the
#          directory; from a packaged .app it is under
#          ~/Library/Application Support/Pilot/conversations/sessions.db. Ask
#          three or four screen questions, quit from the menu bar item, and
#          check the file grew:
ls -l ~/Library/Application\ Support/Pilot/conversations/

#      (b) IT COMES BACK. Relaunch and ask "what did I ask you first?" — the
#          answer must be about the first question of the PREVIOUS run. The
#          startup line says `restored: <n>` and `durable: true`; `restored: 0`
#          after a real conversation means the transcript is on disk and
#          invisible to the model, which is the failure runbook follow-up 20 (b)
#          is about.
#
#      (c) RELAUNCH INSIDE 30 SECONDS, TWICE, IN TWO DIFFERENT WAYS. This is the
#          one that cannot be checked on Linux, because it is about how macOS
#          ends a process.
#            - Quit cleanly (menu bar → Quit) and relaunch at once. It must open
#              normally: `before-quit` released the lease.
#            - Now KILL it (`killall -9 Pilot`) and relaunch within 30 s. The
#              panel must show "Pilot is already open in another window. Close
#              it, or wait up to 30 seconds if it stopped unexpectedly." beside
#              a LIVE text box — Pilot still answers, it just will not remember.
#              Wait 30 s, relaunch again, and it must open normally and still
#              have the old conversation. **Do not delete the database.** If
#              deleting it is the only thing that helps, that is a defect worth
#              reporting, not a workaround.
#
#      (d) THE SINGLE-INSTANCE LOCK. With Pilot running, launch it again
#          (`open -n "$(packaged_app)"`). The second launch must exit and the
#          first must reveal its panel — one menu bar item, not two. That is
#          `app.requestSingleInstanceLock()`; the lease in (c) is the second
#          line of defence behind it and answers a different question.
#
#      (e) CLEAR CONVERSATION really clears. Ask something memorable, press
#          Clear in the panel, quit, and grep the file for it:
grep -a "the memorable thing you asked" \
  ~/Library/Application\ Support/Pilot/conversations/sessions.db || echo "gone"

#      (f) THE CONTEXT WINDOW, once there is a real provider (step after
#          PR-037/PR-039). The startup line prints e.g.
#          `contextWindow: 32768 tokens (local-ceiling; local endpoint
#          advertised 128000)`. For a HOSTED model it must read `model` and the
#          provider's real number; for a LOCAL endpoint it is capped at 32 768
#          on purpose — `PILOT_CONTEXT_WINDOW=65536 pnpm dev` raises it if your
#          endpoint really handles more. Nothing here measures what it handles;
#          say what your endpoint does and the ceiling can move.

#    …and from inside the packaged `.app`, which is the layout the paths in (a)
#    and (e) are written for:
open "$(packaged_app)"

# 17. PR-039 — A REAL LOCAL MODEL. This is the first step in the whole project
#    that talks to an actual language model, and it needs no Mac and no Swift
#    helper: it can be run on any machine that can serve a model. It raises no
#    TCC prompt and makes no sound. If you only do one thing from this section,
#    it is a strong candidate, because it unblocks the model half of every
#    "NOT REAL: no model" caveat in steps 10–16.
#
#    NOTHING IN THIS PROJECT HAS EVER SPOKEN TO AN INFERENCE SERVER. Every
#    provider request Pilot has ever made went either to Pi's faux provider or
#    to a stub HTTP server written for PR-039 that contains no model at all.
#
#    First the stub-driven walkthrough, which already passes on Linux — so a
#    difference against your server is a difference in the *server*, not in the
#    wiring:
pnpm demo:local

#    Then a real one. Any OpenAI-compatible server will do; these are the three
#    the code was written against on paper (docs/pi-notes.md §9.3):
#      Ollama     — `ollama serve`, then `ollama pull qwen2.5vl:7b`   → :11434/v1
#      llama.cpp  — `llama-server -m <model.gguf> --mmproj <mmproj.gguf> -c 32768`
#                                                                     → :8080/v1
#      LM Studio  — start the local server from the Developer tab      → :1234/v1
#
#    Check the shim answers before involving Pilot at all:
curl -s http://127.0.0.1:11434/v1/models | head -c 400; echo

#    Then run Pilot against it. PILOT_LOCAL_MODEL is optional — leave it out and
#    Pilot uses whatever the endpoint is serving:
PILOT_LOCAL_BASE_URL=http://127.0.0.1:11434/v1 \
  PILOT_LOCAL_MODEL=qwen2.5vl:7b \
  PILOT_LOG_LEVEL=debug pnpm dev

#    …and, on the Mac, the same thing with the real helper so the model is
#    looking at a real window rather than at a fixture:
PILOT_LOCAL_BASE_URL=http://127.0.0.1:11434/v1 \
  PILOT_HELPER_BINARY="$(pwd)/packages/platform-mac/native/.build/debug/PilotHelper" \
  PILOT_LOG_LEVEL=debug pnpm dev

#    …and from inside the packaged `.app`, which cannot read your shell, so the
#    variables have to be exported into the launch:
PILOT_LOCAL_BASE_URL=http://127.0.0.1:11434/v1 open -a "$(packaged_app)" --args
#
#    SEVEN THINGS ONLY YOU CAN ANSWER, in order of value:
#
#      (a) WHICH SERVER, WHICH MODEL, WHICH VERSION. Record them. Everything
#          below is about one server and does not generalise; the wire shapes
#          Pilot depends on (SSE `choices[].delta`, `tool_calls` deltas,
#          `image_url` data URIs) are conventions, not a specification, and
#          nothing in this repository has ever seen a real one.
#
#      (b) DOES THE CAPABILITY PROBE AGREE WITH REALITY? The startup log prints
#          `vision probed ok`/`no` and `tools probed ok`/`no`. Both can be
#          wrong in both directions and both matter:
#           · The vision probe shows the model an 8×8 solid swatch and asks it
#             to name the colour from a list of six. A model that cannot see
#             and guesses is right ONE TIME IN SIX, so a `probed ok` you do not
#             believe is worth re-running. Report a FALSE PASS if you see one.
#           · A genuinely vision-capable model that is simply bad at naming
#             colours will be refused. That is a FALSE FAIL and it is the more
#             likely of the two. `PILOT_LOCAL_VISION_COMPREHENSION=0` accepts
#             the model's claim instead (it then only checks the endpoint does
#             not reject the image). If you need that flag, say so — the probe
#             should probably become "two swatches" or "a shape", and a real
#             model is the only way to know.
#           · The tool probe tells the model to call a no-argument tool and
#             looks for `tool_calls`. Small local models frequently advertise
#             tool support and never emit a call; if yours is refused here,
#             that is the probe working, not failing.
#
#      (c) DOES IT ACTUALLY ANSWER ABOUT THE SCREEN? Select a window, put the
#          pointer on a control, and ask "what is this?". The failure this
#          whole PR is built around is SILENT: `pi-ai` says images passed to a
#          non-vision model are ignored, not rejected, so a wrong-but-confident
#          answer is the symptom. Ask something only the screen can answer.
#
#      (d) ADVERTISED VERSUS ACTUAL CONTEXT WINDOW — the open question from
#          PR-036, and the reason this step exists at all. The startup line
#          reads e.g. `contextWindow: 8192 tokens (model; local endpoint
#          advertised 8192)` or `32768 tokens (local-ceiling; local endpoint
#          advertised 131072)`. Record THREE numbers:
#            1. what `curl -s <base>/models` reports (`meta.n_ctx`,
#               `loaded_context_length`, or nothing at all — say which);
#            2. what your server was actually started with (`-c`, `num_ctx`,
#               `OLLAMA_CONTEXT_LENGTH`);
#            3. where the answers START GETTING WORSE. Ask twenty-odd questions
#               in one conversation and note the turn at which it loses the
#               thread.
#          Number 3 is the one nothing in this repository can measure, and it
#          is the number the 32 768 ceiling is a guess at. If your 7B model
#          holds up at 32k, say so and the ceiling can rise; if it degrades at
#          8k, say that and it should fall.
#
#      (e) DOES THE KEYLESS PATH WORK? Pilot sends `Authorization: Bearer
#          no-key-required` when you set no key, because Pi's own
#          `openai-completions` client refuses to build a request without one.
#          Every server tried on paper ignores it. If yours 401s, that is a
#          defect worth reporting and the fix is one line.
#
#      (f) THE FAILURE MESSAGES, AGAINST A REAL SERVER. Each of these should
#          produce a sentence you can act on rather than a stack trace. Try at
#          least the first two — they are one keystroke each:
#            - stop the server and relaunch Pilot   → "Nothing is listening at …"
#            - drop the `/v1` from the base URL     → "Most local servers put …"
#            - point it at a plain web server       → "not an OpenAI-compatible …"
#            - name a model the server is not serving → it should list the ones
#              it IS serving, read off `/v1/models`
#          If any of them produces something technical instead, send the log
#          line: the message is the deliverable here, not the detection.
#
#      (g) LATENCY. `pnpm demo:local` prints the probe's round trip against a
#          stub on the same machine (single-digit ms). Against a real server
#          the probe is three requests, one of which loads the model, and it
#          runs at STARTUP — before the panel appears. If it makes launch feel
#          slow, say how slow; the probe can move behind the first question.
# 18. PR-040 — THE FAILURE MATRIX. This is the one step where the *point* is
#    that things go wrong. Nothing here is destructive, nothing is deleted, and
#    every case is meant to end with Pilot either carrying on or stopping with a
#    sentence on screen. Run it after step 10 (the observation path) — every one
#    of these is about losing something Pilot only has once that works.
#
#    First the stub-driven walkthrough, which already passes on Linux. It runs
#    fourteen cases and prints, per case, what failed, what the user sees,
#    whether it recovered or stopped safely, and what was left behind:
pnpm demo:failure

#    Then the real thing. Six of the fourteen are simulated here and can only be
#    answered on a Mac; each is a minute of work and each answers a different question.
PILOT_HELPER_BINARY="$(pwd)/packages/platform-mac/native/.build/debug/PilotHelper" \
  PILOT_LOG_LEVEL=debug pnpm dev

#      (a) REALLY REVOKE A PERMISSION, MID-SESSION. Pick a window, let Pilot
#          watch it, then open System Settings → Privacy & Security → Screen
#          Recording and turn Pilot OFF while it is watching. Four things must
#          happen, and the fourth is the one nothing has ever verified:
#            - the panel moves to the permission onboarding, not to an error;
#            - the picker shows "Pilot stopped watching … Allow it again above";
#            - the log line `retention clear` reads `event: permission-loss`
#              (before this PR it read whatever occasion happened to be armed
#              last, which is what an audit of §13 would have been reading);
#            - **macOS may kill the helper rather than merely answer `denied`.**
#              If Screen Recording is withdrawn from a *running* capture, the
#              documented behaviour is a stream that stops; what actually
#              happens to the helper process, and whether Pilot reports a
#              permission loss or a helper crash, is unknown. Either is a safe
#              ending; which one it is decides whether the sentence the user
#              reads is the right one. Send the two log lines around it.
#          Then turn it back ON. Pilot must return to `idle` with the window
#          still selected — press Start and it watches again, with no relaunch.
#          Repeat the whole thing for Accessibility, and see the note below.
#
#      (b) REALLY LOCK THE SCREEN. Ctrl-Cmd-Q with Pilot watching, wait ten
#          seconds, unlock. Watching must resume by itself, and the log must
#          show `retention clear` with `event: screen-lock` and
#          `lineageReset: false`. **Two signals race here on a real Mac** —
#          Electron's `powerMonitor` (new in this PR, and immediate) and the
#          helper's own window-list poll. The table rejects the second as
#          `illegal-transition`; what must NOT happen is two clears or a Pilot
#          that stays paused after unlocking.
#
#      (c) REALLY LOG OUT. Apple menu → Log Out, with Pilot watching, then log
#          back in and start Pilot. This is the only occasion Pilot has no other
#          signal for, and it is terminal: `event: logout`, `lineageReset: true`.
#          The question only a Mac answers is whether `powerMonitor`'s
#          `shutdown` event fires at all before the process is killed — if the
#          log has no `retention clear` for it, say so, because the fallback
#          (the `before-quit` shutdown clear) is the same clear under a
#          different name and the difference is the scene lineage.
#
#      (d) REALLY KILL THE HELPER. With Pilot watching, find and kill it:
killall -9 PilotHelper
#          Pilot must NOT quit. Within a second or two the picker shows "Pilot
#          lost its macOS helper", the log shows the crash and then a restart,
#          and watching resumes on the same window. Two things to check that
#          only exist on a Mac: that the *restarted* helper is still credited
#          with the TCC grants (the `permission attribution` line after the
#          restart must read the same verdict as the one before it — this PR
#          re-probes it precisely because the cached one belonged to a dead
#          process), and that killing it five times in a minute ends in the
#          terminal state — "Quit Pilot and open it again" — rather than in a
#          restart loop.
#
#      (e) A REALLY PROTECTED WINDOW. Open something that blocks capture — a
#          DRM video in Safari or the Apple TV app is the easy one, and the
#          password sheet of a locked 1Password/Keychain window is the other —
#          select it, and ask a question. Pilot must say "This application does
#          not allow Pilot to see its window", switch watching off, and **never
#          show a black rectangle as if it were the screen.** If it answers with
#          a description of a black frame, that is the defect this case exists
#          to catch, and it is a PR-012 defect in `CaptureEngine.swift`.
#
#      (f) A WINDOW THAT CLOSES WHILE PILOT IS LOOKING. Ask a question that
#          makes the model look, and ⌘W the window during the pause before the
#          answer. The answer must be about the window closing, never a
#          description of a window that is gone.
#
#    Two more that need no Mac but need a *provider*, so they wait on §2:
#      (g) let a Codex/API session expire and ask a question. The sentence must
#          be "Pilot is signed out of the model provider", the transcript must
#          survive, and signing back in must need no relaunch (§16).
#      (h) pull the network out mid-answer. Pilot must stop and say so, and must
#          NOT resend the question by itself — the retry it refuses to make is
#          the one that would answer about a screen you have moved past.
#    (Step 19 is not missing — it is the Codex sign-in, and it lives in §2
#    because it needs an account rather than this Mac.)

# 20. PR-038 — A REAL API KEY AGAINST A REAL PROVIDER, AND THE KEYCHAIN. This
#    would be the first time anything in this project holds a credential, and
#    the first time a screen image leaves the machine. It raises no TCC prompt
#    of its own but it MAY raise a Keychain prompt, and it COSTS MONEY.
#
#    NOTHING IN THIS PROJECT HAS EVER HELD AN API KEY, TALKED TO A PROVIDER, OR
#    TOUCHED THE macOS KEYCHAIN. This step is the first.
#
#    First the recorded walkthrough, which already passes on Linux — provider
#    and model selection, a sealed credential file, a capability probe that
#    refuses two models, invalid-key recovery, the remote-data banner, and one
#    screen question answered end to end:
pnpm demo:apikey

#    (a) THE KEYCHAIN. `pnpm demo:apikey` uses AES-256-GCM over a key it
#        generates and throws away; the app uses Electron `safeStorage`, which
#        is the login Keychain. Run the app with a key and watch three things:
#        whether macOS prompts, whether the file is sealed, and whether it
#        comes back on the second launch WITHOUT the environment variable. The
#        recorded vendor accepts whatever key it is given, so this half needs
#        no real provider and costs nothing:
PILOT_MODEL_PROFILE=api-key \
  PILOT_API_PROVIDER=recorded-vendor \
  PILOT_API_KEY=anything-you-like \
  PILOT_LOG_LEVEL=debug pnpm dev

#        The startup log line `api-key profile` says `state`, `cipher` and
#        `secureStorage`. `secureStorage: false` means safeStorage refused, and
#        Pilot then stores NOTHING rather than falling back to plaintext — say
#        so if you see it, because on a Mac it should be true.
#        Then look at the file, and grep it for your key. Expect nothing:
ls -l ~/Library/Application\ Support/Pilot/model-profile/
grep -a "anything-you-like" \
  ~/Library/Application\ Support/Pilot/model-profile/credentials.json || echo "gone"

#        Then relaunch WITHOUT PILOT_API_KEY. It must still be configured, and
#        the log must read `state: verified`:
PILOT_MODEL_PROFILE=api-key PILOT_API_PROVIDER=recorded-vendor pnpm dev

#    (b) A REAL VENDOR. This build registers NO vendor SDK. Measured: calling
#        `loadBuiltinApiKeyProviders()` from `main/api-key-runtime.ts` took
#        `dist/main/index.js` from 1.66 MB to 5.97 MB, so which vendors ship is
#        a packaging decision left to PR-042. To try a real one before then,
#        register it at the call site in `apps/desktop/src/main/index.ts`:
#
#          import { loadBuiltinApiKeyProviders } from '@pilot/agent';
#          const apiKeyProfile = await openApiKeyProfileRuntime({
#            userDataPath: app.getPath('userData'),
#            cipher: createSafeStorageCipher(),
#            providers: await loadBuiltinApiKeyProviders(),
#            logger,
#          });
#
#        then, with a key you are willing to spend (`docs/pi-notes.md` §9.2
#        recommends Anthropic — it is the cheapest thing to verify):
PILOT_MODEL_PROFILE=api-key \
  PILOT_API_PROVIDER=anthropic \
  PILOT_API_KEY=sk-ant-... \
  PILOT_LOG_LEVEL=debug pnpm dev

#        Four things only a real provider can answer, in decreasing order of
#        what they would cost if wrong:
#          - DOES THE CAPABILITY PROBE PASS? It makes ONE text-only request
#            offering a tool named `pilot_capability_probe` and expects a tool
#            call back. A real model may answer in prose instead ("Certainly, I
#            will call the tool"), which Pilot reads as "cannot call tools" and
#            refuses the model. If a model you know calls tools is refused at
#            the `tools` stage, that is a defect in the probe prompt, not in
#            the model. Send the `tools:` and `gate:` evidence lines.
#          - DOES A WRONG KEY LOOK LIKE A WRONG KEY? Run it once with a
#            deliberately mangled key. The panel must say "This model provider
#            rejected your API key", not "Your model provider could not
#            answer". If it says the latter, the vendor's 401 body does not
#            match `INVALID_KEY_PATTERNS` in
#            `packages/agent/src/api-key-probe.ts` — send the log line (it is
#            already scrubbed) and the list gets a new case.
#          - IS THE KEY REALLY ABSENT FROM THE ERROR? Some vendors echo the key
#            back in the 401 body. Grep the stderr log for it. Expect nothing.
#          - DOES `contextWindow` READ `model`? The startup line must say
#            `contextWindow: <the vendor's number> (model; remote endpoint
#            advertised <the same number>)`. `local-ceiling` on a hosted
#            provider would mean the endpoint was misread as loopback.

#    (c) THE BANNER. Before asking anything, look at the top of the panel. It
#        must name the vendor's host, say the screen is sent there, and say
#        `verified` only after the probe passed. Take a screenshot: it is the
#        one privacy claim a user reads before they consent.

#    …and from inside the packaged `.app`, which is the only layout where
#    safeStorage's Keychain item is created under Pilot's own identity:
open "$(packaged_app)"

# 21. PR-041 — THE MANUAL DISK INSPECTION. This is the half of the privacy
#    audit that no machine without a Mac can run. `pnpm demo:privacy` checks
#    twenty claims against artefacts, and its own section 10 lists the seven it
#    cannot reach; these commands are that list, made runnable. It raises no TCC
#    prompt, makes no sound, deletes nothing and costs nothing.
#
#    NOTHING IN THIS PROJECT HAS EVER WRITTEN A FILE UNDER
#    ~/Library/Application Support/Pilot. Every path the audit inspected was a
#    temporary directory. This step is the first time the real ones exist.
#
#    First the automated audit, which already passes on Linux. Run `pnpm build`
#    first so it inspects the built bundle too; without it that one check
#    reports UNPROVABLE rather than passing:
pnpm build && pnpm demo:privacy

#    Then the real thing. DO A REAL SESSION FIRST — steps 14 and 16 if you have
#    not already — so there is something to find. Ask three or four screen
#    questions, say something memorable out loud, quit from the menu bar item,
#    and then work through (a) to (g). What a BAD answer looks like is written
#    beside each one.
#
#      (a) WHAT PILOT ACTUALLY CREATED, AND HOW BIG IT IS.
ls -laR ~/Library/Application\ Support/Pilot/
du -sh  ~/Library/Application\ Support/Pilot/*
#          EXPECT: `conversations/sessions.db` (plus `-wal`/`-shm`), and
#          `credentials/model-credentials.json` only if you signed in or set a
#          key. BAD: anything that looks like a frame store — a `frames/`,
#          `captures/`, `cache/` or `Crashpad/` directory — or a database that
#          is megabytes per conversation rather than kilobytes. A few hundred
#          kilobytes of text is right; 50 MB is a picture.
#
#      (b) NO IMAGE AND NO AUDIO IN THE DATABASE. These are the scanners
#          `pnpm demo:privacy` runs, by hand, against the real file:
cd ~/Library/Application\ Support/Pilot
grep -ac $'\x89PNG'     conversations/sessions.db* || echo "no PNG"
grep -ac $'\xff\xd8\xff' conversations/sessions.db* || echo "no JPEG"
grep -ac 'data:image'   conversations/sessions.db* || echo "no data: URI"
grep -ac 'RIFF'         conversations/sessions.db* || echo "no WAVE"
grep -ac 'caff'         conversations/sessions.db* || echo "no Core Audio"
grep -aoE '[A-Za-z0-9+/]{120,}={0,2}' conversations/sessions.db* | head
#          EXPECT: each of the five prints its "no …" message, and the last
#          command prints nothing at all. BAD: any hit. Send the offset and the
#          surrounding 200 bytes; it is a PR-023 defect in `ConversationStore`,
#          the single choke point every durable write passes through.
#
#      (c) THE SAME THING WHILE IT IS STILL RUNNING. (b) reads the file after a
#          quit; a write-ahead log is a different artefact from a closed
#          database. Launch Pilot, ask two screen questions, leave it running,
#          and run the six commands in (b) again from another terminal.
#          EXPECT: the same answers. BAD: a hit that (b) does not show — that
#          is images reaching the WAL and being removed later, which is a leak
#          with a window rather than no leak.
#
#      (d) YOUR OWN WORDS ARE THERE, AND ONLY YOUR WORDS. §13 persists the
#          transcript on purpose, so this is what proves (b) read a file with
#          content in it rather than an empty one:
grep -ac "a phrase you actually said" conversations/sessions.db
#          EXPECT: a non-zero count. BAD: zero — then (b) proved nothing, and
#          either the transcript is not persisting (runbook follow-up 20 (b))
#          or this is the wrong file.
#
#      (e) THE CREDENTIAL, IF YOU HAVE ONE. Only after step 19 or step 20.
ls -l@ credentials/model-credentials.json
grep -ac "the token or key you used" credentials/model-credentials.json || echo "sealed"
python3 -c "import json;print('protected:',json.load(open('credentials/model-credentials.json'))['protected'])"
#          EXPECT: mode `-rw-------` (600) inside a `drwx------` (700)
#          directory, `sealed`, and `protected: true`. BAD: `protected: false`
#          on a Mac — Electron `safeStorage` refused and the token is in
#          plaintext, which is the one case that must not ship. Say so: it is a
#          PR-042 blocker, not a note.
#
#      (f) WHAT THE REST OF THE MAC KEPT. Pilot controls none of these and the
#          audit cannot see any of them, which is exactly why they are here:
ls -la ~/Library/Saved\ Application\ State/ | grep -i pilot || echo "no saved state"
ls -la ~/Library/Application\ Support/CrashReporter/ | grep -iE 'pilot|helper' || echo "no crash reports"
ls -la ~/Library/Logs/ | grep -i pilot || echo "no logs directory"
mdfind -onlyin ~ "Pilot" | head -20
log show --predicate 'process == "Pilot" OR process == "PilotHelper"' --last 30m --info | grep -aE 'data:image|[A-Za-z0-9+/]{120,}' | head
#          EXPECT: the first three print their "no …" message; `mdfind` finds
#          the app and the database and nothing that looks like a picture; the
#          `log show` grep prints nothing. BAD: a base64 run or a `data:` URI in
#          the unified log — that is §13's "never logged" broken through stdout
#          rather than through a file, and it is invisible to every check the
#          audit runs. Send the line.
#
#      (g) A CLEAR REALLY CLEARS, AND A LOGOUT NAMES ITSELF. This is the half
#          of §13 only a real Mac can answer (runbook follow-up 37):
#            · with Pilot watching, press Clear in the panel, quit, and run (b)
#              and (d) again. (d) must now print zero.
#            · relaunch, ask one question, and LOG OUT of macOS (Apple menu →
#              Log Out) rather than quitting. Log back in, start Pilot with
#              PILOT_LOG_LEVEL=debug, and look for the last `retention clear`:
PILOT_LOG_LEVEL=debug pnpm dev 2>&1 | grep -a "retention clear"
#          EXPECT: `event: logout` with `lineageReset: true`. ACCEPTABLE:
#          `event: shutdown` — the fallback clear, which retains nothing either
#          but loses the distinction. BAD: no `retention clear` at all before
#          the process died, or one named `pause`/`observation-disabled` after
#          a logout, which is PR-041's own defect returning.
#
#    …and all of it again from inside the packaged `.app`, which is the only
#    layout where the paths above are the ones a user would actually have:
open "$(packaged_app)"

# 22. PR-042 — THE PACKAGED APPLICATION, SIGNED, INSTALLED, AND STARTED FROM
#    FINDER. This is the step the whole macOS lane has been deferring to, and it
#    is the only one where the answer to "who does macOS think is asking for the
#    screen" can be obtained. It PROMPTS FOR EVERYTHING, because a freshly
#    signed bundle is a TCC subject that has never existed before.
#
#    NOTHING IN THIS PROJECT HAS EVER BEEN CODE-SIGNED. `codesign` has never
#    run, no `.app` has ever been produced, no hardened-runtime process has ever
#    started, and the entitlements files have never been applied to anything.
#    Every line under `mac:` in `apps/desktop/electron-builder.yml` is reasoning
#    that survived review, not a measurement.
#
#    (a) BUILD IT, WITH THE REAL HELPER. Steps 1 and 3 are the prerequisites.
pnpm --filter @pilot/desktop run build:helper -- --require-native
pnpm package

#        `pnpm package` now also runs the configuration check, which prints
#        under a `CONFIGURED, NOT VERIFIED` heading. On the Mac the bundle check
#        gains lines it cannot print here — the Info.plist keys, the helper
#        location inside the .app, and the code signature:
pnpm --filter @pilot/desktop exec node scripts/verify-bundle.js
#        EXPECT: `helper: native, … Info.plist embedded`, a `macOS bundle:
#        works.pilot.desktop, signature: …` line, and NO `NOT CHECKED` notes
#        about the Info.plist or the signature. BAD: `helper: PLACEHOLDER` (you
#        skipped `--require-native`), or a signature line reading `NOT SIGNED`.
#
#        IF `swift build` FAILS AND THE ERROR MENTIONS THE LINKER OR
#        `-sectcreate`: that is PR-042's own addition, not the Swift package.
#        Back it out and say so — those flags are the only thing this repository
#        adds beyond a bare `swift build`:
pnpm --filter @pilot/desktop run build:helper -- --require-native --no-embed-info-plist

#    (b) WHAT THE SIGNATURE ACTUALLY SEALED. The entitlements take effect only
#        if `--options runtime` was honoured and the plist was really applied;
#        an entitlements file that is accepted and then ignored is this
#        project's favourite failure shape.
codesign --display --verbose=4 "$(packaged_app)"
codesign --display --entitlements - "$(packaged_app)"
codesign --display --entitlements - "$(packaged_helper)"
codesign --verify --verbose=2 "$(packaged_app)"
#        EXPECT: `Signature=adhoc`, `flags=0x10000(runtime)` on both, the app's
#        three entitlements (`allow-jit`, `allow-unsigned-executable-memory`,
#        `device.audio-input`) and the helper's ONE (`device.audio-input`).
#        BAD: the helper carrying `allow-jit` — that means something signed it
#        with the app's entitlements, most likely a stray `--deep`. Also BAD:
#        `code object is not signed at all` for the helper, which means the
#        `afterPack` hook did not run.
#
#    (c) THE HELPER'S OWN Info.plist. Only this tells you whether the insurance
#        described in (a) is really in the binary:
otool -P "$(packaged_helper)" | head -40
#        EXPECT: the XML from `apps/desktop/build/PilotHelper-Info.plist`, with
#        `works.pilot.desktop.helper` and both usage strings. BAD: no output —
#        then the section is not there, and a TCC misattribution will terminate
#        the helper rather than deny it.
#
#    (d) INSTALL IT. See "1a. Clean-machine installation" below for the whole
#        sequence; the short version is that a build made on this Mac needs no
#        quarantine handling and a COPY does:
ditto -c -k --keepParent "$(packaged_app)" /tmp/Pilot.zip   # what you would send
xattr -l /tmp/Pilot.zip
cp -R "$(packaged_app)" /Applications/
#
#    (e) START IT FROM FINDER, WITH NO TERMINAL ANYWHERE. This is the step, and
#        it must be done by double-clicking in Finder — NOT with `open`, and
#        certainly not from a shell with `PILOT_*` exported. What is being
#        checked is a launch that inherits nothing.
#          · a menu bar item appears, titled `Pilot`. There is no Dock icon and
#            no window: `LSUIElement` is true. If no menu bar item appears, the
#            app is running and completely invisible — kill it from Activity
#            Monitor and report it, because that is unshippable.
#          · clicking it opens the panel.
#          · asking a typed question answers.
#        BAD: nothing appears at all; a crash; or a panel that is blank white
#        (that is the `file:`/CORS trap, and `verify-bundle.js` should have
#        caught it — say so if it did not).
#
#    (f) WHAT MODEL IS IT ACTUALLY TALKING TO? Measured on Linux and expected to
#        be identical here: a Finder launch reaches the FAUX provider, because
#        every provider selector is an environment variable and Finder supplies
#        none. Nothing in the panel says so. Confirm it, then fix it with the
#        launch file, which is PR-042's answer to exactly this:
log show --predicate 'process == "Pilot"' --last 5m --info | grep -a "model source"
#        EXPECT: `profile: development` and a description ending "not a language
#        model". Now write a launch file (three lines, no terminal needed beyond
#        this one — TextEdit will do) at
#        `~/Library/Application Support/Pilot/pilot.env`:
#
#            PILOT_LOG_LEVEL=debug
#            PILOT_LOCAL_BASE_URL=http://127.0.0.1:11434/v1
#            PILOT_API_KEY=this-must-be-refused
#
#        …quit Pilot, double-click it again, and read the log:
log show --predicate 'process == "Pilot"' --last 5m --info | grep -a "launch environment file"
#        EXPECT: `applied: ["PILOT_LOG_LEVEL","PILOT_LOCAL_BASE_URL"]` and a
#        refusal naming `PILOT_API_KEY`, with the VALUE nowhere in the output.
#        `model source` must then read `profile: local`. BAD: the value
#        `this-must-be-refused` appearing anywhere — that is a leak; or the file
#        being ignored entirely, which puts the packaged app back to having no
#        way at all to reach a real model. **Delete the file afterwards.**
#
#    (g) THE ATTRIBUTION QUESTION — CARRIED SINCE PR-011, AND THE MOST VALUABLE
#        ANSWER IN THIS ENTIRE DOCUMENT. Does macOS credit Screen Recording and
#        Accessibility to `Pilot.app`, or to the spawned `PilotHelper`?
#        Everything about the packaging — one identity for both binaries, a
#        child bundle identifier, the helper inside the app, the app as the
#        spawning parent — is configured for the first, and NOBODY KNOWS.
#
#        From a state where Pilot has been granted nothing (System Settings →
#        Privacy & Security → Screen Recording, remove every Pilot entry; a
#        fresh user account is cleaner), start it from Finder and press
#        "Look now". Then, WITHOUT GRANTING ANYTHING YET:
#          1. WHAT DOES THE PROMPT NAME? Screenshot it. `Pilot` means the app
#             bundle is the subject and everything in this repository is right.
#             `PilotHelper` — or a generic name, or a path — means the helper is
#             its own subject, and the consequences are large: the user grants
#             something that does not look like the app they installed, and
#             every rebuild of the helper re-prompts.
#          2. WHAT IS IN THE LIST AFTERWARDS? Grant it, then:
sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" \
  "select service, client, client_type, auth_value from access where client like '%pilot%';" \
  2>/dev/null || echo "TCC.db needs Full Disk Access — read the list in System Settings instead"
#             EXPECT (the good case): one row per service with
#             `client = works.pilot.desktop` and `client_type = 0` (a bundle
#             id). BAD: a `client` that is a PATH to PilotHelper with
#             `client_type = 1`. Say which; it decides whether the helper has to
#             become a proper `.app` inside `Contents/Library/`, which is a
#             design change, not a setting.
#          3. WHAT DOES PILOT ITSELF THINK? The startup line already carries the
#             verdict PR-011 computes, and it has only ever been checked against
#             a stub:
log show --predicate 'process == "Pilot"' --last 5m --info | grep -a "permission attribution"
#             EXPECT: `verdict: matched`. `bundle-mismatch` from inside the
#             packaged app is a real defect — `Attribution.swift` comparing the
#             wrong two things — and it would silently refuse every observation.
#
#    (h) DOES A REBUILD COST THE GRANTS? Expected: yes, and that is the price of
#        an ad-hoc signature, whose code-directory hash is a hash of the bytes.
#        Rebuild, reinstall, relaunch from Finder, and see whether it prompts
#        again. Record the answer — if macOS instead keeps a STALE grant and the
#        app silently cannot capture, that is far worse than re-prompting and it
#        changes what a release build has to do.
#
#    (i) THE SECOND PROCESS, which is this PR's demo: "install and run the
#        packaged app without starting a second Pilot process". With the
#        packaged app running from Finder, run `pnpm dev` in a terminal.
#        EXPECT: the dev instance exits immediately and the packaged app's panel
#        is revealed — one menu bar item, not two. Same
#        `requestSingleInstanceLock` step 16 (d) checks, in the layout where the
#        two processes are genuinely different builds.
ps ax | grep -c "[P]ilot.app"

# 23. PR-043 — THE ACCEPTANCE MATRIX AND THE GROUNDING CHECKLIST, FOR REAL.
#    This is the step the whole plan has been deferring to. It is the LAST of
#    this section and it depends on almost all of it: run it after steps 5, 7,
#    8, 9, 12, 13, 14, 16, 22 and — this is the one that matters most — after
#    17 or 20, because without a real model NONE of the grounding half can be
#    answered. It PROMPTS FOR EVERYTHING, OPENS THE MICROPHONE, MAKES NOISE and
#    (with step 20's profile) COSTS MONEY.
#
#    NOTHING IN THIS PROJECT HAS EVER SCORED A GROUNDING CASE. `pnpm acceptance`
#    executes what Pilot SENDS — the anchor, the crop, the element, the envelope
#    — and reports every "does the answer describe the right thing?" as pending.
#    The number the plan asks for (≥90% on ~30 curated static-UI cases) does not
#    exist and cannot be computed anywhere but here.
#
#    First the Linux suite, which already passes and which prints, per criterion,
#    exactly what it did and did not establish. Run it once so a difference on
#    the Mac is a difference in the PLATFORM, not in the wiring:
pnpm acceptance

#    Its verdict distribution today is: 0 verified, 13 verified in part, 0
#    failed, 2 blocked. 51 pass-condition checks, 35 of them executed on Linux
#    and 16 waiting on this Mac (10), a real model (5) or both (1). (It reported 1 FAILED until PR-044
#    closed A-09 — see (c) below and step 24.)
#
#    Then the real thing, with the real helper and a real provider. Pick ONE
#    provider and record which:
PILOT_HELPER_BINARY="$(pwd)/packages/platform-mac/native/.build/debug/PilotHelper" \
  PILOT_LOCAL_BASE_URL=http://127.0.0.1:11434/v1 \
  PILOT_LOG_LEVEL=debug pnpm dev

#    …and finally from inside the packaged `.app`, which is the only layout
#    where A-15 can be answered at all and the only one where TCC can plausibly
#    attribute anything to Pilot:
open "$(packaged_app)"
#    (`packaged_app()` and `packaged_helper()` are defined at the top of this
#    section; do not hardcode `mac-arm64` — an Intel Mac produces `mac-x64`.)
#
#    ## (a) THE THIRTY GROUNDING CASES — the reason this step exists
#
#    `pnpm acceptance` §3 prints all thirty with, per case, what the pointer was
#    on and what grounding was expected. Do the same thirty by hand against
#    REAL applications — System Settings, Safari, Mail, Notes; the accepted gap
#    in §3 of this document is "real apps rather than a purpose-built test app",
#    and this is that decision being paid for. For each one:
#
#      1. select the window, put the pointer ON the named kind of target and
#         LEAVE IT THERE;
#      2. ask "what is this?" — typed is fine, held is better;
#      3. score the ANSWER, not the picture: does it describe the control under
#         the pointer, or the window in general, or something else entirely?
#      4. write down `correct` / `wrong` / `refused`, and for every `wrong` copy
#         the `<context>` block out of the debug log — it is the exact text the
#         model was given, and a wrong answer over a right envelope is a MODEL
#         problem while a wrong answer over a wrong envelope is a PILOT problem.
#         That distinction is the whole value of this step.
#
#    The cases to reproduce, which are the ten positions `pnpm acceptance` runs
#    at both scales plus the ten edge cases:
#      · an ordinary labelled button; a list/outline item in a sidebar;
#      · each of the FOUR CORNERS of a window, on nothing in particular;
#      · exactly on the window's left border;
#      · empty canvas with no element under it;
#      · a notification or floating palette STACKED OVER the selected window
#        (nothing about the other application may appear in the answer);
#      · the pointer OUTSIDE the selected window entirely (the answer must say
#        so and must not invent a target — see (b) below);
#      · a control with NO accessibility element (a canvas-drawn toggle, a web
#        page's custom widget) — this is the case where the crop is all the
#        model has;
#      · a PASSWORD FIELD (the answer must not contain the password, and
#        `redactionsApplied` in the log must be ≥ 1);
#      · a question with the pointer parked off-screen before you speak;
#      · "what changed?" after flipping something, which must produce at most
#        two comparison frames;
#      · a window LARGER than 1440 px on its longest edge, which must arrive
#        reduced.
#
#    ≥90% correct across the thirty is the release gate (§19). RECORD THE
#    FRACTION AND THE FAILURES. If it is below 90%, the failures are the input
#    to PR-044, and the envelope you copied says which lane owns each one.
#
#    ## (b) THE ONE ANSWER ONLY YOUR EYES CAN GIVE
#
#    With the pointer OUTSIDE the selected window, `view: both` still produces a
#    pointer crop — of the window corner nearest the pointer, because
#    `pointerCropRect` shifts the rectangle inside the frame rather than
#    refusing. The envelope says "outside the selected window; no element was
#    identified", so the model is TOLD; whether it nevertheless describes that
#    corner as if you had pointed at it is unknown, and it is runbook follow-up
#    49. Ask the outside-window question three times and say whether the answer
#    ever talks about the corner.
#
#    ## (c) A-09 USED TO FAIL, AND YOU ARE CHECKING THE FIX ON A REAL TCC
#
#    `pnpm acceptance` reported A-09 as **failed** from PR-043 until PR-044:
#    with Accessibility denied and Screen Recording granted, Pilot went to
#    `needs-permission` instead of the degraded visual mode system-design §16
#    and A-09 both describe (runbook follow-up 35, now closed). It now reads
#    `verified-in-part` on Linux. Step 24 is the whole of the Mac-and-model half
#    of that row and is where the degraded mode gets its first real read.
#
#    ## (d) STANDARD AND RETINA — TWO DISPLAYS, OR ONE AND A SETTING
#
#    §19 wants the matrix on "at least one standard-DPI and one Retina/
#    display-scaled setup". On a modern Mac the Retina half is free; the
#    standard-DPI half needs either an external 1× monitor or
#    System Settings → Displays → a scaled resolution that reports
#    `backingScaleFactor` 1. Run at least the ten pointer positions on each and
#    check TWO things:
#      · the answers are as good on one as on the other;
#      · and the thing `pnpm acceptance` §4 found: the pointer crop is a
#        constant 640 CAPTURED pixels, so it covers ~640 pt of window at 1× and
#        ~533 pt at 2×. Say whether the tighter Retina crop actually loses
#        context a model needed — it is a policy question §10 never asked
#        (runbook follow-up 48) and only a real model can settle it.
#
#    ## (e) THE LATENCY BUDGETS, WITH A STOPWATCH
#
#    §17 budgets image preprocessing under 150 ms and TTS interruption under
#    300 ms. Linux measures ~70 ms of real pipeline on synthetic pixels and
#    ~1 ms of Pilot's half of the interruption. Here:
#      · read `observation` timings out of the debug log for a REAL
#        ScreenCaptureKit frame at 2× — a 2400×1600 surface is nearly three
#        times the pixels the Linux number was measured on;
#      · TIME THE INTERRUPTION BY EAR (step 15 (b)). The voice must stop before
#        you finish the first word of the next question.
#      · and time the whole thing once, end to end: key down → sound. That
#        number appears nowhere in this repository and is the one a user feels.
#
#    ## (f) WHAT TO SEND BACK
#
#    The thirty-case fraction, every `<context>` block for a wrong answer, the
#    A-09 behaviour, the two scale results, the three timings, and the verdict
#    you would give each of A-01…A-15. That last list replaces the Linux
#    distribution in `pnpm acceptance`'s own output as the record of record.

# 24. PR-044 — DEGRADED GROUNDING WITH ACCESSIBILITY REFUSED, ON A REAL TCC.
#    system-design §16: "Accessibility denied → continue with visual pointer
#    coordinates and disclose reduced grounding". Runbook follow-up 35 is closed
#    and A-09 now reads `verified-in-part` on Linux, but every permission state
#    in that run came from the Node stub advancing a scripted snapshot, and
#    `AXUIElementCopyElementAtPosition` HAS NEVER BEEN CALLED. Two of A-09's
#    pass conditions are still pending and this step is both of them.
#
#    Do it in the packaged app, where TCC can plausibly attribute anything to
#    Pilot at all. `packaged_app()`/`packaged_helper()` are defined at the top of
#    this section; do NOT hardcode `mac-arm64` (an Intel Mac produces `mac-x64`).
open "$(packaged_app)"
#    …and keep a debug log if you want the anchor lines:
PILOT_LOG_LEVEL=debug open "$(packaged_app)"

#    ## (a) THE REVOCATION, ON A RUNNING SESSION
#
#    Grant everything, select a window, ask one question and get an answer that
#    NAMES the control (the envelope line will read `pointer target: AXButton —
#    …`). Then, WITHOUT quitting Pilot:
#      System Settings → Privacy & Security → Accessibility → turn Pilot OFF.
#    macOS may offer to quit and reopen Pilot. DECLINE IT — the whole point is
#    what happens to a session that keeps running. If macOS force-quits Pilot
#    anyway, SAY SO: that would make the degraded mode unreachable in practice on
#    this OS version, which is a finding, not a failure of the fix.
#
#    Expect, and record each one as YES/NO:
#      · Pilot KEEPS WATCHING. The observation indicator still reads "Watching
#        this window", the selected window is unchanged, and no "Pilot stopped
#        watching, choose another window" prompt appears.
#      · The banner says what changed rather than announcing a stop:
#        "Accessibility is no longer allowed. Pilot is still watching and will
#        still answer, but it now works out what you are pointing at from the
#        picture alone."
#      · The permission row for Accessibility turns red, still offers "Open
#        System Settings", and the reduced-grounding disclosure appears under it.
#      · The observation surface adds "Accessibility is not allowed, so it is
#        working from the picture alone."
#
#    ## (b) WHAT THE MODEL IS TOLD — the half a screenshot cannot show
#
#    Ask the SAME question again over the SAME control. In the debug log (or the
#    diagnostics panel) find the rendered envelope and confirm it contains, on
#    its own lines:
#
#      pointer: 0.NNN, 0.NNN (window-relative, inside the selected window)
#      pointer target: unavailable — Accessibility is not permitted, so the name
#        and role of the control under the pointer cannot be read.
#      reduced grounding: work out what is at the pointer position from the
#        captured window alone, and say in your answer that you could not
#        confirm the control by name.
#
#    And confirm what must NOT be there: no `pointer target: AXButton`, no
#    control label, and no `none reported` (that phrase means "the hit test found
#    nothing", which is what an empty region looks like). A label leaking here
#    would be Pilot reading the screen under a permission the user has withdrawn.
#
#    ## (c) THE ANSWER — the only question a model can settle
#
#    THIS IS THE POINT OF THE STEP. Ask five questions in the degraded mode over
#    five different kinds of target (a button, a checkbox, a text field, a menu
#    item, an icon with no label). For each one record:
#      1. did the answer describe the RIGHT control, from the picture alone?
#      2. did the answer SAY that it could not confirm the control by name?
#    (2) is the disclosure §16 asks for actually reaching the user, and nothing
#    in this repository has ever observed it: every reply in `pnpm acceptance` is
#    a scripted string. If the model ignores the `reduced grounding:` line, the
#    fix is prompt wording in `renderAnchoredQuestionEnvelope` and this step is
#    where that is discovered. Paste the five answers back verbatim.
#
#    ## (d) THE UPGRADE, WITHOUT A RELAUNCH
#
#    Turn Accessibility back ON in System Settings and come straight back to the
#    same running Pilot. Without quitting, re-selecting the window or pressing
#    anything, ask the same question once more.
#      · The next answer must name the control again, and the envelope must go
#        back to `pointer target: AXButton — …`.
#      · The permission row goes green and the disclosure disappears.
#      · Note HOW LONG it takes. Pilot re-reads permissions on a poll and on
#        every panel open; if the upgrade needs a panel open to happen, say so —
#        it is defensible, but it is not what the Linux tests assert.
#
#    ## (e) THE ONE THING THAT WOULD BE A REGRESSION
#
#    Repeat (a) with SCREEN RECORDING instead. That one MUST still stop
#    everything: capture stops, the buffers clear under the `permission-loss`
#    retention occasion, and the panel says Pilot stopped watching (step 18 (a)
#    is the same read). If Screen Recording revocation now degrades instead of
#    stopping, PR-044 narrowed too far and that is the most important sentence
#    you could send back.
# 25. THE MODEL ROW — READ THE FIRST THING THE PANEL SAYS, ON A REAL FIRST
#    LAUNCH (runbook follow-ups 46 and 33, hazard 28). Two minutes, no
#    microphone, no money, and it is the only step in this section that checks
#    something a user cannot avoid seeing. NO HUMAN HAS EVER LOOKED AT THIS ROW.
#
#    Do it in this order, because the first one is the defect and the rest are
#    the fix not overshooting.
#
#    ## (a) THE DOUBLE-CLICK, WITH NO CONFIGURATION AT ALL
#
#    Package, install and start Pilot from Finder exactly as step 22 does, with
#    NO `pilot.env` in `~/Library/Application Support/Pilot/` and nothing
#    exported in any shell. Open the panel from the menu bar item.
#    EXPECT, as the FIRST thing under the state badge and before you type
#    anything:
#      · a red-bordered alert reading, verbatim,
#        `NOT A REAL MODEL — answers are placeholder text`;
#      · under it: "No model provider is configured, so Pilot is answering with
#        a built-in stand-in. It is not a language model, it never sees your
#        screen, and nothing it says about your screen is true.";
#      · `Model: Development stand-in · pilot-faux/faux-vision`;
#      · `Screen images: Nothing is sent anywhere: there is no model to send it
#        to.`;
#      · and a remedy naming the ABSOLUTE PATH of your own `pilot.env`.
#    SAY WHETHER IT IS ACTUALLY UNMISSABLE. It is written to be, and nobody has
#    seen it. If it reads like a badge rather than a warning, that is the finding
#    and it is worth more than the rest of this step.
#    Then ask it a question anyway and confirm the answer is placeholder text —
#    the row and the answer must agree.
#
#    ## (b) THE REMEDY, FOLLOWED LITERALLY
#
#    Do exactly what the row tells you: create the file at the path it printed,
#    put `PILOT_MODEL_PROFILE=codex` in it, quit Pilot from the menu bar item and
#    start it again from Finder. EXPECT the row to change to
#    `ChatGPT subscription — Pilot cannot answer questions yet` (you have not
#    signed in yet), and the alert to go. If the remedy does not work when
#    followed literally, that is a release blocker: it is the only instruction a
#    packaged Pilot gives a user who has no terminal.
#
#    ## (c) LIVENESS — SIGN IN AND OUT WITHOUT RELAUNCHING
#
#    Still on the Codex profile, do step 19's sign-in. EXPECT the row to become
#    `Answering with your ChatGPT subscription` with
#    `Screen images: Remote model — screen images are sent to …` WITHOUT
#    quitting Pilot. Then press Sign out in the Model section and expect it to go
#    back to "cannot answer questions yet" — again with no relaunch. Confirm the
#    row and PR-037's own Codex section never disagree with each other; they are
#    published from one subscription and are meant not to be able to.
#
#    ## (d) THE OTHER TWO PROFILES, AND THE ONE CLAIM THAT MUST FAIL CLOSED
#
#    With `PILOT_LOCAL_BASE_URL=http://localhost:11434/v1` (step 17), expect
#    `Answering with your own local model` and
#    `Screen images: Local model on this Mac (localhost)`, with NO warning
#    colour. Then point the same variable at your own machine BY LAN ADDRESS
#    (`http://192.168.x.x:11434/v1`). EXPECT the row to turn amber and read
#    `Remote model — screen images are sent to 192.168.x.x`: a model on the
#    network is not a model on this Mac, and the claim is allowed to err only in
#    that direction. With step 20's API-key profile, expect
#    `Answering with your own API key` and — the thing to actually check —
#    CONFIRM WITH YOUR EYES THAT NO PART OF THE KEY APPEARS ANYWHERE in the row,
#    in the Model section, or in `~/Library/Logs`. Tests assert this; a person
#    should look once.
#
#    ## (e) WHAT TO SEND BACK
#
#    A screenshot of (a), a yes/no on "unmissable", whether (b) worked when
#    followed literally, whether (c) needed a relaunch, and the two locality
#    strings from (d).
```

## 1a. Clean-machine installation (PR-042)

**None of this has been performed.** It is written from Apple's documented
behaviour of Gatekeeper, quarantine and TCC, and whoever runs it first should
expect at least one step to be wrong.

The artefact is the `Pilot-*-mac.zip` electron-builder's `zip` target produces
under `apps/desktop/release/`, or the `Pilot.app` inside `release/mac-*/`. There
is **no dmg and no installer**, and there will not be one for MVP 01.

```sh
# On the machine that built it — nothing special is needed. `codesign` ran
# locally, and a locally built bundle carries no quarantine attribute.
cp -R "$(packaged_app)" /Applications/

# On ANY OTHER machine, or after the zip has been through a browser, a mail
# client, AirDrop or a cloud drive, the copy is quarantined:
xattr -l /Applications/Pilot.app          # look for com.apple.quarantine
xattr -dr com.apple.quarantine /Applications/Pilot.app
```

Why, and what to expect:

- **The build is ad-hoc signed and NOT notarised** (runbook §7; user decision:
  no Developer ID account). Gatekeeper refuses a quarantined app whose signature
  carries no Developer ID, usually with *"Pilot is damaged and can't be opened"*
  — which is Apple's wording for "unnotarised", not a real corruption. Removing
  the quarantine attribute, or right-click → Open once, is the documented way
  past it for a build you made yourself.
- **Do not skip the `xattr` on a machine you do not control.** It is a real
  security decision — it says "I trust this binary" — and Pilot asks for the
  screen, the keyboard and the microphone.
- **Every rebuild is a new TCC subject.** An ad-hoc signature's code-directory
  hash is a hash of the bytes, so a rebuilt Pilot is, to macOS, a different
  program wearing the same name. Expect to re-grant Screen Recording,
  Accessibility, Microphone and Speech Recognition after each install. Step 22
  (h) is the check for the worse alternative — a stale grant that is kept and
  does not work.
- **Configuring it without a terminal**: `~/Library/Application
  Support/Pilot/pilot.env`, `NAME=value` per line. That is the only way a
  double-clicked Pilot can be pointed at a real model provider; see README
  "Configuring a packaged app without a terminal". A real environment variable
  always wins over the file, and `PILOT_API_KEY` in it is refused rather than
  honoured.
- **Uninstalling**: delete `/Applications/Pilot.app`, then
  `~/Library/Application Support/Pilot/` (the conversation database and any
  credential), then remove the entries in System Settings → Privacy & Security →
  Screen Recording / Accessibility / Microphone / Speech Recognition. Nothing
  else is written anywhere, and PR-041's step 21 (f) is the check for that
  claim.
- **Minimum macOS is 13.0** (`LSMinimumSystemVersion`), matching
  `platforms: [.macOS(.v13)]` in the helper's `Package.swift`.

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
- **Step 22 is the one that makes every other step's TCC answer meaningful**,
  and it is the first time anything in this project has been code-signed. Its
  part (g) is the oldest open question here — whether macOS credits the app
  bundle or the spawned helper — and every earlier step that says "…and from
  inside the packaged `.app`" is waiting on it. Do steps 1–3 first; without a
  helper that compiles there is no bundle to sign.
- **Step 22 (e) must be a double-click in Finder.** `open`, `open -a` and
  `open --env` are all different launches with different environments, and the
  property being checked is precisely that Pilot works when it inherits
  nothing. Several earlier steps use `open "$(packaged_app)"` for convenience;
  that is fine for those, and not fine for this one.

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
  the pointer inside the selected window, and step 11b is where that is checked
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

### What to look for in step 11b (PR-031)

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

### What to look for in step 12 (PR-032)

This is the first time anything in this project has **pressed a key** or
**recorded audio**. Six things, in order — and do the first one before you speak
a word, because it is the one that can be answered without a microphone.

1. **Does the tap exist at all, and with which permission?** Watch the startup
   log for `desktop.main.voice` / `push-to-talk is wired to the interaction
   controller` and the `availability` on it. `active` means macOS let a
   `CGEventTap` exist. `unavailable/permission-missing` after Accessibility has
   been granted is the important negative result: **it means macOS also wants
   Input Monitoring, which Pilot does not model anywhere** (runbook §5a). If
   that is what happens, say so — it is a design gap, not a bug, and it changes
   PR-042's entitlements and PR-008's onboarding copy.
2. **Does the key work while another application is in front?** That is the
   whole feature (`docs/product-spec.md` FR-11). Test it with a browser
   focused, not with Pilot focused. A shortcut that only fires when Pilot has
   focus means the tap is not global and the `CGEventTap` location is wrong.
3. **Does Right Option insert anything, anywhere?** It is a live dead-key
   modifier on some layouts. Hold it in a text field in another app and check
   nothing is typed. If it is, the binding is wrong for that keyboard layout and
   the default has to change — say which layout you use.
4. **Does the live transcript grow while you speak?** Partial results are what
   make holding the key feel like anything at all. If the panel only fills in at
   the end, Apple Speech is not returning partials for that locale, or the 60 ms
   drain (`DEFAULT_SPEECH_POLL_INTERVAL_MS`) is being outrun.
5. **Does what you said become the question you meant?** Say a sentence with a
   proper noun and a number in it. Also try **letting go early** and **letting
   go late** — Apple Speech endpoints on its own, so a `final` before the key is
   released is normal and PR-025's binding is built for it. What must never
   happen: a question submitted *twice*, or a question submitted with the
   previous utterance's words.
6. **Revoke the Microphone while Pilot is running, then press the key.** System
   Settings → Privacy & Security → Microphone. Expect the panel to land in
   `error` with "Pilot needs Microphone access to listen…" **and the text box to
   stay live**. If the text box is not usable there, stop — that is the single
   most important behaviour in this PR and the one §16 does not permit failing.

Also worth capturing while you are there: what
`speech disclosure` reports for your locale (§7 of `pnpm demo:talk` shows the
two shapes). If this Mac cannot recognise your language **on device**, Pilot
refuses to listen rather than sending the audio to Apple — that is
system-design §11 working as designed, and it will look like a broken
microphone unless the disclosure is on screen. Say which locale you are on.

And one thing only a Mac can settle: **the attribution verdict for the voice
path**. PR-032 refuses voice outright on `helper-attributed` or
`bundle-mismatch`. If step 5 came back with either of those, push-to-talk will
be off before you press anything, with the sentence "macOS is giving Pilot's
microphone and Accessibility permissions to another program…". That is correct
behaviour, but it means steps 2–6 above cannot run until the packaged `.app`
produces `matched`.

### What to look for in step 13 (PR-033)

This is the first time anything in this project has **made a sound**. Six
things, and the first three are the ones a printed log cannot answer:

1. **Is anything audible at all?** `pnpm demo:speak` cannot tell you: it drives
   the Node stub, which reports `started` and `finished` without a speaker in
   the loop. The real answer is `pnpm dev` with the volume up, and the startup
   log line to check first is `desktop.main` / `speech output` with
   `real=true available=true` and a non-zero `voices`. `available=false` means
   this Mac has no installed voice — Pilot then reads its answers instead of
   speaking them, which is correct §16 behaviour and worth reporting, because
   it is indistinguishable from a bug without this line.
2. **Is it gapless between sentences?** An answer is spoken as several
   utterances handed one after another to `AVSpeechSynthesizer`'s own queue,
   which is what should make sentence-to-sentence playback seamless without
   Pilot timing anything. A perceptible gap, or a sentence spoken twice, means
   the host is being let into the loop between chunks — report it, because the
   fix is in PR-014's queue handling and not in the wiring.
3. **Does an interruption stop the sound *now*?** Start a long answer, then
   press push-to-talk (or Interrupt) while it is speaking. `docs/system-design.md`
   §17 budgets under 300 ms and `pnpm demo:speak` §6 measures ~5 ms — but that
   is a JSON round trip over a pipe, not audio stopping. What matters is whether
   the voice cuts off mid-word or finishes the sentence it was on.
4. **Does the panel keep the answer while it speaks?** The text and the voice
   are two renderings of the same answer. The text should be complete on screen
   *before* the last sentence is spoken, and the panel should leave *Speaking*
   exactly once, when the whole answer is done — not after the first sentence.
5. **Kill the helper mid-sentence** (`pkill PilotHelper` while it is talking).
   Expected: the sound stops, the panel leaves `speaking`, the answer stays on
   screen, and the state is **not** `error`. A helper that dies is reported as
   `stopped`, not as a failure — nothing failed about the answer, the audio
   simply ended.
6. **Quit mid-sentence** (⌘Q, or the tray's Quit). The sound must stop at once
   rather than playing on for a second or two while the app tears down. That is
   what the disposal order in `main/index.ts` is for; if it is audible, say so.

Also worth capturing while you are there: which voice was chosen and whether it
is intelligible at the default rate. Pilot passes no `voice` and no `rate`, so
it gets the system default; if that is unusable, a voice picker is a small
addition and worth knowing about early.

### What to look for in step 14 (PR-034)

This is the whole product in one run, so the useful observations are the ones
no single earlier step can make. Six, in order of what they would cost:

1. **Is the answer about the thing you were pointing at?** Everything else here
   is machinery; this is the product. Point at a *specific* control, ask "what
   is this?", and judge the answer against the control — not against the window.
   An answer that is confidently about the wrong control is the failure that a
   transcript makes invisible, and nothing on Linux can produce it, because no
   real model has ever read one of these crops. If it happens, capture the
   pointer coordinates the panel shows and the screenshot, and say which control
   you meant: that is a grounding case for PR-043's checklist.
2. **Did the model choose to look?** `pnpm demo:flow` scripts the `observe_screen`
   call. A real model decides. Watch whether it looks when it needs to, whether
   it *stops* looking for a follow-up that does not need the screen, and whether
   it looks again when the window has changed under it (system-design §11's
   whole premise). Report all three; they are the largest remaining unknown in
   the plan.
3. **Does a spoken question survive the trip?** Every question in this repository
   was typed by a test until PR-032, so it was spelled and punctuated. Say a UI
   label, a proper noun and a version number out loud and see what the model was
   actually asked.
4. **Do the six pieces overlap the way they should?** The first word should be
   spoken *before* the last word is written, the panel should show it looking at
   the moment it looks, and the transcript, the answer and the voice should be
   three renderings of one thing. Any of them arriving in a different order is
   worth reporting even if nothing breaks.
5. **The interruption, on a real speaker.** Hold the key mid-answer. §17 budgets
   300 ms and the stub measures a few; what matters is whether the voice cuts
   off before you have finished your first word, and whether the abandoned
   answer ever resumes. It must not.
6. **The pointer crossing an application border while you speak.** Move the
   pointer off the selected window and back while the key is held — over a
   notification, a palette or another app's window. Nothing Pilot says may ever
   describe what was under the pointer while it was outside; on Linux that is
   checked at the wire, and on a Mac it is the first time a real accessibility
   tree could answer with something it should not.

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
PR-032 turns the whole thing on with a key and a voice — `MacHotkeyAdapter` and
`MacSpeechInputAdapter` drive the interaction controller (`pnpm demo:talk`,
`apps/desktop/test/main/voice-runtime.test.ts`,
`apps/desktop/test/voice/talk-demo.test.ts`) — and its gap is the plainest one
in this file: **no key has ever been pressed and no audio has ever been
recorded.** Not one `CGEventTap` has been created, not one microphone opened,
not one word recognised. Every key transition and every transcript in every test
and demo is the Node helper stub playing a script it was handed. What is proven
is that Pilot's half behaves correctly given a tap and a recogniser that
misbehave the way macOS's do — early finals, double finals, callbacks after
cancel, a tap the system switches off mid-press. Whether macOS lets Pilot have
either is step 12.
PR-033 closes the loop by making Pilot answer out loud — `MacSpeechOutputAdapter`
behind PR-026's TTS buffer, with `main/speech-runtime.ts` guaranteeing that a
synthesiser failure costs the sound and never the answer (`pnpm demo:speak`,
`apps/desktop/test/main/speech-runtime.test.ts`,
`apps/desktop/test/voice/speak-demo.test.ts`). Its gap is the plainest of the
lot: **nothing has ever been spoken aloud.** No `AVSpeechSynthesizer` has been
constructed, no voice resolved, no audio device opened and no sound produced.
Every `started`, `finished`, `stopped` and `error` in every test and demo is the
Node helper stub answering a script. What is proven is that Pilot's half is
correct given a synthesiser that behaves as macOS's does, including one that
fails mid-answer or dies mid-sentence; what cannot be proven here is whether a
single word is audible, whether two sentences run together without a gap, or
whether the sound really stops when an interruption says it should. Step 13 is
what produces that answer, and part of it is audible rather than printed.
PR-035 interrupts all of that — during a screen observation, during a spoken
answer, twice in a row, and in the window between an answer and its first word —
and every one of those results is a Linux result. Its gap is one sentence long
and it is the one people will most want to skip: **no sound has ever been
stopped, because no sound has ever been made.** `pnpm demo:interrupt-flow`
measures the time from Pilot accepting `push-to-talk-down` to
`speech.output.stop` crossing the pipe (~1 ms here) and says, in its own section
5, that this is Pilot's half of §17's 300 ms and that everything after it —
`stopSpeaking(at: .immediate)`, the synthesiser draining, the audio device going
quiet — is unmeasured and is the part a person in the room would hear. Step 15
is what produces that answer, by ear.

### What to look for in step 15 (PR-035)

Four things, in decreasing order of what they would cost if wrong:

1. **Does the voice stop before you finish your first word?** That is §17, and
   it is the only acceptance question here a machine cannot answer. If it
   trails off, or finishes the sentence it was on, say so and roughly how long
   it took — the fix is in `SystemSpeechOutputService.stop(speechId:)` (does it
   pass `.immediate`?), not in Pilot's half.
2. **Does interrupting while Pilot is *looking* work?** Press the key while the
   panel says it is looking, then ask something else. The answer must be to the
   new question and there must be no "Pilot is still working on the previous
   question". This is the decision PR-035 took (runbook follow-up 14) and the
   first time it will have met a real capture rather than a delayed stub.
3. **Does the abandoned answer ever resume?** Not in the panel, and not aloud —
   including a second or two later, once the model's own request has finished
   unwinding. On Linux this is checked at the wire; on a Mac it is checked by
   listening.
4. **Does the interrupted answer's *text* survive?** §16 says the sound is what
   may be lost, never the reply. Whatever the panel had when you pressed the key
   must still be there afterwards.

### What to look for in step 16 (PR-036)

Step 16 is the first thing in this project that **writes a file the user keeps**,
and everything below is about that file. On Linux the whole of it runs against a
real SQLite database in a temporary directory (`pnpm demo:memory` writes one,
scans its bytes and deletes it), and `pnpm smoke` proves the packaged app opens
one from inside the asar. What Linux cannot show is any of the behaviour that
depends on *how the process ended*, which is the point of (c).

Five things, in decreasing order of what they would cost if wrong:

1. **Does the conversation come back after a quit?** Ask, quit, relaunch, ask
   "what did I ask you first?". If the answer is about the current run rather
   than the previous one, look at the startup line: `restored: 0` with
   `durable: true` means the transcript is on disk and the model was never told
   — runbook follow-up 20 (b), and it fails silently by design of the failure,
   not by design of the code.
2. **Does a killed process lock you out for longer than 30 seconds?** It must
   not. `killall -9 Pilot`, relaunch, see the "already open in another window"
   sentence beside a live text box, wait, relaunch again, and it must be
   working. If deleting `sessions.db` is the only thing that helps, that is the
   defect — say so rather than working around it.
3. **Is the file where this document says it is, and is it the only one?**
   `~/Library/Application Support/Pilot/conversations/`. Anything else Pilot
   persists (preferences, permission state) must not be in that directory, so
   the user can delete their conversation history without losing the rest.
4. **Does Clear conversation really clear it?** `grep -a` the database for
   something you asked. §13 says the pages are reclaimed rather than merely
   marked free, so the answer must be nothing — the Linux run checks exactly
   this, but on a file this Mac wrote.
5. **What context window does a real provider report?** Only once PR-037 or
   PR-039 lands. The startup line prints the decision and which rule produced
   it. A hosted model should read `model`; a local endpoint is capped at 32 768
   deliberately and `PILOT_CONTEXT_WINDOW` raises it. **Nothing in Pilot
   measures what an endpoint really handles** — if your local model copes with
   more, say so and the ceiling moves.
   **PR-037 answers half of this without a sign-in.** `PILOT_MODEL_PROFILE=codex`
   makes the startup line read
   `272000 tokens (model; remote endpoint advertised 272000)` — the hosted
   "believe it" branch, taken for the first time. The number comes from the
   pinned catalogue rather than from a live call, so what is still unknown is
   whether the endpoint really honours it.

### What to look for in step 18 (PR-040)

Step 18 is the only step whose *point* is that something goes wrong, and the
thing to hold on to while running it is the rule the PR is built on: **a failure
of the watching costs the watching, never the answer.** Losing a permission, a
window, a capture stream or the helper must never abort a reply that is already
arriving; it must stop Pilot watching, say so, and clear what was buffered.

Four things, in decreasing order of what they would cost if wrong:

1. **Does anything degrade silently?** That is the defect shape, and it is the
   one the Linux run cannot rule out on a Mac. After each case, look at the
   panel and at the picker: an ending with no sentence anywhere is a bug even if
   nothing crashed. Before this PR, a window that blocked capture produced one
   `warn` line in the log, left the switch reading "watching", and let the next
   question be answered with no picture at all.
2. **Does a revoked permission take the helper with it?** (a) above. Nobody
   knows what macOS does to a *running* `SCStream` when Screen Recording is
   withdrawn — the stream stopping and the helper dying are both plausible, and
   they produce different sentences. Both are safe endings; send the two log
   lines so the right one can be chosen.
3. **Is a restarted helper still credited with the grants?** (d) above. This is
   PR-011's attribution question asked a second time, of a process that macOS
   has seen die once. PR-040 re-probes the cached verdict on reconnect precisely
   because the cached one belonged to a dead process — but whether the *answer*
   is the same is a TCC question, and TCC has never been asked anything.
4. **Does a protected window ever produce pixels?** (e) above. A black frame
   described as if it were the screen is the worst outcome in the whole matrix,
   because it is the one the user cannot detect.

One thing this step does **not** check, and it has moved rather than gone away:
system-design §16 asks for Accessibility loss to be a *degraded* mode ("continue
with visual pointer coordinates and disclose reduced grounding"). PR-040 left the
machine stopping instead, because `REQUIRED_PERMISSIONS` listed all four
permissions and the required set is an interaction contract several PRs rest on.
**PR-044 closed that** (runbook follow-up 35): Accessibility loss now keeps Pilot
watching, and step 24 is the whole of the Mac-and-model read of the degraded
mode. Step 18 (a) remains the *Screen Recording* revocation, which must still
stop everything.

### What to look for in step 20 (PR-038)

Step 17 is the first thing in this project that would **hold a secret** and the
first that would **send a screen image off the machine**. Everything on Linux
runs against `createRecordedApiKeyProvider` — a fake vendor in the same process
— and against real AES-256-GCM rather than the Keychain, so what Linux cannot
show is exactly the three things a real key and a real Mac would.

Five things, in decreasing order of what they would cost if wrong:

1. **Is the key really not on disk?** `grep -a` the sealed file for it. The
   Linux run checks exactly this against a file it wrote; step 17 (a) checks it
   against a file the Keychain sealed. If `grep` finds anything, stop and say
   so — it is the one defect in this PR that cannot be worked around.
2. **Does `safeStorage` work at all under the packaged app?** The startup line
   reads `secureStorage: true|false`. False is handled — Pilot refuses to store
   a key rather than writing plaintext, and the panel says so — but on a Mac it
   should be true, and false is worth reporting rather than living with.
3. **Does the capability probe agree with reality?** One text-only request, one
   expected tool call. A real model that answers in prose is refused, and that
   refusal would be *Pilot's* fault rather than the model's. This is the single
   most likely thing in PR-038 to be wrong against a real provider, because the
   recorded vendor cannot be prose-y.
4. **Does a rejected key read as a rejected key?** The four patterns in
   `classifyApiKeyFailure` were written against one recorded 401 body. Real
   vendors differ. A misclassification sends the user to check their network
   when their key is dead.
5. **Does the banner say the right host before the first question?** It is
   rendered from `describeModelDataDisclosure`, which fails closed — a profile
   claiming `isRemote: false` with a non-loopback base URL is still labelled
   remote. Worth one screenshot.

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

---

### Step 19 — sign in to ChatGPT, and run the flow for real (PR-037)

**This is the only item in this file that needs a ChatGPT Plus/Pro account, and
it is the last fake boundary left in the product.** Everything below is written
and merged; nothing about it has ever touched the network.

Run from the same clean checkout as §1, on the Mac. Steps 1–16 do not have to
have been run first — this one needs no Swift helper, because the sign-in and
the status live in the main process and the panel. It *does* need the helper for
part (d), which is the flow itself.

```sh
nvm use && pnpm install && pnpm build

# The §1 resolvers again — do not hardcode mac-arm64, an Intel Mac is mac-x64:
packaged_app()    { find apps/desktop/release -maxdepth 2 -name 'Pilot.app' | head -1; }
packaged_helper() { echo "$(packaged_app)/Contents/Resources/helper/PilotHelper"; }

# 19a. THE SIGN-IN. This is the one that matters, and nothing else here can be
#      done until it works. Open the panel, find the "Model" section at the top,
#      press "Sign in to ChatGPT".
PILOT_MODEL_PROFILE=codex pnpm dev
#
#   Expect, in order:
#     - the startup line to say
#       `ChatGPT subscription (openai-codex/gpt-5.5, vision+tools ok) — NOT
#        SIGNED IN — no question can be answered until you sign in`
#       and the panel to show that sentence with an error banner beside a live
#       text box;
#     - pressing Sign in to show "Asking OpenAI for a sign-in code…", then a
#       code and the URL https://auth.openai.com/codex/device;
#     - you open that URL in any browser, type the code, approve;
#     - within a few seconds the panel to read "Signed in to ChatGPT".
#
#   WHILE IT IS WAITING, in another terminal, check the thing this whole design
#   turns on — that Pilot never binds the browser flow's port:
lsof -nP -iTCP:1455 -sTCP:LISTEN     # expect NO output, during and after
#
#   If it hangs on "Asking OpenAI for a sign-in code…" the device-code endpoint
#   rejected Pi's client id, which is exactly the thing nothing here could test.
#   Say so and paste the panel's error sentence.

# 19b. WHERE THE TOKEN WENT, and whether macOS encrypted it. Only you can
#      answer the second half: Electron safeStorage has never run here.
ls -l ~/Library/Application\ Support/Pilot/credentials/model-credentials.json
#   Expect mode -rw------- (0600) in a drwx------ (0700) directory.
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["protected"])' \
  ~/Library/Application\ Support/Pilot/credentials/model-credentials.json
#   Expect: True   ← safeStorage (Keychain) is doing its job.
#   If it prints False, the panel will also say "On this Mac, NOT encrypted".
#   That is a real finding, not a bug in the check — report it.
grep -c 'eyJ' ~/Library/Application\ Support/Pilot/credentials/model-credentials.json
#   Expect 0. A JWT prefix in that file means the token is in plaintext.
#
#   And confirm it is nowhere else. This is the Phase 4 gate line:
grep -rl 'eyJ' ~/Library/Application\ Support/Pilot/ | grep -v credentials
#   Expect NO output — in particular nothing under conversations/.

# 19c. THE CAPABILITY GATE, against a real catalogue entry.
PILOT_MODEL_PROFILE=codex PILOT_CODEX_MODEL=gpt-5.3-codex-spark pnpm dev
#   Expect the panel to refuse before you can ask anything: "This model cannot
#   see images…". Ask a question anyway and confirm NOTHING is captured — the
#   observation indicator must not flicker.

# 19d. THE FLOW, FOR REAL. Needs the helper (§1 steps 1–3) and the grants from
#      §1 step 5. `pnpm dev` finds the helper only through PILOT_HELPER_BINARY
#      or a packaged bundle:
PILOT_MODEL_PROFILE=codex \
  PILOT_HELPER_BINARY="$PWD/packages/platform-mac/native/.build/debug/PilotHelper" \
  pnpm dev
#   …and then from inside the packaged .app, which is the identity TCC trusts:
pnpm package
PILOT_MODEL_PROFILE=codex open -a "$(packaged_app)"
#   Pick a window, PUT THE POINTER ON A SPECIFIC CONTROL, hold the key, ask
#   "what is this?" out loud, and listen.

# 19e. SIGN OUT, and confirm the token is gone rather than merely forgotten.
#   Press "Sign out" in the panel, then:
ls ~/Library/Application\ Support/Pilot/credentials/
#   Expect: No such file or directory. Signing out deletes the file; it must
#   NOT delete anything under conversations/.
```

**What only you can report, in decreasing order of what it would cost if
wrong.** Everything in this list is currently a guess, an assertion, or a
recorded fact from a package rather than from a server:

1. **Does the Codex Responses API accept Pilot's images and its tool
   definition?** This is the largest unknown in the repository. `supportsTools`
   for this profile is **Pilot's own assertion** — Pi carries no tool metadata
   at all — so if `observe_screen` is rejected or ignored, the profile is wrong
   and `supportsTools: false` is the honest setting. Watch for an answer that is
   confidently about a screen the model never looked at.
2. **Does the model decide to look?** `pnpm demo:codex` scripts the tool call,
   as every demo here does. The first real session is the first time anything
   has chosen.
3. **Is a 1440-px window's PNG legible enough** for the model to read small UI
   text? `docs/mvp-01-point-ask-hear.md` §18 and PR-043's checklist measure it;
   this is the first chance to see it at all.
4. **How long does a real access token live?** Pilot reports the stored expiry
   and reproduces Pi's five-minute refresh boundary; nothing here knows what
   OpenAI actually issues. If it is short, leave Pilot open for an hour and
   confirm the panel goes from "Signed in" to "Signed in (renewing)" and back
   without ever asking you to do anything.
5. **What happens when a refresh really fails?** Revoke Pilot's access in your
   ChatGPT account settings while it is open, then ask a question. The panel
   must say "Pilot's ChatGPT sign-in could not be renewed. Sign in again to keep
   asking questions." beside a live text box — not a provider error string.
6. **Does `safeStorage` work in a *packaged* build?** 19b run from `pnpm dev`
   and 19b run from the `.app` are different questions: the Keychain entry is
   keyed to the application identity, and this build is not notarized
   (§3, "No notarization").
7. **The account you signed in with is never recorded anywhere.** Pi decodes a
   `chatgpt_account_id` from the token and Pilot deliberately never reads it, so
   the panel cannot tell you *which* ChatGPT account is in use. Say if you would
   rather it did — it is one field, and it is a privacy decision, not an
   oversight (§4).

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
- ~~**When you sign in, PR-037 changes one call site.**~~ **PR-037 has now
  changed it, and it really was one.** `main/index.ts` reads
  `codex.source ?? createDevelopmentModelSource(…)`; everything downstream still
  consumes the `ModelSource` interface (profile, `Models`, `Model`,
  `toolSupport`, a request counter, one line of description) and nothing else.
  The default is unchanged, because nobody has signed in;
  `PILOT_MODEL_PROFILE=codex` selects the real provider. Step 19 above is the
  sign-in.

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

PR-032 adds the question that only a real model *and* a real microphone can
answer together: **does a spoken question survive the trip?** Every question the
model has ever been asked here was typed by a test, so it was spelled correctly
and punctuated. A transcript is neither. Watch the first real spoken session for
whether the model copes with a recogniser's rendering of a proper noun, a
version number or a UI label — and for the failure that a transcript makes
invisible, an answer that is confidently about a word the user did not say.

**PR-034 joins all of those into one trace, and adds no new unknown of its own —
which is worth saying plainly, because the trace is the thing most likely to be
quoted.** `pnpm demo:flow` runs the MVP scenario end to end and everything holds
together; what it establishes is exactly the union of what the pieces already
established, and nothing more. In particular it does **not** show that a model
decides to look, that it answers about the control you were pointing at, that a
spoken question survives recognition, or that a single word was audible. Section
4 of its own output lists the acceptance rows this way: **A-01, A-03, A-08, A-11
and A-14 in part; the other ten not at all.** The one sentence to carry out of
it is that Pilot's half of the flow is correct given a platform and a model that
behave as macOS's and a real provider's do — and that neither has ever run.

**PR-036 adds two questions a real model will answer and nothing here can.**
First: **does a model read a replacement record as history?** Every image older
than the newest is replaced by a past-tense, scene-stamped sentence that ends
"not a description of the screen now; the screen has since moved to
scene-…/revision-…". `pnpm demo:memory` proves that sentence is what Pilot
*hands over*; whether a model then declines to describe the old screen is the
whole of the "no stale-screen claims" requirement and it is untested, because a
scripted provider cannot make the mistake. Watch the first real session for an
answer that confidently describes a screen from four turns ago. Second: **is the
extractive summary good enough?** §11 asks compaction to preserve "user goals,
decisions, named UI elements, unresolved questions"; Pilot's summary quotes the
transcript rather than asking a model to write one, and whether those quotes let
a real model carry on a twenty-turn conversation is a judgement nobody has made.
The first long real session is the test.

**PR-037 removes the fallback and leaves the account.** The Codex profile is now
in the shipping composition — real `openai-codex` provider, real catalogue, real
`Models.login`, a real credential file, and `pnpm smoke` on the *built* app
prints `ChatGPT subscription (openai-codex/gpt-5.5, vision+tools ok) — NOT
SIGNED IN` and `272000 tokens (model; remote endpoint advertised 272000)`. What
that means for this section is narrow and worth stating exactly: **the only thing
still missing is the account.** Every mechanical part of subscription auth —
choosing the device-code flow, storing and rotating the token, refusing before a
screen is read, translating a failed refresh into a sentence — is exercised by
`pnpm demo:codex` against a recorded reproduction of Pi's own OAuth surface, and
none of it has spoken to a server. The list of what only a real sign-in can
answer is step 19's, above, and its first item is the biggest one in the
repository: whether the Codex Responses API accepts Pilot's images and its tool
definition at all.

**PR-039 opens a route around this whole section, and it needs no sign-in.**
The local OpenAI-compatible profile talks to a model server the user runs
themselves: `PILOT_LOCAL_BASE_URL=http://127.0.0.1:11434/v1 pnpm dev` and Pilot
is on a real provider implementation, with no credential, no network and no
second Pilot process. If a machine with Ollama, llama.cpp or LM Studio on it is
easier to reach than a Codex sign-in, **§1 step 17 answers most of the questions
above sooner and more cheaply than PR-037 will** — does the model decide to
look, does it answer about the pointed-at control, does it read a replacement
record as history, is a 1440-px window legible. A small local vision model is a
weaker test than `gpt-5.5` and it is an enormously better test than a scripted
one.

Two caveats before that is quoted as "PR-039 unblocks §2". First, **it does not
close this section**: the Codex sign-in is still the thing PR-037 needs and the
thing runbook amendment 7 records as the user's choice. Second, **PR-039 has
never run against a real inference server either.** Its endpoint is a stub
written for the PR (`packages/agent/src/stub-openai-endpoint.ts`) which answers
in OpenAI shapes and contains no model. What it establishes is that Pilot's
half is right *given* a server that behaves as the OpenAI convention describes;
whether llama.cpp does is §1 step 17 (a).
**PR-038 changes what "blocked" means here, and it is worth being exact.** The
API-key profile is now built and wired: `apps/desktop/src/main/index.ts` boots on
a user-configured model whenever one is configured *and a capability probe has
verified it*, and falls back to the faux development source otherwise, saying
which in the startup log. So Codex sign-in is no longer the only route to a real
model — an API key is a second one, and step 20 above is how to take it.

What PR-038 did **not** do, deliberately: it registers no vendor SDK. Pi's 38
built-in providers are one call away (`loadBuiltinApiKeyProviders()`), but
wiring that call into the composition root was measured at **1.66 MB → 5.97 MB**
of main bundle, because `electron.vite.config.ts` inlines everything the main
process reaches. Which vendors a shipped Pilot carries is a packaging decision
with a real cost, so it is PR-042's, and step 17 (b) shows the one-line change
that tries a vendor before then.

And two questions only a real key can answer, both listed in step 17: whether a
real model answers the tool probe with a tool call rather than with prose, and
whether a real vendor's 401 body is recognised as a rejected key. Both are
Pilot's failure modes, not the model's, and neither can be reproduced against a
provider Pilot wrote itself.

---

## 3. Accepted gaps against the MVP definition of done

Recorded so they are not discovered at release time.

| Gap | Why | Owner |
| --- | --- | --- |
| No notarization | No Developer ID account (user decision). A packaged app needs `xattr -dr com.apple.quarantine` or right-click → Open on any machine that did not build it. **Unchanged by PR-042 and unchangeable without an account.** | accepted |
| Ad-hoc signing only | Same cause. PR-042 turned the hardened runtime on and made `scripts/sign-mac.js` sign the helper and then the app with `codesign --sign -`, each with its own entitlements. Consequence: the code-directory hash is a hash of the bytes, so **every rebuild is a new TCC subject** and every permission is granted again. §1 step 22 (h). | accepted |
| No macOS bundle has ever been built, signed, installed or launched | There is no Mac. Every line under `mac:` in `electron-builder.yml`, both entitlements files, the helper's embedded `Info.plist` and the whole darwin branch of the signing hook are configuration that has never executed. `pnpm verify:package` checks they are *internally consistent*, which is a much weaker claim and the only one available here. | §1 step 22 |
| The packaged app cannot be pointed at a real provider from its own UI | Provider selection is by environment variable, and Finder supplies none. PR-042 added a launch environment file (`~/Library/Application Support/Pilot/pilot.env`) so a double-clicked Pilot can be configured without a terminal, but there is still no model picker in the panel and nothing on screen says which provider is in use. Runbook follow-ups 33, 39, 40 and 46. | PR-044 |
| No CI | User decision. The five local commands in `docs/runbook.md` §6 are the only gate, run before every merge. | — |
| Grounding metric is a manual checklist | User decision — real apps rather than a purpose-built test app. ~30 cases, ≥90% required. **PR-043 built the checklist and executed all thirty, but only the input side.** `pnpm acceptance` §3 pins, per case, the anchor's normalised point, the accessibility target retained or refused, the crop rectangle and whether the thing under the pointer is inside it, and the rendered envelope. The 90% is about *answers* and no answer has ever been scored: 23 of the 30 cases report their verdict as pending a model. §1 step 23 (a) is the procedure, and the fraction it produces is the number this row is about. | §1 step 23 |
| A-09's degraded mode has never met a real TCC or a real model | **The defect is fixed** (PR-044, runbook follow-up 35 closed): `REQUIRED_PERMISSIONS` is Screen Recording alone, the envelope reads `pointer target: unavailable` with the reason, and A-09 reads `verified-in-part`. What is left is the two pass conditions that cannot run here — a real System Settings revocation under a running session, and whether a model given a picture, a point and a `reduced grounding:` instruction answers about the right control **and repeats the uncertainty to the user**. Every reply in `pnpm acceptance` is a scripted string. | §1 step 24 |
| No acceptance criterion is fully verified | 0 of 15 `verified`, 13 `verified-in-part`, 0 `failed`, 2 `blocked`; 51 pass-condition checks, 35 executed on Linux and 16 waiting on a Mac (10), a real model (5) or both (1). It read 1 `failed` until PR-044 closed A-09. This is the honest state of §19's gate and it is re-derivable at any time with `pnpm acceptance`. | §1 step 23, §1 step 24 |

---

## 4. Decisions taken without asking

Made under the standing instruction to use my own recommendation. Each is
reversible; raise any that look wrong.

| Decision | Reasoning |
| --- | --- |
| **The acceptance evidence is an executable harness, not two checked-in markdown files** (PR-043) | `docs/runbook.md` §6 promised `docs/acceptance.md` (an A-01…A-15 run log) and `docs/grounding-checklist.md` (~30 cases). Both were written instead as `pnpm acceptance` over `apps/desktop/src/acceptance/`. A checked-in run log is stale the day after it is written, cannot be re-derived, and — the reason that matters here — is exactly the artefact that lets a criterion nobody checked read as passing. The harness derives every verdict from checks that ran and refuses to construct a claim with no evidence beside it. The run log *is* its output; the checklist *is* `grounding-cases.ts`. Reversible in an afternoon if a static file is wanted for the release tag. |
| **The plan's "≥90% grounding accuracy" is reported as not computed rather than computed against a fake** (PR-043) | `docs/implementation.md`'s PR-043 line asks for it and §19 makes it a release gate. Every provider in this repository is a recorded fake or Pi's faux provider, so the answer a case would be scored on is the answer this repository scripted; a percentage over that measures the script and would be the single most misleading number the project could publish. The thirty cases were built and executed anyway, against the half that *is* real — Pilot's input to the model — and 23 of the 30 report their verdict as pending. §1 step 23 (a) is where the real fraction comes from. |
| **A-09 is reported `failed` rather than `blocked-on-mac`** (PR-043; **the defect it named is fixed by PR-044**) | Accessibility denied took Pilot to `needs-permission` instead of system-design §16's degraded visual mode, and that was decidable here — the permission states, the resting state and the observation conditions are all readable without a Mac. Filing it with the blocked rows would have hidden a known release-blocking defect (runbook follow-up 35) among the rows that are merely waiting for a machine, and `pnpm acceptance` exited non-zero on purpose. It now exits 0. **PR-044 did not weaken the check to get there** — it widened it, because §16's row has two halves and PR-043's version read only the first: A-09 now drives the revocation into a watching Pilot, reads the rendered envelope the model was given and the two view models the user is shown, then grants the permission back and reads the next envelope. Six pass conditions execute where one did; two are still pending. |
| **Follow-ups 48 and 49 were recorded, not fixed** (PR-043) | The 1×/2× pairing showed the pointer crop covers a different amount of window at each scale, and that a pointer outside the selected window still yields a crop of the nearest corner. Both are §10 *policy* questions rather than defects, both need a real model to settle, and changing the shipped crop behaviour inside an acceptance PR would have moved every earlier walkthrough's recorded byte counts for a reason unrelated to acceptance. |
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
| **A failure of the watching never aborts an answer** (PR-040) | The interaction table's `failure` row runs `teardown()`, which aborts the run in flight. A capture stream that dies, a window that turns out to block capture, or a helper that crashes while the model is still writing would therefore have cost the user the reply as well as the screen. `main/lifecycle-runtime.ts` reports those to the §16 notice at once and queues the banner and the observation switch-off until the turn ends. The trade: for a few seconds the panel shows an answer arriving while the picker says Pilot has stopped watching. That is true, and the alternative was losing the answer. |
| **Retry says no by default** (PR-040) | Pilot retries a failed observation exactly once, and only while the scene lineage and revision are the ones the request was made against. Everything else — a changed screen, a second failure, a failure the taxonomy calls final — becomes "ask again" with a sentence saying why. A retry that succeeds against a screen the user has moved past is a confident wrong answer, which is worse than the failure it replaced. **Say if you would rather Pilot retried harder**; the budget is one argument. |
| ~~**Accessibility loss stops Pilot rather than degrading it**~~ (PR-040; **reversed by PR-044**) | PR-040 left it alone deliberately: `REQUIRED_PERMISSIONS` made all four permissions required, so losing Accessibility reached `needs-permission` exactly as losing Screen Recording did — safe and explained, but not §16's row — and the required set is an interaction contract PR-006, PR-008, PR-009 and PR-028 all read. PR-044 narrowed it to `screen-recording` alone and re-checked those callers: `permissionsAllowObservation` had always treated Accessibility as `degrades`, so the panel, the window gate and the observation surface needed no change; the machine was the one disagreeing with them. A test now asserts the catalogue's `blocks` set and `REQUIRED_PERMISSIONS` are the same set, so they cannot drift again. |
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
| **Speech output is a silent adapter, not the shared fake** (PR-029) | The shell needs something behind `SpeechOutputAdapter` until PR-033. `FakeSpeechOutputAdapter` reports `started` and then waits for a test to call `finish()`, which would leave the app in `speaking` for ever after its first answer. The replacement reports `started` then `finished` immediately and makes no sound. Consequence worth knowing: the panel briefly shows *Speaking* for an answer nobody hears. The alternative — no speech state at all — would have meant a different machine path in development from the one in production. **Superseded by PR-033**, which deleted the silent adapter and made that behaviour the degraded mode of the real seam; the consequence is unchanged on a build with no voice. |
| **A synthesiser failure is turned into silence at the composition root, and never reaches the machine** (PR-033) | This is the most consequential decision in the PR and the easiest to reverse, so it is here rather than only in the runbook. `@pilot/interaction`'s `speech-failed` row goes to `error` **and tears the run down with it** (`teardown()` emits `interrupt-run`), so a synthesiser failing on chunk 2 of an answer the model is still streaming would abort the run and the rest of the reply would never arrive. `docs/system-design.md` §16 asks for the opposite in one line — "TTS fails → continue showing streamed text" — and PR-014's adapter says in its own comment that a caller treating a speech error as fatal to the turn is doing something it never asks for. So `main/speech-runtime.ts` guarantees that **no `error` ever leaves the speech-output seam**: a failed chunk becomes a completion for that same chunk, the stream carries on, the turn ends normally, and the failure is counted and logged (`an answer chunk was not spoken; the text is still on screen`) rather than shown. **What you lose by this**: the user is not *told* that Pilot went quiet — they see the answer and hear nothing. There is no surface for a non-fatal speech notice today and inventing one is PR-010's territory. **Say if you would rather the user were told**, and where. The alternative — changing the table's row — was rejected as a `packages/` contract change inside an integration PR, and because the row is still right for anything else that raises it (runbook cross-lane issue 15). |
| **`createTimeoutScheduler()` is now passed (PR-033, closing runbook follow-ups 6 and 25)** | PR-027 built the phrase-timeout wake-up as an injected port so the interaction machine owns no timers, and PR-029 deliberately left it unpassed because with speech silent there was nothing to release. There is now: a model that emits a clause and then goes quiet speaks what it already had, roughly one phrase timeout (1.2 s) later, instead of waiting for the run to end. It is opt-in and additive — `InteractionRuntimeOptions.scheduler` still defaults to PR-027's `NULL_SCHEDULER`, so every scripted desktop suite is untouched — and the machine still rejects a stale wake-up (`stale-phrase-timeout`) as hygiene rather than as a user-visible error. **Say if you would rather the answer always waited for the run to end**; it is one argument. |
| **The rig's helper stub completes its utterances by default** (PR-033) | `helper-stub.ts`'s synthesiser script defaults to `started` alone, which is exactly right for the interruption tests `packages/platform-mac` wrote it for and wedges an application in `speaking` for ever — the same trap runbook cross-lane issue 10 records against `FakeSpeechOutputAdapter`, one layer down. `createObservationRig` therefore defaults the script to `started, finished` (`DEMO_SPEECH_OUTPUT`) and a caller that wants a hanging or failing synthesiser scripts it explicitly, which `pnpm demo:speak` §4 and §6 both do. The stub itself was not changed: its default is correct for its own suite. |
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
| **Voice is gated on TCC attribution, and the refusal is a hotkey availability** (PR-032, closing runbook follow-up 12) | PR-011's verdict answers "does the grant reach this process", which is the question a `granted` microphone cannot answer on its own; without the gate the recogniser would open a microphone it does not really have and hear silence. The verdict is read **once**, through `MacPermissionAdapter.attribution()` (cached, so no extra round trip), **before** `hotkey.start()` — reading it afterwards would leave a window in which a press already opened the microphone. It is reported as a `HotkeyAvailability` rather than thrown, because that is the surface PR-010 already renders beside the live text box (§16). `unknown` is left alone, as PR-028 leaves it alone. **Say if you would rather voice ran anyway on a failing verdict** and let the user discover the silence; it is one condition. |
| **`HOTKEY_UNAVAILABLE_REASONS` gained `permission-unattributed`** (PR-032) | **A contract change, additive.** The existing `permission-missing` carries the sentence "Pilot needs Accessibility permission… " and a `PermissionKind` to route the user to System Settings. Both are *wrong advice* for an attribution failure: the permission exists, it is simply attached to another identity, and granting it again changes nothing — the fix is to run the installed `.app`. Reusing the code would have produced a confidently wrong instruction, which is the exact failure PR-011 exists to prevent, one layer up. One new member, one new `case` in `hotkeyUnavailableMessage`, no IPC schema change (the wire carries the sentence and the blocking permission, not the reason). |
| **The fake hotkey and the fake recogniser stay on the build with no helper** (PR-032) | PR-028 chose the opposite for capture — no adapter at all rather than `FakeObservationAdapter`, because a fake that only produces a frame when a test calls `emitNext()` looks like it might work and never does (runbook cross-lane issue 10). Voice is not that shape: `FakeHotkeyAdapter` and `FakeSpeechInputAdapter` both *complete on their own* under the app's own calls (the fake recogniser finalises on `stop()`, which is the release of the key), so a Linux `pnpm dev` remains a usable dev loop instead of a dead shortcut. It also keeps PR-010's `PILOT_HOTKEY_FIXTURE` and `PILOT_SPEECH_DISCLOSURE` states reachable, which have nowhere else to live. The substitution happens at the composition root, in one visible block, and the boundary table at the top of `main/index.ts` says which build is which. |
| **A denied microphone reaches §16 through `error`, not through onboarding** (PR-032) | Two different things are called "the microphone is denied". If the *permission gate* reports it, the machine rests in `needs-permission` and PR-008's onboarding — not the composer — is the way out; that is PR-006's design and PR-032 does not touch it. If the *recogniser* refuses at the moment of the press — TCC revoked since the last poll, or a disclosure that will not allow recording — the machine is in `listening`, the throw becomes `failure`, the table answers `error`, and the text box is live with the adapter's own sentence beside it. `pnpm demo:talk` §5 does not assert this; it types the question from `error` and gets it answered. |
| **`LiveConversationDriver.speech` became optional** (PR-032) | The panel's "Replay" bar could make recognition fail because the recogniser was `FakeSpeechInputAdapter` and had an `emitError` control. A real one fails when the platform makes it fail. Rather than keep a fake beside the real adapter purely to drive one fixture, the option is now absent on a helper build and the `stt-failure` fixture says what to do instead — `PILOT_HELPER_STUB` with `speechInput.startFailsWith`, which reaches the same state through the real code path. A dev affordance that lies about which layer failed is worse than one that is honest about needing a scripted helper. |
| **PR-034's refusal path is the attribution failure, not a denied permission** (PR-034) | The brief asked for one refusal the user can carry on past. A denied *required* permission is not that: `REQUIRED_PERMISSIONS` includes the microphone, so once the gate reports it the machine rests in `needs-permission`, where the table denies `submit-text` too — the user cannot continue by typing, and PR-008's onboarding is the only way out (which is PR-006's design, and correct). The refusal that leaves the flow usable is PR-011's verdict: every permission reads `granted`, macOS credits them to the helper, so the tap is never installed *and* the §10 conditions read `denied`, while the machine stays in `observing`. The user types the question, the tool refusal reaches the model as a typed result it can reason about, and the answer is still streamed and still spoken. It is also the plan's top structural risk, so it is the refusal most worth rehearsing. |
| **PR-034 interrupts in `speaking`, and leaves `observing-screen` to PR-035** (PR-034) | The trace's interruption is `mvp-01` §7's `speaking + new push-to-talk → listening`, which is `interruptModeFor`'s `abort` branch and behaves: the synthesiser stops, no chunk of the abandoned answer follows, the follow-up is answered on the same conversation. Interrupting *during* `observing-screen` steers the run and then submits a second one — runbook follow-up 14 — which recovers but does not do what the user asked, and fixing it is a design decision PR-027 declined to take alone. Taking it inside an integration PR whose stated job is to add no capability would have been the wrong place. |
| **An interruption aborts the model run, in every state — including while `observe_screen` is in flight** (PR-035, runbook follow-up 14) | This is the decision PR-027 recorded and PR-034 declined to take, and it is the last open design question in Phase 3. PR-006 chose `steer` for `observing-screen` so an in-flight capture could unwind rather than be torn down; PR-035 changed it to `abort` everywhere. Three things the real composition showed that the fakes could not. (a) **A steer does not end the run**, so the replacement question hit `run-already-active` and the user saw "Pilot is still working on the previous question" — the interruption did not do what they asked. (b) **The premise was backwards**: a steer leaves the tool's `AbortSignal` unfired, so the capture *completes* and its image is appended to the model's context for a question that has been replaced. Aborting is what unwinds it, because `observe_screen` checks that signal before capturing and discards a result that arrives after it. (c) **Nothing else in the table wanted `steer` either** — every teardown clears the run identity, so a steered run's output can never reach the user however long it goes on. The alternative PR-027 listed — deliver the new question *as* the steering message — was rejected because the question does not exist yet when the key goes down, because a steer carries raw text and would lose the §6 pointer anchor and the §8 envelope, and because a steered run emits no `run-started`, so the answer would be discarded as `stale-run` unless the identity guard were weakened. **Consequence worth knowing:** an interruption during an observation now costs that observation outright — Pilot does not keep the picture it was in the middle of taking. **Say if you would rather have the other answer**: it is one line in `interruptModeFor` (`packages/interaction/src/table.ts`), the `steer` mode is still on the `AgentSession` contract, and `STEER_INTERRUPTION_MESSAGE` is still exported for it. |
| **The conversation id is stable (`conv-primary`), not timestamped** (PR-036) | It was `conv-${Date.now()}`, which was harmless while nothing was persisted and is fatal now: the durable store is keyed by the conversation id, so a fresh id every launch opens a fresh, empty conversation and the transcript on disk is never read again. MVP 01 has exactly one conversation; when there are several this becomes "the one the user last had open", read from preferences. **One consequence worth knowing:** the interaction table mints a *new* `conversationId` on `clear-conversation` while the session and its store keep this one and are emptied in place, so `PilotViewState.conversationId` and `AgentSession.conversationId` differ after a clear. They always have; PR-036 is the first thing that persists either, and it persists the session's. |
| **A local endpoint's advertised context window is capped at 32 768 tokens** (PR-036, runbook follow-ups 7 and 9) | `PiAgentSession` defaults `compaction.contextWindow` to `model.contextWindow`. For a hosted model that is the provider's own number and is believed. For a *local* one it is whatever the configuration file says — a 7B model served with a stretched rope reports 128k and does not handle 128k — and §11's "context usage exceeds 60%" trigger is measured against it, so believing it means compaction never fires and the endpoint truncates the conversation instead, silently, in the middle. `main/context-window.ts` therefore caps a loopback endpoint at `docs/pi-notes.md` §9.3's 32 768, which is also the smallest value above Pi's fixed 16 384-token `shouldCompact` reserve (below it, that rule degenerates to "always compact"). **Nothing measures what an endpoint really handles** — this declines to trust a number, it does not probe. `PILOT_CONTEXT_WINDOW=65536 pnpm dev` overrides it, and PR-039 owns the real answer. **Say if you would rather trust the endpoint.** |
| **A conversation that cannot be persisted does not stop Pilot** (PR-036) | A store that will not open — a held writer lease, a full disk, a read-only volume — leaves `store: null` and Pilot runs in memory exactly as it did through PR-035, with the typed refusal shown in the panel beside a live text box. The alternative, refusing to start, would trade a working assistant for a file it does not need in order to answer a question, and it mirrors what `PiAgentSession` already does with a failed durable *write* (it swallows it and catches up on the next turn). The one case the user can act on — the SQLite writer lease — surfaces its own sentence, which is the only place in the product that says to wait 30 seconds. |
| **The composition root became an async `boot()`** (PR-036) | Opening a SQLite session is asynchronous and `PiAgentSession` takes the store *and* the restored conversation at construction, so everything from the agent onwards had to move behind an `await`. `before-quit`, `window-all-closed` and `activate` are still registered synchronously, before it, over a mutable reference — a quit that arrived while the store was opening would otherwise find no teardown handler at all and leave the writer lease behind, which is precisely the failure that makes the *next* launch fail. |
| **`clear-conversation` now reaches the session** (PR-036, runbook follow-up 21) | The command, the schema, the machine cell and the panel button all existed; the controller's effect for it was a comment reading "text persistence and session recycling belong to PR-023/PR-036". So the panel forgot and the model did not. It now calls `AgentSession.clearConversation?.()`, which is optional on the facade — a session with nothing durable behind it has nothing to delete — and which `PiAgentSession` implements by aborting anything in flight, dropping the transcript and the summary together, and reclaiming the SQLite pages so the text is gone from the file rather than merely unreachable. |
| **The Codex profile is opt-in, behind `PILOT_MODEL_PROFILE=codex`** (PR-037) | Nobody has signed in, so a build that switched to the real provider by default would answer nothing at all — and would do it after a slow failed request rather than at startup. The default stays `createDevelopmentModelSource()`. The moment the profile *is* selected, the app stops pretending: the startup line and the panel read `NOT SIGNED IN — no question can be answered until you sign in`, and every question is refused with a remedy rather than with a provider error. **Say if you would rather it be selected automatically once a credential exists** — it is one condition in `main/codex-runtime.ts`, and the reason it is not is that "Pilot silently changed which model it uses" is a surprising thing for an app to do. |
| **Pilot answers Pi's login-method prompt with `device_code` and refuses every other prompt** (PR-037, runbook amendment 7) | Pi offers both flows through a `select` prompt. The browser flow binds `127.0.0.1:1455` **before** it announces itself and does not open a browser, so a refusal that arrives at the `auth_url` event is already too late — the `select` prompt is the last moment it can be declined at all. `createCodexDeviceCodeInteraction` therefore answers that prompt and throws on every other one, including the browser flow's `manual_code`. **Consequence worth knowing:** if a future Pi release stops offering `device_code`, sign-in fails loudly instead of falling back to a flow that would take a port. |
| **The ChatGPT account id is never read, so the panel cannot say *which* account is signed in** (PR-037) | Pi decodes `chatgpt_account_id` from the access token's JWT claim and login fails without it, so it is derived from secret material. It identifies the user's account, it buys the status UI nothing that "Signed in to ChatGPT" does not, and reading it would put an account identifier into renderer state and into every diagnostic that serialises the status. **Say if you would rather see it** — it is one field on `CodexAuthStatus` and one line in the schema, and it is a privacy decision rather than an oversight. |
| **The refresh token lives in its own file, in its own directory** (PR-037) | `~/Library/Application Support/Pilot/credentials/model-credentials.json`, `0600` in a `0700` directory, written through a temporary file and renamed, encrypted through Electron `safeStorage` where the platform provides it. Not beside `conversations/`, because §1 step 16 (3) promises the user can delete their conversation history without losing anything else — and the mirror of that promise is that signing out must not delete a conversation. Signing out **removes the file** rather than emptying it. **Where the platform has no `safeStorage` the file is plaintext and the panel says so** ("On this Mac, NOT encrypted") rather than staying silent. |
| **A Codex profile asserts `supportsTools: true`; nothing verified it** (PR-037) | Pi carries no tool metadata for any model (`docs/pi-notes.md` §6.3), so this is Pilot's own claim, recorded as `'verified'` because it was set deliberately rather than defaulted. The reasoning is that every model in this catalogue is a Codex *Responses* model and the Responses API is a tool-calling API. **If the first real session shows `observe_screen` being rejected or ignored, the honest setting is `false`** and the profile falls back to the degraded, labelled mode of system-design §12 — §2 step 19 asks for exactly that observation. |
| **The model is picked for Pilot, not chosen by the user** (PR-037) | `gpt-5.5` first, then the rest of the vision-capable catalogue in a recorded preference order; `gpt-5.3-codex-spark` is never picked because it is text-only and the capability gate would refuse it. There is no model picker in the panel — PR-038 and PR-039 own configuration UI, and adding a third one here while both are in flight would have collided in the same files three ways. `PILOT_CODEX_MODEL=gpt-5.4 pnpm dev` overrides it. **Say if you would rather choose per conversation.** |
| **The demo is `pnpm demo:flow`, and it derives its own claims** (PR-034) | Named for what it is (the whole flow) rather than for the PR, beside `demo:observe` / `demo:look` / `demo:ask` / `demo:talk` / `demo:speak`. Two things it deliberately does not do: it does not narrate which state transitions it took — it reads them back out of the recorded `PilotViewState` path, because a demo that describes itself proves nothing — and it does not assert wall-clock numbers, which runbook cross-lane issue 7 is about. |
| **No secure storage means no storage at all** (PR-038) | When `safeStorage.isEncryptionAvailable()` is false — a Mac with a locked login Keychain, or any build outside Electron — `createEncryptedCredentialStore` *rejects* the write with `platform-unavailable` and Pilot keeps no key. The alternatives were a plaintext file (which is the one thing system-design §13's "never logged, never persisted in plaintext" rule exists to prevent) and a silent in-memory key that vanishes on quit (which looks like working software until the user relaunches). The key can still be supplied through `PILOT_API_KEY` for a single session, and the panel says the profile is not stored. **Say if you would rather it kept an in-memory key for the session and said so** — it is one branch. |
| **`PILOT_API_KEY` is deleted from `process.env` after it is read** (PR-038) | `openApiKeyProfileRuntime` runs in `boot()` before `platform.start()` spawns the native helper, and a child process inherits its parent's environment. Removing the variable means the helper — and any future child, and any crash reporter that dumps the environment — never sees it. It affects only this process; the user's shell is untouched. Cost worth knowing: a `process.env` reader later in the same run will not find it, which is the point. |
| **A wrong key is *not* deleted when the provider rejects it** (PR-038) | An invalid-key failure moves the profile to `invalid-key` and stops it being used, but the stored credential stays until the user replaces it. Providers return 401 for reasons that are not "your key is wrong" — a suspended account, a regional block, a bad clock — and deleting a key the user may have to paste from a password manager on the strength of one HTTP status is not a trade Pilot should make silently. The remedy string says so. **Say if you would rather a rejection wiped the key.** |
| **The capability probe spends one real provider request** (PR-038) | Tool support cannot be looked up — Pi's `Model` carries no tool metadata at all (`docs/pi-notes.md` §6.3) — so the only honest way to reach `toolSupport: 'verified'` is to offer a tool and see whether the model calls it. That costs one text-only request (a fixed sentence, no user or screen content) per verification, and a verification happens on selection, on a key change, and at launch. On a metered API that is a real, if tiny, cost. The alternative is the `'assumed'` default every profile carried before PR-038, which is how a user ends up with a confident answer about a screen the model never saw. **Say if you would rather the probe were opt-in.** |
| **The profile is configured through the environment, not a settings window** (PR-038) | MVP 01's panel is a conversation surface and has no settings screen; `docs/product-spec.md` does not ask for one. `PILOT_MODEL_PROFILE` / `PILOT_API_PROVIDER` / `PILOT_API_MODEL` / `PILOT_API_KEY` are read **once** and the result persists, so the second launch needs no environment at all — the same shape as every other fixture switch in this app. A settings UI later calls `ApiKeyProfileManager.choose/saveKey/verify/forgetKey`, which are already the whole API. |
| **No vendor SDK is bundled** (PR-038) | Measured rather than assumed: wiring `loadBuiltinApiKeyProviders()` into `main/api-key-runtime.ts` took `dist/main/index.js` from **1.66 MB to 5.97 MB**, because `electron.vite.config.ts` sets `ssr.noExternal: true` and `inlineDynamicImports: true`, so Pi's 38 built-in providers drag the Anthropic, OpenAI, Google, Mistral and Bedrock SDKs in whether or not anyone uses them. The function stays exported; the composition root does not call it. Which vendors ship is PR-042's decision, and `docs/handoff.md` §1 step 20 (b) is the one-line change that tries one before then. |
| **The composition root now has one command route, and the menu bar item uses it** (PR-041) | `main/index.ts` has always called its `dispatchCommand` "the one way a command reaches the machine, whatever dispatched it", and it was not: `DesktopShell.dispatch` — the menu bar item's Pause, and the renderer's `pilot:interaction/dispatch` channel — went straight to the controller. That was free until PR-040 made the system-design §13 retention occasion an *armed* fact, at which point **a pause from the menu bar cleared its buffers under whichever occasion happened to be armed last** — `observation-disabled` at best, and `screen-lock` or `permission-loss` after one of those. The audit reads that log, so it was reading a lie. The fix is an additive optional `DesktopShellOptions.dispatch` (every existing caller and test is untouched) plus `retentionEventForCommand` beside PR-040's `retentionEventForFeed`, so the mapping exists once. **Nothing about what is cleared changed** — every occasion clears everything — only the name in the retention log, which is the whole of what an audit of §13 can read. |
| **A base URL is shown without its user information, everywhere a person reads it** (PR-041) | `PILOT_LOCAL_BASE_URL=http://user:token@host/v1` is a realistic configuration (a proxy in front of Ollama; PR-039's own `endpoint-not-openai-compatible` diagnosis mentions one) and the credential in it reached **two log fields, the `PROBLEM …` sentence the panel renders, and — through `AgentRuntimeOptions.blockedBy`, whose refusal answers *every* question with that sentence — the durable transcript on disk.** `@pilot/shared`'s redactor never saw it: it matches on the key *name*, and `endpoint`, `line`, `reason` and `userMessage` are none of its patterns. `scrubUrlCredentials` (new, additive, in `@pilot/shared`) is now applied wherever an address is formatted for a human — including to **a library's own error text**, because Node's `fetch` refuses a credentialed URL and reports it by quoting the whole URL back. What you lose: an address printed as `http://***@127.0.0.1:11434/v1` is one step further from the string the user typed. The value used to *build requests* is untouched, because stripping a credential the user configured would silently change where Pilot connects. |
| **The `retention clear` log line's field names changed** (PR-041) | It was emitting `clearedFrames: "[redacted:image]"`, `clearedPointerSamples: "[redacted:audio]"` and `imageCacheCleared: "[redacted:image]"` — three of six fields, and the three that are the evidence the buffers were emptied, in the one line an audit of §13 reads and the one `docs/handoff.md` §1 step 21 (g) asks you to send back from a real logout. `@pilot/shared`'s redactor matches on the key *name*, and `frames`, `samples` and `image` are all patterns; it had been shipping since PR-017 and `failure-demo.ts` had a comment about it rather than a fix. The line now reads `ringEntriesCleared`, `clearedBytes`, `pointerReadingsCleared` and `decodedCacheDropped`. **`RetentionClearReport`'s own field names are unchanged** — they are read by demos and by the diagnostics view and never pass through the redactor — so this is a change to what a log line looks like and to nothing else. If you have a log filter or a grep for `clearedFrames`, it needs updating. |

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
| Phase 3 — integration (028…036) | In progress. **PR-032 is merged: voice enters the conversation.** Holding the push-to-talk key opens a real recogniser, the live transcript grows partial by partial in the panel, releasing the key submits what was heard as the question, and the utterance's key-down/key-up instants reach PR-031's anchor — so `pointerSampleCount`, `pointerCrossedWindowBorder` and `sceneRevisedDuringUtterance` stop being degenerate with no change to the anchoring code. Voice is gated on PR-011's attribution verdict, and the §16 text box is proved reachable in every failure mode (dead tap, denied microphone, refused attribution, unavailable shortcut). **No key has ever been pressed and no audio has ever been recorded** (§1 step 12): every key transition and every transcript comes from the Node helper stub. Speech *output*, persistence and the model itself are still fake. |
| Phase 3 — integration (028…036) | In progress. **PR-033 is merged: the voice loop is closed.** Pilot now answers out loud — the streamed answer is spoken sentence by sentence through `MacSpeechOutputAdapter` while its text fills the panel, and every platform adapter in system-design §5 is finally the real one. The silent stand-in is deleted. The property that took the work is §16's: a synthesiser failure costs the sound and never the answer, because the interaction table's `speech-failed` row aborts the run that is still writing it — so `main/speech-runtime.ts` turns every synthesiser failure into silence and the turn completes exactly as it would have. `createTimeoutScheduler()` is passed at last, so a model that goes quiet mid-sentence speaks what it already had. **Nothing has ever been spoken aloud** (§1 step 13): no `AVSpeechSynthesizer`, no voice, no audio device, and every speech callback in every test is the Node helper stub. Persistence and the model itself are still fake. |
| Phase 3 — integration (028…036) | In progress. **PR-034 is merged: the MVP scenario runs as one trace.** `pnpm demo:flow` walks `docs/mvp-01-point-ask-hear.md` §2 through the shipping composition — window selected, pointer anchored at the question, spoken question transcribed, model calls `observe_screen`, policy-checked image returned, answer streamed into the panel and spoken sentence by sentence, then interrupted mid-answer by a second press and a follow-up answered on the same conversation. The §7 rows it walked are read back out of the recorded view-state path, and six invariants are checked on that same trace (selected-window-only, the capability gate, no image bytes to a log line or to disk, no accessibility target outside the selected window, the unknown-pointer sentinel, the §16 text fallback). **No boundary was replaced and no defect was found** — the pieces compose. What it does *not* establish is unchanged and is printed in the demo's own section 4: against the Node helper stub and a scripted faux provider it evidences A-01, A-03, A-08, A-11 and A-14 only in part, and the other ten not at all (§1 step 14, §2). |
| Phase 3 — integration (028…036) | In progress. **PR-035 is merged: interruption works in the states where it is hard, and Phase 3 has no open design question left.** `pnpm demo:interrupt-flow` interrupts a screen observation with a capture genuinely in flight, twice in quick succession, and in the window between an answer and its first spoken word — reading the result off the panel's own view stream, the `speech.output.speak` operations that crossed the framed wire, and the rejection stream. It closes runbook follow-up 14 by **aborting rather than steering**, which is a decision the user can reverse in one line (§4). No boundary was replaced and no defect was found; what it did find is that the identity guard is what keeps a `run-failed` from an interrupted tool call out of the user's face (runbook cross-lane issue 17). Its own limit is one sentence long: **no sound has ever been stopped, because no sound has ever been made** — the §17 number here is Pilot's half of the budget and is measured as a JSON round trip over a pipe (§1 step 15, §5). Persistence and the model itself are still fake. |
| Phase 3 — integration (028…036) | **COMPLETE. PR-036 is merged: the conversation now outlives the process, and stays bounded while it does.** The durable `ConversationStore` is opened, restored and closed by the app (`main/conversation-store.ts`), so a relaunch resumes the conversation the model was having; `compaction.contextWindow` comes from the profile rather than from the model's own claim (`main/context-window.ts`); the compaction counters reach PR-010's diagnostics surface; and `clear-conversation` finally reaches the session, which drops the transcript, the summary and the SQLite pages together. `pnpm demo:memory` asks nine screen questions across two scene changes and reads the result off the requests the provider received: **at most two image blocks in any request, ever**, every replacement record past-tense and scene-stamped, three compactions visible as `context-tokens-before`/`-after`, and the conversation gone from the file after a clear. It closed runbook follow-ups 7, 9, 20, 21 and 31 and found one defect nothing else could — the SQLite backend's schema file is not bundled, so **a built app started with persistence silently disabled** (cross-lane issue 19). **Nothing has ever been persisted on macOS** (§1 step 16) and **no model has ever read a replacement record** (§2): a scripted provider cannot make a stale-screen claim, so what is proved is Pilot's input to the model, not the model's output. |
| Phase 4 — providers (037…039) | **In progress. PR-037 is merged: the Codex subscription profile is in the shipping composition.** `PILOT_MODEL_PROFILE=codex` builds the real `openai-codex` provider — the real catalogue, Pi's real OAuth machinery, a real `0600` credential file encrypted through `safeStorage` where the platform has it — and `pnpm smoke` on the **built** app reports `ChatGPT subscription (openai-codex/gpt-5.5, vision+tools ok) — NOT SIGNED IN` beside `272000 tokens (model; remote endpoint advertised 272000)`, which is the first time PR-036's hosted "believe it" branch has been taken. Sign-in is device-code only and never binds port 1455; an unsupported model, a signed-out profile and an expired one are all refused **before** a run starts, so zero provider requests and zero screen observations; a failed token refresh reaches the user as a sentence they can act on rather than as `OAuth refresh failed for openai-codex`; and the panel gained a Model section with status, sign-in and sign-out. `pnpm demo:codex` walks all of it and then runs the MVP point-ask-hear flow on the profile. **Nobody has ever signed in, no token has ever existed and no request has ever left this machine** (§2 step 19): every OAuth endpoint is a recorded reproduction of Pi's own implementation. PR-038 and PR-039 remain. |
| Phase 4 — providers (037…039) | Not started. PR-037 (Codex) is the one the user's decision selects. |
| Phase 4 — providers (037…039) | In progress. **PR-038 is merged: Pilot can be configured with an API key, and it will not pretend that a configured key means a working model.** The key is sealed with Electron `safeStorage` (the macOS Keychain) into `~/Library/Application Support/Pilot/model-profile/credentials.json`, mode 600, and if `safeStorage` is unavailable Pilot stores nothing rather than falling back to plaintext. Provider and model selection read Pi's live catalogue. A four-stage capability probe decides which model is used: a text-only model is refused with **zero** provider requests, a model that will not call tools is refused after **one text-only** request, and neither ever sees an image — `CapabilityProbeOutcome.imageBlocksSent` is the literal `0` in the type. Only a probe that passed produces a `ModelSource`, so `main/index.ts` boots on the development source in every other state and logs why. An invalid key is detected both at probe time and mid-conversation, is distinguished from a rate limit and from an unreachable host, and its message is scrubbed — a 401 body that echoes the key back reaches no log, no panel and no crash dump. The panel shows where screen images go before the first question. **No API key exists in this environment, no request has ever left this machine, and `safeStorage` has never run** (§1 step 20): the vendor is `createRecordedApiKeyProvider` and the cipher is AES-256-GCM over a process-local key. No vendor SDK is bundled — measured at 1.66 MB → 5.97 MB of main bundle — so trying a real provider is the one-line change in step 20 (b), and shipping one is PR-042's. |
| Phase 5 — hardening and release (040…044) | Not started. |
| Phase 5 — hardening and release (040…044) | In progress. **PR-042 is merged: the macOS application is packaged, and the honest half of that sentence is that none of the macOS part has ever run.** What is verified on Linux: `pnpm package` produces a bundle whose asar is opened and checked eleven ways (entry points, `main` resolution, no `node_modules`, no external imports, no executable inside the archive, the CSP byte for byte, no `crossorigin`, a size budget against hazard 24, the helper as a real file that matches its manifest); the helper resolves in all three layouts, `pnpm dev` included, which it did not before; the signing hook runs on every build and declines by name; and **the packaged app starts from an empty, `launchd`-like environment** (`pnpm smoke:launch`), keeps its menu bar item, reads a launch environment file and refuses a credential written into it without printing it. What is configured and unverified: the entitlements (app and helper), the hardened runtime, the ad-hoc `codesign` invocation, the TCC usage strings, `LSMinimumSystemVersion`, `NSSupportsSuddenTermination`, the helper's embedded `Info.plist` and the `zip` target. **No `.app` has ever been produced, signed, installed or launched, and the Swift helper has still never been compiled** (§1 step 22, §1a). The finding that mattered: a Finder launch reaches the **faux** provider, because every provider selector is an environment variable — the launch file is the fix, and nothing on screen still says which model is in use (follow-up 46). |
| Phase 5 — hardening and release (040…044) | In progress. **PR-043 is merged: the acceptance matrix is now a re-runnable harness rather than a paragraph, and it reports that the gate is not met.** `pnpm acceptance` walks A-01…A-15 with a scenario per criterion — a pause, an Accessibility revocation, a Screen Recording revocation, a relaunch over a real SQLite store, a non-vision model, a twelve-turn conversation, an interruption — and derives one verdict per row from the checks that actually ran: **0 verified, 12 verified in part, 1 failed, 2 blocked**, over 45 pass-condition checks of which 30 executed here and 15 wait on a Mac or a model. The rule the PR exists for is that a criterion with no executed pass-condition check *cannot* report as passing — `not-implemented` if nothing checks it, `blocked-on-…` however much supporting evidence is green — and it is pinned by its own unit test. Thirty curated grounding cases run at **both 1× and 2×**, the first time the assembled application has run at anything but 2×, and pin what Pilot SENDS: the anchor's normalised point against the geometry module's arithmetic, the element retained or refused, the crop rectangle, whether the thing under the pointer is inside the picture the model receives, and the envelope verbatim. **The plan's 90% grounding accuracy is not computed and cannot be** — 23 of the 30 report their verdict as pending a model, which is the whole of that metric. It found two things: **A-09 fails** (losing Accessibility stops Pilot instead of degrading it — follow-up 35, now demonstrated rather than merely recorded), and the pointer crop covers ~640 pt of window at 1× but ~533 pt at 2× because `pointerCropPixels` is a constant in captured pixels (follow-up 48). §1 step 23 is the Mac-and-model half, written as a runnable procedure. |
| Phase 5 — hardening and release (040…044) | In progress. **PR-044's degraded-grounding lane is merged: the one acceptance criterion that was `failed` is fixed, and `pnpm acceptance` exits 0.** Losing Accessibility no longer stops Pilot. `REQUIRED_PERMISSIONS` is Screen Recording alone, so the interaction machine finally agrees with the permission catalogue it had been contradicting since PR-008 — the panel offered the controls, the table refused every command, and nothing said why. The model is told what it does not have rather than being left to infer it: `QuestionAnchor.targetAvailability` gains `'unavailable'` (the one `packages/` contract change) and the envelope reads `pointer target: unavailable — Accessibility is not permitted, …` with an instruction to work from the picture and to say so. Elements sampled before a revocation are dropped, and refused twice more on the way out. The user gets the disclosure that already existed plus a banner that says what got less reliable instead of announcing a stop, and granting the permission back upgrades the same session. A-09 was **widened, not weakened** — six pass conditions execute where one did. **Two of them still cannot run here**: no TCC has ever revoked anything under a running session, and no model has ever been given a picture, a point and a `reduced grounding:` line (§1 step 24). |

Last full regression on `main` (after PR-017 and PR-022a): 997 tests across 66
files, and **all twelve demos executed green** — observation, scene, policy,
interaction, envelope, voice, `observe_screen`, visual-context, permissions,
helper transport, helper permissions, and the real-Electron headless smoke.

Verification standard on every merge: `pnpm lint`, `typecheck`, `test`, `build`
re-run by the orchestrator — never taken on a subagent's word — plus each PR's
demo executed against the merged tree.
---

## 5. Risks worth watching

- **§17's 300 ms interruption budget is half-measured** (PR-035). What Linux can
  measure is the time from the interaction machine accepting `push-to-talk-down`
  to `speech.output.stop` crossing the pipe: ~1 ms, dominated by nothing.
  Everything after that is unmeasured and unexercised — the Swift helper
  dispatching to `AVSpeechSynthesizer.stopSpeaking(at:)`, the synthesiser
  draining whatever it has buffered, and the audio device going quiet. That
  second half is the whole of what a user perceives as "the voice stopped", and
  it is also where the plausible failure lives: `stopSpeaking(at: .word)` rather
  than `.immediate` would finish the current word, and a synthesiser that has
  already handed audio to the device may keep playing it. §1 step 15 is the only
  thing that can settle it, and it settles it by ear. **Do not read a green
  `pnpm demo:interrupt-flow` as "interruption meets §17".**

- **An interrupted observation is lost, not resumed** (PR-035). Following from
  the §4 decision: a push-to-talk that lands while `observe_screen` is in flight
  aborts the capture, and Pilot does not keep or retry the frame it was in the
  middle of taking. That is correct for the case the decision is about — the
  user replaced the question, so the picture was for a question nobody is asking
  any more — but it also applies to an interruption the user did not mean, such
  as a stuck key producing a spurious press. PR-015's coalescing is what keeps
  that from happening and it has never run against a real `CGEventTap`.

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

- **Push-to-talk may need a permission Pilot does not model** (PR-032). The
  whole feature rests on a `CGEventTap`, and PR-015 assumes Accessibility is
  what macOS asks for. Recent macOS also gates keyboard taps behind **Input
  Monitoring**, which appears nowhere in `docs/system-design.md` §4, in
  `PermissionKind`, in PR-008's onboarding, or in PR-042's entitlements. If §1
  step 12 item 1 comes back `unavailable/permission-missing` *after*
  Accessibility has been granted, that is the answer, and the fix touches four
  places rather than one. Nothing here can settle it: no `CGEventTap` has ever
  been created. The failure is at least loud rather than silent — the shortcut
  reports itself unavailable with a sentence and the text box stays live — so a
  user is never left holding a key that does nothing.

- **A silent Pilot and a broken Pilot look identical to the user** (PR-033).
  §16 is now honoured to the letter: a synthesiser that fails, a Mac with no
  installed voice and a build with no helper all end the same way — the answer
  on screen, complete, and nothing heard. The failure is counted and logged
  (`desktop.main.speech-out`), but nothing in the panel says "Pilot could not
  speak that". On a Mac with no English voice installed, or after a helper
  crash, the user's experience is a product that simply stopped talking. The
  decision and the one-line question it raises are in §4; §1 step 13 item 1 is
  what tells us whether the case is real on the user's Mac at all.

- **Gapless playback is an assumption, not a measurement** (PR-014/PR-033). An
  answer is several utterances handed one after another to
  `AVSpeechSynthesizer`'s own queue, on the theory that the platform joins them
  seamlessly and Pilot never has to time anything. If it does not, an answer
  will be spoken with audible seams between sentences, and the fix is a queueing
  change in the adapter rather than in the wiring. Nothing on Linux can hear it;
  §1 step 13 item 2 is the only way to know.

- **Whether a real recogniser returns partials at all** (PR-032). The live
  transcript is what makes holding a key feel like anything, and every partial
  in every test here is a string the stub was handed. Apple Speech returns
  partials for some locales and effectively not for others, and Pilot's own
  60 ms drain adds latency on top. If §1 step 12 item 4 shows the panel filling
  in only at the end, the feature still *works* — the accepted transcript is
  what becomes the question — but it will feel broken while the key is held,
  and that is a product problem rather than a bug.

- **Right Option is a live dead-key modifier on some keyboard layouts**
  (PR-015, now reachable). PR-015 chose it because it types nothing on US
  layouts; on several others it composes accented characters. Nothing here can
  test it. §1 step 12 item 3 asks for it explicitly, and if it inserts
  characters in another application the default binding has to change — which
  is a one-line change plus a settings surface that does not exist yet.

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
