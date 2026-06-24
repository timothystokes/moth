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

## Architectural Constraints

These are the binding design decisions that shape the codebase. Each entry states the **Constraint** (what must be true) and the **Rationale** (why it must be true).

### Audio engine runs in an AudioWorklet, not the main thread
> #### Constraint:
> All audio rendering — graph evaluation, voice processing, mixing — happens inside `moth-synth-worklet.js` in the AudioWorklet thread. The main thread only manages state and sends messages via `port.postMessage()`.  
> #### Rationale:
> The AudioWorklet thread is scheduled by the browser on a real-time priority path, isolated from GC pauses, React renders, and DOM work. Without this, audio would glitch whenever the UI does anything non-trivial.

### Module graph compiled to closures at topology-change time

> #### Constraint:
> When modules or connections change, `compileModuleEvaluator()` runs and assembles a tree of JavaScript closures. The audio `process()` loop calls these closures directly — it never traverses the graph at render time.  
> #### Rationale:
> Audio render cost is O(1) per sample with no dynamic dispatch or object lookups. This is the only way to safely do complex modular routing at audio rates (44100 samples/sec) in JavaScript.

### Parameter changes update params objects in-place — no recompile

> #### Constraint:
> Slider and knob changes post an `update-params` message that mutates the stable `params` object captured by the evaluator closure. They never trigger `rebuildCompiledRouting()`.  
> #### Rationale:
> Real-time parameter sweeps (e.g. cutoff, resonance, BPM) are instantaneous and allocation-free. Recompiling on every knob movement would cause audio dropouts.

### Shared modules are evaluated at most once per audio frame (frame cache)
> #### Constraint:
> A `frameCache` map keyed `"voiceId|moduleId"` stores each module's output for the current sample. Before evaluating, every module checks this cache and returns immediately if a result exists for this frame.  
> #### Rationale:
> Multi modules (signal splitters) and any shared routing only compute once per frame regardless of how many downstream connections they have. Evaluation time stays proportional to graph _size_, not graph _connections_.

### Per-voice module state keyed by voiceId, never global
> #### Constraint:
> All stateful module data — oscillator phase, envelope stage and level, filter state variables, delay/reverb buffers — is stored in Maps keyed by `voiceId`, not in closure-level variables.  
> #### Rationale:
> Each of the up-to-16 voices gets truly independent state. New voices start from a clean baseline; stolen voices reset correctly without affecting other voices. True polyphony is impossible without this.

### Voice states are only FREE or ACTIVE; envelope tails are owned by the envelope module
> #### Constraint:
> The voice pool has exactly two states: `'free'` and `'active'`. On note-off a voice is freed immediately. Envelope release tails continue to play because the envelope module's internal state machine keeps running until it reaches `idle` — the voice pool has no knowledge of this.  
> #### Rationale:
> Voice allocation stays simple and predictable. Adding a RELEASE state would require the pool to know about envelope durations, coupling two unrelated concerns.

### FIFO voice allocation: oldest free first, oldest active stolen last
> #### Constraint:
> `claimVoice()` always prefers the voice that has been free the longest (`voiceFreeOrder[0]`). If no voice is free, it steals the voice that has been active the longest (`voiceAllocationOrder[0]`).  
> #### Rationale:
> Maximises the time available for envelope tails to complete before a voice is reused, minimising audible clicks on steal. Deterministic ordering means repeated patterns sound consistent.

### Voice dependency is computed per-graph, not assumed
> #### Constraint:
> Before rendering a track, the worklet calls `isModuleVoiceDependent()` to determine whether any keyboard module is reachable from the output. If not, the graph is rendered once globally with `laneContext = null`.  
> #### Rationale:
> Avoids rendering the full module graph once per voice when no voice-specific signal is used (e.g. a global LFO driving all voices identically). CPU cost scales with actual polyphony need.

