# Copilot Instructions for MOTH1

## Project Overview
MOTH1 is a web-based modular synthesiser built with **React 18** and **Vite**, running entirely in the browser. It models analog-style signal routing between modules (oscillators, filters, envelopes, etc.) using a pseudo-voltage signal model and a polyphonic voice engine running in an AudioWorklet.

## Tech Stack
- **Language:** JavaScript (no TypeScript)
- **Framework:** React 18
- **Build Tool:** Vite
- **Key Dependencies:** `react`, `react-dom`, `midi-file`
- Node.js is only used for dev tooling

## Engineering Rules
- **Never swallow an error.** Always surface errors visibly.
- If a track or module produces invalid runtime audio data, report it through the UI-visible error/diagnostic path and **stop the active sequence** rather than continuing playback silently.

---

## Signal Model
All inter-module signals are pseudo-voltages evaluated as pure functions:
- **Pitch CV:** 1V/octave, A4 / MIDI 69 = 0V
- **Audio:** ±1V (oscillator output is `amplitude × wave` where wave ∈ [−1, +1])
- **Gate:** 0V (off) / +5V (on)
- **Velocity:** 0–5V (scaled from 0–1 input velocity × GATE_HIGH_VOLTAGE)
- **Envelope output:** 0–5V

All audio processing functions follow the signature: `(timeMs, laneContext) => outputValue`
- `laneContext`: `{ noteNumber, cv, gate, velocity, voiceId, state }` for voice-dependent graphs, or `null` for global evaluation.

---

## Audio Engine File Structure

| File | Role |
|---|---|
| `audioEngine.js` | Public API: registerModule, connectModules, noteOn/noteOff, etc. Mirrors state into the AudioWorklet. |
| `moth-synth-worklet.js` | AudioWorklet processor. Evaluates the module graph sample-by-sample per voice. |
| `sequencer.js` | Lean stateful playback engine: play, stop, rewind, seekTo, loadSession, importMidiFile. Barrel re-exports all public API from utility modules. |
| `noteUtils.js` | Pure utilities: CHROMATIC_SCALE, quantizeToGrid, absoluteBeatToBarBeat, barBeatToAbsoluteBeat, midiToNoteName, noteNameToMidi, getEventPriority. |
| `trackMigration.js` | Converts legacy sequence+arrangement format to flat notes[]. |
| `midiConvert.js` | All MIDI parsing: buildNotesFromMidiEvents, buildNoteSegments, convertMidiToSession. Uses `midi-file` npm package. |
| `voiceAllocator.js` | Polyphonic voice pool management. |
| `synthConstants.js` | Shared constants. |

---

## Song / Session Data Model

### Top-level session structure
```json
{
  "version": 1,
  "sequence": { "bpm": 120, "timeSignatures": [...], "tempoMap": [] },
  "tracks": [...],
  "durationMs": 128000
}
```

### Track structure
```json
{
  "id": "track-id",
  "name": "Track Name",
  "durationMs": 128000,
  "mix": { "volume": 0.8, "mute": false },
  "notes": [ { "note": "F4", "bar": 1, "beat": 1.0, "duration": 0.75, "velocity": 0.82 } ],
  "modules": [...],
  "connections": [...]
}
```

### Note format
- `note`: note name string (e.g. `"F4"`, `"Gs4"`)
- `bar`: 1-indexed bar number
- `beat`: 1-indexed beat within bar (e.g. `1.0`, `1.5`, `2.75`), on 0.25 grid
- `duration`: duration in beats (e.g. `0.25`, `0.5`, `1.0`)
- `velocity`: float 0–1

### noteSegments
Computed on `loadSession`, stripped on save (derived data):
```json
{ "noteNumber": 65, "startMs": 0, "endMs": 375 }
```
TrackRow renders these as the mini piano-roll in the transport strip.

---

## Module Types

### Keyboard (singleton, fixed left panel)
- Type IDs registered per track: `{trackId}:keyboard-cv`, `{trackId}:keyboard-gate`, `{trackId}:keyboard-velocity`
- Output sockets: `cv-out` → `keyboard-cv`, `gate-out` → `keyboard-gate`, `velocity-out` → `keyboard-velocity`
- CV output: 1V/octave (MIDI 69 = 0V)
- Gate output: 0V / +5V per voice
- Velocity output: 0–5V per voice (input velocity 0–1 scaled by GATE_HIGH_VOLTAGE = 5)
- All three keyboard modules are voice-dependent

### Oscillator (`oscillator`)
- Inputs: `freq-input`, `amp-input`, `shape-input`, `duty-input`
- Output: audio ±1V (amplitude × wave)
- FREQ input: relative exponential pitch offset (V/octave around slider base)
- AMP input: 0–5V range → VCA multiply; outside 0–5V → additive offset
- Shape: 0 = square, 0.5 = sine, 1 = triangle
- Duty: clamped 2–98%, applied on peak/trough-aligned phase
- **Frequency range: 0.1–8000 Hz** (log slider — LFO range is ~first 15% of travel)

### Filter (`filter`)
- Inputs: `audio-input`, `cutoff-input`, `resonance-input`
- Output: audio
- Cutoff CV: `finalCutoff = baseCutoff × 2^(V/5)` — 0V = no change, +5V = +1 octave
- Resonance CV: `finalResonance = baseResonance + V/20` — linear additive, clamped 0–0.99
- Modes: lowpass / highpass

### Envelope (`envelope`)
- Inputs: `gate-input`, `attack-input`, `decay-input`, `sustain-input`, `release-input`
- Output: 0–5V
- On retrigger (new gate while still in release): attack ramps from current envelope value, not from 0
- ADSR CV inputs use relative exponential nudging for A/D/R, additive for S

