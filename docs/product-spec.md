# Pilot Product Specification

Status: Draft 0.1
Last updated: 2026-08-10

## 1. Product summary

Pilot is a cross-platform desktop assistant that can understand the window a user is looking at, follow the user's mouse pointer, accept spoken questions, and answer aloud. It is designed as a model-independent alternative to single-provider screen assistants: users choose their model and authentication method, while Pilot controls what screen content is captured, sent, retained, and discarded.

The macOS application is the first release. The architecture must support a Windows implementation without changing the agent, conversation, or product layers.

## 2. Problem

Users frequently need help with information already visible on their screen. Existing assistants often require screenshots, copied text, browser-only access, or a specific model subscription. They also provide limited control over capture scope, retention, and provider choice.

Pilot should make the interaction natural:

1. Select a window for Pilot to observe.
2. Point at something with the mouse.
3. Ask a spoken question such as “What does this mean?”
4. Hear a grounded spoken answer.

The user should not need to manually take a screenshot, upload a file, start a local server, or run a second visible application.

## 3. Product goals

- Make pointing and asking feel immediate and reliable.
- Ground ambiguous words such as “this”, “that”, and “here” in the pointer location and UI element.
- Let the LLM decide when visual evidence is needed through an `observe_screen` tool.
- Keep continuous capture local and transmit screen content only on demand.
- Support user-configured cloud subscriptions, API keys, and local models when the selected model has the required capabilities.
- Preserve conversational continuity without accumulating every screenshot in model context.
- Provide clear privacy controls and visible observation state.
- Ship a stable macOS MVP while preserving a clean path to Windows.

## 4. Non-goals for the MVP

- Autonomous clicking, typing, or destructive computer control.
- Whole-desktop surveillance or capture of every display.
- Always-on microphone or wake-word detection.
- Long-term storage or search over screenshot history.
- Mobile, Linux, or browser-extension releases.
- Multi-user collaboration or cloud-hosted conversation synchronization.
- Perfect understanding of applications that block capture or expose no accessibility information.

## 5. Target users and jobs

### Primary users

- People learning unfamiliar software.
- Professionals interpreting dashboards, forms, settings, and errors.
- Users who prefer voice interaction or need hands-free assistance.
- Technical users who want control over the model provider and privacy boundary.

### Core jobs

- “Explain the item I am pointing at.”
- “Tell me what is wrong on this screen.”
- “Summarize this window.”
- “Compare what was visible before and after a change.”
- “Continue explaining the same screen without making me provide it repeatedly.”

## 6. Product principles

1. **User-visible observation:** Pilot must always indicate when window observation or microphone capture is active.
2. **Selected-window scope:** The MVP observes only the window explicitly selected by the user.
3. **Local by default:** Background frames remain in memory on the device and expire automatically.
4. **Model-requested vision:** The LLM chooses when to call `observe_screen`; the application enforces capture and retention policy.
5. **Freshness over memory:** Current screen evidence is authoritative. Conversation memory must not override a changed screen.
6. **Provider independence:** Product behavior must not depend on one model vendor's proprietary conversation state.
7. **Graceful degradation:** If vision or accessibility data is unavailable, Pilot explains the limitation instead of guessing.

## 7. MVP user experience

### 7.1 First launch

1. Pilot explains why Screen Recording, Accessibility, and Microphone permissions are required.
2. The user grants permissions through macOS System Settings.
3. The user selects or signs in to a supported model provider.
4. Pilot confirms that the chosen model supports vision and tool calling.

### 7.2 Start observing

1. The user opens Pilot from the menu bar or app window.
2. The user chooses a currently visible application window.
3. A persistent indicator shows the selected application and observation status.
4. Pilot begins a low-rate, memory-only capture buffer for that window.

### 7.3 Ask about the screen

1. The user points at a visual target.
2. The user holds a configurable push-to-talk shortcut.
3. Pilot anchors the pointer, accessibility target, and screen frame to the utterance timeline.
4. Speech-to-text produces the transcript.
5. The transcript and lightweight scene metadata enter the active Pi agent session.
6. The LLM either answers from existing context or calls `observe_screen`.
7. The tool returns the requested pointer crop, full window, or comparison frames.
8. The answer streams into text-to-speech.

### 7.4 Continue or interrupt

- Follow-up questions reuse the same conversation session.
- Speaking while Pilot is answering stops speech output and steers or aborts the active response.
- Switching the selected window increments the scene revision and invalidates stale visual assumptions.
- The user can pause all observation immediately from the menu bar or global shortcut.

## 8. Functional requirements

### Window observation

- FR-01: List capturable windows and allow the user to select exactly one.
- FR-02: Display the selected application's name and observation status.
- FR-03: Maintain a low-rate local ring buffer while observation is enabled.
- FR-04: Stop and clear the buffer when paused, the selected window closes, or the screen locks.
- FR-05: Never transmit frames simply because they were captured.

### Pointer grounding

- FR-06: Record pointer coordinates with timestamps during an utterance.
- FR-07: Express pointer position in normalized selected-window coordinates.
- FR-08: Retrieve the accessibility element under the pointer when available.
- FR-09: Add a visible marker to images sent to the model.
- FR-10: Provide a crop around the pointer independently of the full-window frame.