### Flat note data model — no nested sequences or arrangements
> #### Constraint:
> Notes are stored as a flat array per track: `{ note, bar, beat, duration, velocity }`. There is no sequence/pattern/arrangement hierarchy. `noteSegments` (ms timings) are derived on load and never persisted.  
> #### Rationale:
> Simple to serialise, diff, and merge. MIDI import produces the same format directly. Eliminates a layer of indirection that complicated earlier versions of the code.

### Pseudo-voltage signal model with defined ranges

> #### Constraint:
> All inter-module signals use analog modular voltage conventions — 1V/octave pitch, 0–5V gate/velocity/envelope, ±1V audio. Signal range is part of the public contract of every module type.  
> #### Rationale:
> Patching semantics match real Eurorack conventions, so the behaviour of any patch is predictable and composable. CV inputs that go out of range are clamped explicitly, not silently clipped by floating-point saturation.

### Playhead animation uses direct DOM manipulation, not React state
> #### Constraint:
> Each `TrackRow` in `Transport.jsx` runs its own `requestAnimationFrame` loop. The loop reads `getPlaybackPositionMs()` directly and writes `playheadRef.current.style.left` — it never calls `setState`.  
> #### Rationale:
> Playhead position updates at 60fps without triggering React renders. Routing 60fps updates through React state would cause the entire transport to re-render on every frame.

### Cross-thread callbacks passed into `useEffect` deps must be stable references
> #### Constraint:
> Any callback that is passed as a prop and used inside a `useEffect` dependency array (e.g. `onViewportChange`) must be wrapped in `useCallback` with an empty dependency array `[]` in the parent.  
> #### Rationale:
> Prevents `useEffect` cleanup/setup cycles on every render. If an inline arrow function is passed, its reference changes every render, so the effect's cleanup fires and re-fires continuously — a class of subtle bug where state is reset faster than it can be set.

### React state is UI state only; audio state lives in the worklet
> #### Constraint:
> Module parameters, voice states, audio buffers, and graph topology are owned by the worklet. React holds only the serialisable representation needed to render the UI and reconstruct the worklet state on reload.  
> #### Rationale:
> Audio state never triggers React renders. UI renders only on user actions, not on audio events. The two state systems communicate through a one-way message channel, not shared mutable objects.

---

## Core Architecture: The Module Graph

### Two-thread model
The engine runs across two threads:
- **Main thread** (`audioEngine.js`): Manages module/connection/track state, mirrors changes to the worklet via `port.postMessage()`, provides subscription APIs to React.
- **AudioWorklet thread** (`moth-synth-worklet.js`): Receives state messages, compiles the module graph into closures, renders audio sample-by-sample.

### Graph compilation ("recurse down, return up")
When the module graph changes (connect, disconnect, add/remove module), `rebuildCompiledRouting()` and `compileModuleEvaluator()` rebuild the evaluation tree.

**Compilation phase** — recurse _down_ the graph from the track output to sources:
- `compileModuleEvaluator(moduleId)` is called on the module wired to the track output (`{trackId}:track-output → audio-input`).
- For each input port of that module, `createInputReader(moduleId, inputName)` looks up the connected source and recursively calls `compileModuleEvaluator(sourceModuleId)`.
- This continues depth-first until leaf modules (keyboard-cv/gate/velocity, or unconnected ports that return `0`).
- Each compiled module becomes a **closure** that captures:
  - References to its upstream input-reader closures (upstream modules)
  - A stable mutable `params` object (updated in-place on `update-params` messages — **no recompile needed** for parameter changes)
  - Module-local persistent state (oscillator phase, filter state, envelope stages, delay buffers — each keyed per `voiceId`)
- Cycle detection: an `activeStack` Set prevents infinite recursion on cyclic graphs.
- Result caching: compiled evaluators are stored in `compiledModuleEvaluators` and reused if the same module appears as a source in multiple places.

