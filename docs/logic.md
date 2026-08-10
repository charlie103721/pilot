# Pilot Logical Blocks and Connections

Status: Draft 0.1
Last updated: 2026-08-10

## Logical architecture

```mermaid
flowchart LR
    USER["User"]
    WINDOW["Selected Window"]

    subgraph DESKTOP["Desktop Experience — apps/desktop"]
        UI["UI<br/>window picker, settings,<br/>conversation and status"]
    end

    subgraph INTERACTION["Voice and Interaction — packages/interaction"]
        CONTROL["Interaction Controller<br/>push-to-talk and state"]
        VOICE["STT and TTS Pipeline"]
    end

    subgraph AGENT["Agent Runtime — packages/agent-runtime"]
        SESSION["Pi Native Session"]
        TOOL["observe_screen Tool"]
        MEMORY["Context Pruning<br/>and Compaction"]
        PROFILE["Model Profile<br/>and Authentication"]
    end

    subgraph OBSERVATION["Observation Engine — packages/observation"]
        BUFFER["Local Frame Buffer"]
        POINTER["Pointer and Scene State"]
        POLICY["Screen Policy"]
        PROCESSOR["Frame Selector<br/>crop, redact and encode"]
    end

    subgraph PLATFORM["macOS Platform — packages/platform-mac"]
        CAPTURE["ScreenCaptureKit"]
        AX["Accessibility API"]
        NATIVEVOICE["Native Speech APIs"]
        PERMISSION["Permissions and Keychain"]
    end

    LLM["Cloud or Local LLM"]

    CONTRACTS["Shared Contracts<br/>packages/platform + packages/shared"]

    USER -->|"select, point, speak"| UI
    UI -->|"commands"| CONTROL

    CONTROL -->|"start microphone"| VOICE
    VOICE -->|"transcript"| CONTROL
    CONTROL -->|"QuestionEnvelope"| SESSION

    PROFILE -->|"model and credentials"| SESSION
    SESSION -->|"prompt, history and tools"| LLM
    LLM -->|"text response or tool call"| SESSION

    SESSION -.->|"observe_screen request"| TOOL
    TOOL -.->|"view and moment"| POLICY
    POLICY --> PROCESSOR

    WINDOW -->|"screen content"| CAPTURE
    WINDOW -->|"pointer target"| AX
    CAPTURE -->|"frames at 2–3 FPS"| BUFFER
    AX -->|"coordinates and UI element"| POINTER

    BUFFER --> PROCESSOR
    POINTER --> PROCESSOR
    PROCESSOR -.->|"image and metadata"| TOOL
    TOOL -.->|"image tool result"| SESSION

    SESSION <--> MEMORY
    MEMORY -->|"bounded model context"| LLM

    SESSION -->|"streamed text and events"| CONTROL
    CONTROL -->|"sentence chunks"| VOICE
    VOICE --> NATIVEVOICE
    NATIVEVOICE -->|"spoken answer"| USER
    CONTROL -->|"state and transcript"| UI

    PERMISSION --> CAPTURE
    PERMISSION --> AX
    PERMISSION --> NATIVEVOICE

    CONTRACTS -.-> UI
    CONTRACTS -.-> CONTROL
    CONTRACTS -.-> SESSION
    CONTRACTS -.-> POLICY
    CONTRACTS -.-> CAPTURE
```

## Connection meaning

- Solid arrows represent normal runtime connections and data flow.
- Dotted arrows represent the on-demand screen observation path initiated by the LLM.
- Continuous capture flows only from the selected window into the local frame buffer.
- Background frames are not sent automatically to the model.
- The model receives screen pixels only after it calls `observe_screen` and the screen policy approves the request.
- Shared contracts define the boundaries between independently owned feature blocks.

## Block connections

| From | To | Connection |
| --- | --- | --- |
| Desktop Experience | Interaction Controller | User commands and UI actions |
| Interaction Controller | Pi Native Session | `QuestionEnvelope` |
| Pi Native Session | Configured LLM | Prompt, conversation history, and tool definitions |
| Configured LLM | Pi Native Session | Text deltas or tool calls |
| Pi Native Session | `observe_screen` | Tool invocation |
| `observe_screen` | Screen Policy | Requested view and moment |
| macOS Platform | Observation Engine | Frames, pointer coordinates, and accessibility target |
| Observation Engine | `observe_screen` | Policy-approved image and metadata |
| Pi Native Session | Interaction Controller | Response stream and lifecycle events |
| Interaction Controller | Native Speech | Speakable sentence chunks |
| Interaction Controller | Desktop Experience | State, transcript, response, and errors |

## Security boundary

Only the Observation Engine can access raw captured frames through the Platform Adapter. The Agent Runtime receives images exclusively through the policy-controlled `observe_screen` tool. The renderer never receives provider credentials or unrestricted native capture handles.