### Voice interaction

- FR-11: Support push-to-talk with configurable shortcut.
- FR-12: Show listening, thinking, and speaking states.
- FR-13: Stream complete sentence fragments to text-to-speech.
- FR-14: Stop speech promptly when the user interrupts.
- FR-15: Allow text input as a fallback to voice.

### Agent and models

- FR-16: Use Pi Agent Core for the agent loop, tool calling, streaming, and conversation state.
- FR-17: Use Pi's provider layer for model configuration and authentication.
- FR-18: Expose `observe_screen` as an agent tool with `view` and `moment` parameters.
- FR-19: Detect whether the configured model supports image input and tool calling.
- FR-20: Support at least one subscription-authenticated provider, one API-key provider, and one local OpenAI-compatible endpoint before general release.
- FR-21: Keep provider-specific logic out of screen and interaction components.

### Context management

- FR-22: Retain recent conversation text and a compacted summary of older turns.
- FR-23: Keep only the newest relevant full frame and pointer crop in active model context during ordinary use.
- FR-24: Keep two frames temporarily when comparison is explicitly requested.
- FR-25: Replace obsolete image content with text summaries or placeholders.
- FR-26: Re-capture current screen state when resuming a persisted conversation.

### Privacy and controls

- FR-27: Provide a persistent capture indicator and immediate pause control.
- FR-28: Keep the rolling frame buffer in memory and never persist it by default.
- FR-29: Redact known secure text fields when accessibility metadata identifies them.
- FR-30: Clearly preview which window is selected before observation starts.
- FR-31: Store credentials using the operating system's secure credential storage.

## 9. Screen context policy

Pilot separates two decisions:

- The LLM decides whether it needs to observe and requests a view through a tool call.
- Pilot decides what may be captured, transformed, returned, retained, and discarded.

Initial policy:

| Concern | MVP policy |
| --- | --- |
| Background capture | Selected window, 2–3 FPS, only while observing |
| Local history | Last 2–3 seconds in memory |
| Full-frame size | Maximum 1440 px on longest edge |
| Pointer crop | Approximately 640 × 640 px, bounded to the frame |
| Encoding | JPEG around 75% quality unless text clarity requires PNG |
| Active full frames | One, except comparison mode |
| Active pointer crops | One or two most relevant |
| Comparison mode | Previous and current frames only |
| Persistent screenshots | Disabled by default |
| Sensitive content | Redact known secure fields; warn that visual secrets may remain |

## 10. Model configuration

Users configure a model profile containing:

- Provider and model.
- Authentication method: supported subscription sign-in, API key, or local endpoint.
- Optional base URL and headers for compatible endpoints.
- Vision and tool-use capability status.
- Thinking/reasoning level when supported.
- Optional local-only preference that prevents remote provider selection.

Pilot must not promise that every consumer subscription can be used. Authentication options are shown only when supported by the pinned Pi provider version and verified during sign-in.

## 11. Non-functional requirements

- NFR-01: Target first visible text within 2.5 seconds after transcription for typical cloud models, excluding provider outages.
- NFR-02: Begin spoken output as soon as the first complete sentence is available.
- NFR-03: Target interruption-to-speech-stop latency below 300 ms.
- NFR-04: Background observation should remain low impact during normal desktop use.
- NFR-05: A capture or accessibility failure must not crash the agent session.
- NFR-06: Raw frame memory must be bounded and cleared deterministically.
- NFR-07: Platform-specific code must be accessed only through defined adapters.
- NFR-08: Pin Pi package versions and test upgrades before release.
- NFR-09: Logs must exclude image bytes, transcripts when private logging is enabled, and credentials.

## 12. MVP acceptance criteria

- A user can install one signed macOS app and grant required permissions.
- A user can select a window, point at an element, ask “What is this?”, and hear a grounded response.
- Pilot correctly associates the final or dominant pointer target with the utterance in at least 90% of a curated static-UI test set.
- No screen image is transmitted until the agent calls `observe_screen`.
- Pausing observation immediately stops capture and clears the local frame buffer.
- Follow-up questions maintain conversational continuity without retaining an unbounded image history.
- The user can interrupt spoken output and ask a new question.
- At least one local vision model can be configured without starting a separate user-visible Pilot service.

## 13. Post-MVP candidates

- Windows platform adapter.
- Voice activity detection and optional wake word.
- Safe, confirm-before-execution computer actions.
- Region and multi-window observation.
- OCR fallback and richer accessibility-tree summaries.
- User-configurable retention profiles.
- Per-application capture exclusions and redaction rules.
- Model routing based on privacy, speed, and capability.

## 14. Open questions

- Which macOS versions are supported at launch?
- Which provider authentication flows will be enabled in the first build?
- Should persistent sessions retain user-approved screenshots as attachments?
- How should Pilot display provider cost and context usage?
- Should push-to-talk anchor to button-down, button-up, pointer dwell, or a combination?
- What capture behavior is expected when the selected window is minimized or covered?