**Evaluation phase** — return _up_ with values, once per audio sample:
- `process()` calls the compiled track-output evaluator: `outputRead(timeMs, laneContext)`.
- That evaluator calls its upstream input readers (also `(timeMs, laneContext) => number`), recursing up the tree.
- **Leaf nodes** (keyboard modules) read directly from `laneContext` (the live voice object) to return voice-specific values.
- Each evaluator computes and returns a **single floating-point sample**.
- A **frame cache** (`Map<"voiceId|moduleId", number>`) prevents duplicate evaluation of shared modules within one audio frame; cleared at the start of every sample.

### laneContext — what it is
`laneContext` is the **voice object itself**, passed from the `process()` loop directly into the evaluation tree. For voice-dependent graphs it contains:
```js
{
  voiceId: string,           // e.g. "track-1:voice-0"
  state: 'free' | 'active',
  noteNumber: number | null,
  velocity: number,          // 0–5V
  gate: number,              // 0 or 5V
  cv: number,                // 1V/octave, A4/MIDI69 = 0V
  cvStart: number,           // start of portamento glide
  cvGlideStartMs: number | null,
  portamentoTime: number     // seconds
}
```
For global (non-voice-dependent) graphs, `laneContext` is `null` and keyboard modules return `0`.

### Voice dependency propagation
The worklet checks `isModuleVoiceDependent(moduleId)` by walking graph inputs recursively:
- `keyboard-cv`, `keyboard-gate`, `keyboard-velocity` → always voice-dependent.
- All other module types → voice-dependent if **any** of their relevant input ports connects to a voice-dependent source.
- Result cached in `voiceDependencyCache` (invalidated on graph changes).

If the track-output source is voice-dependent, `process()` renders the graph **once per voice** and sums. Otherwise, it renders **once globally** with `laneContext = null`.

### Signal scaling in process()
- Voice samples are scaled by `/10` before summing: `trackSample += voiceSignal / 10`.
- Global (non-voice-dependent) track output is also scaled by `/10`.
- 3-band shelving EQ is applied per-track using 1-pole IIR filters (low shelf 250 Hz, high shelf 4000 Hz).
- Constant-power pan law: `panL = cos(angle)`, `panR = sin(angle)`, where `angle = (pan + 1) × 0.25π`.
- When more than one track is active: `norm = 1 / sqrt(activeTrackCount)` applied to L/R mix.
- Final stereo output clamped to ±1 with a diagnostic reported on clip.

---

## Signal Model
All inter-module signals are pseudo-voltages:
- **Pitch CV:** 1V/octave, A4 / MIDI 69 = 0V
- **Audio:** oscillator output is `amplitude × wave` where wave ∈ [−1, +1]
- **Gate:** 0V (off) / +5V (on)
- **Velocity:** 0–5V (input velocity 0–1 scaled by `GATE_HIGH_VOLTAGE = 5`)
- **Envelope output:** 0–5V

All evaluator functions share the signature: `(timeMs, laneContext) => number`

---

## Audio Engine File Structure

| File | Role |
|---|---|
| `audioEngine.js` | Public main-thread API: `registerModule`, `connectModules`, `noteOn/Off`, `upsertTrack`, etc. Mirrors all state to the worklet. |
| `moth-synth-worklet.js` | AudioWorklet processor. Compiles the module graph into closures; renders audio sample-by-sample with per-voice evaluation. |
| `sequencer.js` | Playback engine: `play`, `stop`, `rewind`, `seekTo`, `loadSession`, `updateSession`, `importMidiFile`, recording. |
| `noteUtils.js` | Pure utilities: `absoluteBeatToBarBeat`, `barBeatToAbsoluteBeat`, `midiToNoteName`, `noteNameToMidi`, `getBeatsPerBar`, `getEventPriority`. |
| `trackMigration.js` | Converts legacy sequence+arrangement format to flat `notes[]`. |
| `midiConvert.js` | MIDI file parsing: `buildNotesFromMidiEvents`, `buildNoteSegments`, `convertMidiToSession`. Uses `midi-file` npm package. |
| `voiceAllocator.js` | **Legacy / unused.** Old round-robin allocator, not imported anywhere. |
| `synthConstants.js` | **Legacy / unused.** Only referenced by voiceAllocator.js. |

