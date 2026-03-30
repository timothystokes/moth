# Copilot Instructions for MOTH1

## Project Overview
MOTH1 is a web-based modular synthesiser built with **React 18** and **Vite**, running entirely in the browser. It models analog-style signal routing between modules (oscillators, filters, envelopes, etc.) using a pseudo-voltage signal model.

## Tech Stack
- **Language:** JavaScript (no TypeScript)
- **Framework:** React 18
- **Build Tool:** Vite
- **Key Dependencies:** `react`, `react-dom`, `midi-file`
- Node.js is only used for dev tooling

## Engineering Rules
- **Never swallow an error.** Always surface errors visibly.
- If a track or module produces invalid runtime audio data, report it through the UI-visible error/diagnostic path and **stop the active sequence** rather than continuing playback silently.

## Signal Model
All inter-module signals are pseudo-voltages evaluated as pure functions:
- **Pitch CV:** 1V/octave, A4 / MIDI 69 = 0V
- **Audio:** ±10V
- **Gate:** 0V (off) / +5V (on)
- **Velocity:** 0–1

All audio processing functions follow the signature: `(timeMs, voiceContext) => outputValue`
- `voiceContext`: `{ noteNumber, cv, gate, velocity, voiceId }` for voice-dependent graphs, or `null` for global evaluation

## Architecture Conventions

### Audio Engine (`audioEngine.js`)
- Modules register via `registerModule(id, module)` — definitions must be serializable for the AudioWorklet
- Connections map `fromModuleId → toModuleId.inputName`
- Per-frame output caching uses `${voiceId|global}|${moduleId}` keys, cleared each sample
- If a connection's source module no longer exists, the destination falls back to its slider/default — do not throw

### Polyphonic Voices (`voiceAllocator.js`)
- Pool of 8 voices (`MAX_VOICES`)
- States: `FREE`, `ACTIVE` (gate > 0), `RELEASE` (gate = 0, still sounding)
- Voice assignment uses a **strict cyclic ring** — always advance to the next slot, regardless of free/release state
- `getActiveVoices()` returns `ACTIVE` and `RELEASE` voices only
- Keyboard latch mode reserves voice 1 as a default always-on control voice when gate is unpatched

### Module Input Fallback
- Unpatched inputs fall back to their slider/default values exactly as if nothing is connected
- Voice context propagates **only** when the patched graph depends on keyboard CV/gate upstream
- Modules without CV/gate connections must remain controlled solely by sliders

### Oscillator Specifics
- Shape blends: square (0) → sine (0.5) → triangle (1)
- Frequency defaults to A4 = 440 Hz; FREQ input is a **relative exponential pitch offset**
- Amplitude input uses value-range detection: 0–5V → VCA multiply; outside 0–5V → additive CV offset
- Duty cycle clamped to 2%–98%, applied on peak/trough-aligned phase boundaries

### Envelope Generator
- Requires a dedicated `GATE IN` socket
- Attack/Decay/Release use logarithmic time sliders with relative exponential CV nudges
- Sustain uses a 0–1 slider with additive CV offset
- Output: 0–5V
- Released voices remain active until their envelope reaches silence (do not cut abruptly)

### MIDI File Transport
- Parsed in the browser using `midi-file`
- Tempo changes must be respected when converting ticks → milliseconds
- Playback routes through the same note-on/note-off path as live keyboard/MIDI input
- Changing selected MIDI channel stops playback, rewinds, and swaps the active event list

## UI Conventions

### Layout
- **Left panel** (200px, fixed): Keyboard singleton
- **Centre canvas** (flex-grow): draggable modules on a grid
- **Right panel** (200px, fixed): Amplifier singleton
- **Toolbar** (top, 50px): module-add buttons + power button
- **Transport** (bottom, 78px): MIDI file controls + metadata

### Modules & Dragging
- Modules have a **banner bar** for drag initiation; controls below the banner must not trigger drag
- Drag is implemented with `onMouseDown` on the banner + global `mousemove`/`mouseup` — **do not use the HTML5 drag API** (no ghost images)
- Drag coordinates account for canvas offset via `getBoundingClientRect()`

### Ports & Connections
- Ports are 16px squares, protruding from module edges
- Inputs on the left (red border), outputs on the right (blue border), green when a connection is in progress
- Ports align horizontally with their corresponding sliders and share the same label
- Each port supports **only one connection**; clicking a connected port removes the existing connection before starting a new one
- Clicking the canvas background cancels an in-progress connection
- Connections render as SVG bezier curves in a fixed-position overlay (`z-index: 9999`, `pointer-events: none`)
- Port positions are calculated live from the DOM via `getBoundingClientRect()` and normalised to the main content area

### Sliders
- When unconnected: slider value is shown as text in the label
- When connected: only the parameter name is shown (no value)
- Sliders do not visually respond to incoming CV — they act as offsets/multipliers
- Oscillator frequency range goes down to 0.1 Hz (doubles as an LFO)
- Random generator rate uses the same logarithmic mapping as oscillator frequency