### Random Voltage Generator (`random`)
- Input: `rate-input` (exponential CV nudge)
- Output: ±10V random stepped voltage
- **Rate range: 0.1–8000 Hz** (log slider)

### Mixer (`mixer`)
- Inputs: `input-a`, `input-b`, `level-a-input`, `level-b-input`
- Output: `signalA × levelA + signalB × levelB`

### Multi (`multi`)
- Input: `signal-input`
- Outputs: `output-a`, `output-b` (both carry the same signal — signal splitter)

### VCA / Amplifier (`vca`)
- Component: `src/components/VCA.jsx`, labelled "AMPLIFIER" in UI
- Inputs: `audio-input`, `gain-input`
- Output: `output`
- Gain slider: 0–2× (default 1)
- Gain CV: `finalGain = clamp(gain + V/5, 0, 2)`
- Polarity toggle: `+` (normal) or `−` (phase invert)
- Output = `input × finalGain × polarity`

### Track Output (`track-output`)
- Internal type registered per track. Routes the patched signal to the worklet's track mixer.

---

## Polyphonic Voice Architecture

- **MAX_VOICES = 4** per track
- Voice states: `FREE`, `ACTIVE` (gate > 0), `RELEASE` (gate = 0, envelope tailing)
- Voice assignment: **strict cyclic ring** — always advance to next slot regardless of state
- `getActiveVoices()` returns ACTIVE + RELEASE voices
- Voice mixing: voices **sum directly** — no normalization (more simultaneous notes = louder)
- Keyboard latch mode reserves voice index 0 as always-on when gate is unpatched

---

## Voice Dependency Propagation

The worklet traces the module graph from the track output back to its inputs. A module is voice-dependent if:
- It is `keyboard-cv`, `keyboard-gate`, or `keyboard-velocity`
- OR any of its relevant inputs connect to a voice-dependent module

Voice-dependent module input lists:
- `oscillator`: freq-input, amp-input, shape-input, duty-input
- `filter`: audio-input, cutoff-input, resonance-input
- `envelope`: gate-input, attack-input, decay-input, sustain-input, release-input
- `mixer`: input-a, input-b, level-a-input, level-b-input
- `multi`: signal-input
- `random`: rate-input
- `vca`: audio-input, gain-input

If the output module is voice-dependent, the track renders once per ACTIVE+RELEASE voice and sums. If not, it renders once globally with `laneContext = null`.

---

## Playhead Animation

The transport position line uses **direct DOM manipulation** — not React state — to achieve smooth 60fps animation:
- Each `TrackRow` in `Transport.jsx` runs its own `requestAnimationFrame` loop in a `useEffect`
- The loop calls `getPlaybackPositionMs()` and `getIsPlaying()` directly and writes `playheadRef.current.style.left`
- This completely decouples playhead updates from React renders and persists correctly across track selections

---

## Sequencer Playback Engine

Key functions (all exported from `sequencer.js`):
- `loadSession(session)` — loads session, computes noteSegments, initialises tracks in worklet
- `play()` — schedules note events, starts rAF progress updates
- `stop()` / `rewind()` / `seekTo(ms)`
- `getPlaybackPositionMs()` — returns current position (0 if not loaded)
- `getIsPlaying()` — boolean
- `subscribeToTransport(fn)` — subscribe to transport state changes
- `importMidiFile(arrayBuffer)` — converts MIDI → session via `midiConvert.js`

`loadSession` computes noteSegments from `notes[]` + BPM:
```js
{ noteNumber, startMs: startBeat * msPerBeat, endMs: startMs + duration * msPerBeat }
```

---

## UI Conventions

### Layout
- **Left panel** (200px, fixed): Keyboard singleton
- **Centre canvas** (flex-grow): draggable modules on a grid
- **Right panel** (220px, fixed): Oscilloscope / power panel (`Amplifier.jsx`)
- **Toolbar** (top): module-add buttons (`+ Oscillator`, `+ Filter`, `+ Envelope`, `+ Random`, `+ Mixer`, `+ Multi`, `+ Amplifier`) + power button
- **Transport** (bottom): track list with mini piano-roll, playback controls

### Canvas
- There is a standalone `src/components/Canvas.jsx` that is **NOT used**
- The active canvas is an inline `Canvas` function at the bottom of `App.jsx`
- Module positions stored as `{ x, y }` on the module object
- Modules wrapped in `<div style={{ position: 'absolute', left: module.x, top: module.y }}>`

### Modules & Dragging
- Banner bar triggers drag (`onMouseDown`); controls below banner must not initiate drag
- Uses global `mousemove`/`mouseup` — **not HTML5 drag API**
- Drag coordinates use `getBoundingClientRect()` on the canvas container

### Ports & Connections
- Ports are 16px squares, protruding from module edges
- Inputs on the left (red border), outputs on the right (blue border), green while connecting
- One connection per port; clicking a connected port removes it first
- Clicking canvas background cancels in-progress connection
- Connections render as SVG bezier curves in a fixed-position overlay (`z-index: 9999`, `pointer-events: none`)
- Port positions calculated live via `getBoundingClientRect()`, normalized to the main content area

### Sliders
- Unconnected: label shows current value as text
- Connected: label shows parameter name only
- Sliders do not visually respond to CV — they are offsets/base values
- Oscillator and Random frequency sliders: **logarithmic, 0.1–8000 Hz**

### Track Names
- Track names are editable by clicking on them in the transport strip