---

## Song / Session Data Model

### Top-level saved project structure
```json
{
  "version": 1,
  "savedAt": "ISO8601 timestamp",
  "sequence": { "bpm": 120, "timeSignatures": [{"numerator":4,"denominator":4}], "tempoMap": [] },
  "selectedTrackId": "track-id",
  "tracks": [...]
}
```

### Track structure (React state)
```json
{
  "id": "track-manual-{timestamp}-{counter}",
  "name": "Track Name",
  "polyphony": 4,
  "portamento": 0,
  "durationMs": 8000,
  "mix": { "volume": 0.8, "mute": false, "solo": false, "high": 0, "mid": 0, "low": 0, "pan": 0 },
  "notes": [...],
  "noteSegments": [...],
  "modules": [...],
  "connections": [...]
}
```

### Note format
- `note`: note name string (e.g. `"F4"`, `"Gs4"`, `"C4s"`) or `"-"` for rest
- `bar`: **1-indexed** bar number
- `beat`: **0-indexed** beat within bar (0.0 = start of bar, in a 4/4 bar: 0–3.75 on 0.25 grid)
- `duration`: duration in beats (e.g. `0.25` = 16th note, `1.0` = quarter note)
- `velocity`: float 0–1

### noteSegments
Computed on `loadSession`/`updateSession`, not persisted (derived data):
```json
{ "noteNumber": 65, "startMs": 0, "endMs": 375 }
```
Used for: Transport strip mini piano-roll display.

### Module object
```json
{
  "id": "{trackId}:{type}-{instanceNum}",
  "type": "oscillator",
  "instanceNum": 1,
  "x": 120, "y": 80,
  "params": {}
}
```

### Connection object
```json
{
  "id": "conn-{timestamp}",
  "from": { "moduleId": "keyboard-singleton", "outputId": "cv-out" },
  "to":   { "moduleId": "{trackId}:oscillator-1", "outputId": "freq-input" }
}
```
Special `moduleId` values in connections:
- `"keyboard-singleton"` → resolved to `"{trackId}:keyboard-cv/gate/velocity"` depending on `outputId`
- `"track-output-singleton"` → resolved to `"{trackId}:track-output"`
- Multi module outputs (`output-a`, `output-b`) both resolve to just the module's ID (identical signal)

---

## Module Types

### Keyboard (singleton, fixed left panel)
- Three modules registered per track: `{trackId}:keyboard-cv`, `{trackId}:keyboard-gate`, `{trackId}:keyboard-velocity`
- Output sockets: `cv-out`, `gate-out`, `velocity-out`
- CV output: 1V/octave (MIDI 69 = 0V); interpolates during portamento glide
- Gate: 0V / +5V per voice
- Velocity: 0–5V per voice
- All three are always voice-dependent

### Oscillator (`oscillator`)
- Inputs: `freq-input`, `amp-input`, `shape-input`, `duty-input`
- Output: audio (amplitude × wave)
- FREQ input: exponential pitch offset in V/octave — `finalFreq = baseFreq × 2^V`
- AMP input: `finalAmp = amplitude × clamp(V / 5, 0, 1)` — 5V = slider level, 0V = silence
- AMP slider: 0–2 linear (0 dB at midpoint); two-segment log scale left half −60 dB→0 dB, right half 0 dB→+6 dB
- Shape: 0 = square, 0.5 = sine, 1 = triangle (smooth morph via duty-cycle adjusted phase distortion)
- Duty: clamped 2–98%, applied on peak/trough-aligned phase
- Per-voice state: `{ phase, lastTime }` — phase accumulates across samples for coherent FM
- **Frequency range: 0.1–8000 Hz** (log slider — LFO range is ~first 15% of slider travel)

### Filter (`filter`)
- Inputs: `audio-input`, `cutoff-input`, `resonance-input`
- Output: filtered audio
- State-variable filter (SVF); per-voice state: `{ lowpass, bandpass }`
- Cutoff CV: `finalCutoff = baseCutoff × 2^(V/5)` — 0V = no change, +5V = +1 octave
- Resonance CV: `finalResonance = baseResonance + V/20` — linear additive, clamped 0–0.99
- Modes: lowpass / highpass

### Envelope (`envelope`)
- Inputs: `gate-input`, `attack-input`, `decay-input`, `sustain-input`, `release-input`
- Output: 0–5V
- Per-voice state machine: `idle → attack → decay → sustain → release → idle`
- On retrigger: attack ramps from current envelope value (not from 0)
- ADSR CV inputs: A/D/R use exponential nudging `× 2^(V/10)`; S uses linear additive `+ V/20`
- Time range: 0.001–10 seconds per stage

### Random Voltage Generator (`random`)
- Input: `rate-input` (exponential: `finalRate = baseRate × 2^(V/10)`)
- Output: ±10V random stepped voltage
- Per-voice state: `{ lastOutputTime, currentValue }`
- **Rate range: 0.1–8000 Hz** (log slider)

### Mixer (`mixer`)
- Inputs: `input-a`, `input-b`
- Output: `signalA × 0.5 + signalB × 0.5` (fixed 50/50 mix, no level CV inputs)

### Multi (`multi`)
- Input: `signal-input`
- Outputs: `output-a`, `output-b` — both return identical signal (signal splitter)
- In the worklet, both output ports resolve to the same module ID; the routing for both reads the same evaluator

### VCA / Amplifier (`vca`) — labelled "AMPLIFIER" in UI
- Inputs: `audio-input`, `gain-input`
- Output: `input × finalGain × polarity`
- Gain slider: 0–2× (default 1)
- Gain CV: `finalGain = clamp(gain + V/5, 0, 2)`
- Polarity toggle: `+` (normal) or `−` (phase invert)

### MFX (`mfx`)
- Inputs: `audio-input`, `time-input`, `feedback-input`
- Output: processed audio
- Two modes selected by `fxType` param:
  - **Delay**: up to 2000 ms. `time-input` CV nudges delay time (±200 ms/V). Feedback 0–0.8. Mix 0–1 dry/wet.
  - **Reverb**: Freeverb-style (4 parallel comb filters + 2 series all-pass filters). `time` = room size 0–1 (controls comb feedback 0.7–0.9). `feedback` = damping. Mix 0–1 dry/wet.
- Per-voice delay and reverb state (each voice has independent buffers)

### Scope (`scope`) — labelled "SCO - N" in UI
- Input: `signal-input`
- Output: `signal-output` (passthrough — signal unchanged per voice)
- Per-module scope buffer (4096 samples). Voices are **summed** per audio frame (one sample written per frame regardless of voice count)
- Zero-crossing trigger: searches backwards for rising edge within 1000 samples before write index
- Dispatches `module-scope-data` messages; `audioEngine.js` routes to per-module listener sets via `subscribeToModuleScopeData(moduleId, fn)`
- Auto-scaling display with 5-frame peak history

### Module Instance Numbering
- `instanceNum` = `max(existing instanceNums of same type on this track) + 1` at creation time
- ID pattern: `{trackId}:{type}-{instanceNum}` (e.g. `track-1:oscillator-2`)
- UI headers display: `VCO - 1`, `VCF - 2`, `SCO - 1`, etc.
- After delete: next instance gets `max + 1`, never reuses a number that would collide with existing instances

---

## Polyphonic Voice Architecture

- **Default polyphony: 4 voices per track**; configurable 1–16 per track (`track.polyphony`)
- Voice states: `'free'` and `'active'` — **no release state**: voices are freed immediately on note-off; envelope tails are handled by the envelope module's internal state machine independently
- **`getActiveVoices(trackState)`** returns only voices with `state === 'active'`

### Voice allocation (poly mode, polyphony ≥ 2)
1. **Prefer oldest freed voice** (`voiceFreeOrder[0]`) — this voice had the most time for its envelope to tail off
2. Fallback: any free voice not yet in the free order (brand new, never used)
3. Last resort: **steal oldest active voice** (`voiceAllocationOrder[0]`) — FIFO steal
- `voiceAllocationOrder`: tracks ACTIVE voices in press order (oldest first)
- `voiceFreeOrder`: tracks FREE voices in release order (oldest first)

### Mono mode (polyphony = 1)
- Note stack maintained; new note pushes onto stack, old note pitch resumes on release (last-note priority)
- Portamento interpolates CV from previous note over `portamentoTime` seconds
- Gate stays high as long as any key is held

### Voice mixing per track
- Each voice sample: `trackSample += voiceSignal / 10`
- Non-voice-dependent output: `trackSample = outputRead(sampleTimeMs, null) / 10`
- Multi-track normalization when >1 active track: `mixedL/R *= 1 / sqrt(activeTrackCount)`

---

## Sequencer Playback Engine

Key exports from `sequencer.js`:
- `loadSession(sessionMeta, tracks)` — loads session, computes `noteSegments`, resets playback to 0
- `updateSession(sessionMeta, tracks)` — like `loadSession` but preserves playback state; reschedules from current position if playing
- `play()` — schedules note events via `setTimeout`, starts rAF progress updates
- `stop()` / `rewind()` / `seekTo(ms)`
- `getPlaybackPositionMs()` — current position (0 if not loaded)
- `getIsPlaying()` — boolean
- `subscribeToTransport(fn)` — subscribe to transport state changes
- `importMidiFile(arrayBuffer)` — MIDI → session via `midiConvert.js`
- `startRecording()` / `stopRecording()` — wall-clock based recording (uses `performance.now()` not playback position for duration accuracy)

`noteSegments` are computed from `notes[]` + BPM:
```js
{ noteNumber, startMs: startBeat * msPerBeat, endMs: startMs + duration * msPerBeat }
```

---

## UI Conventions

### Layout
- **Two view modes**: VOICE (module grid) and NOTES (piano roll) — toggled via folder-style tabs in the top Toolbar
- **VOICE mode:**
  - Left panel (80px, fixed): Keyboard singleton
  - Centre canvas (flex-grow): draggable modules on a dotted grid
  - Right panel (80px, fixed): Amplifier strip (`Amplifier.jsx`) — volume fader, 3-band EQ, pan, solo
  - Floating `+ module` buttons: absolute overlay, bottom-right of the VOICE grid
- **NOTES mode:** Piano roll view — module buttons not shown
- **Toolbar** (top, always visible): MOTH logo + VOICE/NOTES folder tabs, track name + polyphony + PORTA slider, MIDI selector, LOAD/SAVE/RESET/IMPORT buttons, BPM, audio status
- **Transport** (bottom): track list (track name, delete, mini timeline), playback controls, voice status

### Folder-style tabs
- Active tab: `alignSelf: flex-end`, `marginBottom: -2px` (bleeds through toolbar border), `borderBottom: '2px solid #101010'` to merge with content area, `zIndex: 1001`
- Inactive tabs: shorter height, darker background, dimmer text
- Toolbar: `overflow: visible`, `position: relative` to allow tab bleed

### Green track selection
- Selected track row: dark green background `#0d1f0d`, `3px` left border `#5aaa5a`, track name `#8adb8a`
- Navbar track name: `#8adb8a` green

### Canvas
- `src/components/Canvas.jsx` exists but is **not used** — it is the old standalone canvas
- The active canvas is an **inline `Canvas` function at the bottom of `App.jsx`**
- Module positions stored as `{ x, y }` on the module object; visual-only (not audio-affecting)

### Modules & Dragging
- Banner bar triggers drag (`onMouseDown`); controls below banner must not initiate drag
- Uses global `mousemove`/`mouseup` — **not HTML5 drag API**
- Drag coordinates use `getBoundingClientRect()` on the canvas container

### Ports & Connections
- Ports are 18px round circles, rendered in-flow within module bounds
- Inputs left (red border), outputs right (blue border), green while connecting
- One connection per input port; connecting to an occupied port removes the existing connection first
- Wire drag line visible over all panels (onMouseMove on outer `contentRef` div)
- Connections render as SVG bezier curves in a fixed-position overlay (`z-index: 9999`, `pointer-events: none`)
- Wire endpoints have green 4px circle endcaps
- Port positions calculated live via `getBoundingClientRect()`, normalized to the main content area

### Sliders
- Labels always show current value regardless of CV connection state
- Sliders are offsets/base values — they do not visually respond to CV
- Oscillator and Random frequency sliders: **logarithmic, 0.1–8000 Hz**

### Track Names
- Editable by clicking on them in the transport strip

### Playhead Animation
The transport position line uses **direct DOM manipulation** — not React state — for smooth 60fps animation:
- Each `TrackRow` in `Transport.jsx` runs its own `requestAnimationFrame` loop in a `useEffect`
- The loop calls `getPlaybackPositionMs()` and `getIsPlaying()` directly and writes `playheadRef.current.style.left`
- Completely decoupled from React renders

### Notes-mode viewport bounding box
`PianoRoll` reports the visible region to `App` via `onViewportChange(vp)`:
```js
vp = {
  startMs, endMs,           // horizontal: visible time range in milliseconds (pixels → beats → ms via BPM)
  topFraction, bottomFraction  // vertical: fraction of full MIDI range (A0–C8) visible (0 = top, 1 = bottom)
}
// or null on unmount
```
- `onViewportChange` is a stable `useCallback` in App.jsx (never changes reference)
- Updated on: scroll (horizontal or vertical), `totalCells` change (notes added/removed), container resize (via `ResizeObserver`)
- Transport `TrackRow` renders the bounding box using `startMs / timelineDurationMs` and `topFraction` directly as CSS percentages

---

## Shared UI Components

All modules use these shared components from `src/components/`:

| Component | Description |
|---|---|
| `ModuleShell` | Outer wrapper: background #3a3a3a, border 2px #666, radius 18px, header #2e2e2e, draggable header, optional × close button. Content padding: 10px 10px 6px. |
| `Port` | 18px round socket. margin: 0 3px. Red border=input, blue=output, green=connecting. |
| `InputPort` | Port left + label right. marginBottom 6px. |
| `OutputPort` | Label left + port right (right-aligned). marginBottom 6px. Accepts `children` left of label. |
| `InputSlider` | Label above, port+range input row, optional tick labels (left/mid/right) below. marginBottom 10px. |
| `AppSelect` | Styled `<select>` matching ToolbarButton aesthetics. Optional `label` prop renders a left-side label. `wrapperStyle` overrides outer wrapper. Used for MIDI device, MIDI channel, POLY, and any other select in the toolbar. Replaced the deleted `SelectControl`. |
| `ControlBlock` | Layout wrapper: label top-left (9px), value bottom-right (8px), children centred. Used in Amplifier knobs and Toolbar PORTA slider. |
| `NavDivider` | 1px vertical separator for the toolbar. `margin: 8px 18px`, `alignSelf: stretch`. |
| `ToolbarButton` | Toolbar button. `padding: 7px 12px`, `paddingBlock: 0`, `appearance: none`, `boxSizing: border-box`. |
| `SmallButton` | Compact inline button for track row actions (×, mute, etc.). |

Label colours: main labels #bbb, tick labels #aaa, module titles #ccc.
Green accent family: `#5aaa5a` (borders/accents), `#8adb8a` (active text/selected state).


