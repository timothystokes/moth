# Project Context

## Project Overview

**Project Name:** MOTH1  
**Status:** Active Development

MOTH1 is a web-based modular synthesiser built with React 18 and Vite. It runs entirely in the browser and models analog-style signal routing between modules using a pseudo-voltage signal model and a polyphonic voice engine running in an AudioWorklet.

This file is the single source of truth for project context, architectural constraints, module behavior, data models, and UI conventions. Keep `.github/copilot-instructions.md` as a pointer to this file only.

## Tech Stack

- **Language:** JavaScript, not TypeScript
- **Framework:** React 18
- **Build Tool:** Vite
- **Key Dependencies:** `react`, `react-dom`, `midi-file`
- **Runtime:** Browser; Node.js is only used for development tooling
- **Build validation:** `npm run build`

## Engineering Rules

- Never swallow an error. Always surface errors visibly.
- If a track or module produces invalid runtime audio data, report it through the UI-visible error/diagnostic path and stop the active sequence rather than continuing playback silently.
- Keep audio rendering in the worklet. Main-thread React state is for UI and serialisable session/project state only.
- Prefer existing component and module patterns over new abstractions unless a new abstraction removes real local complexity.

---

## Architectural Constraints

These are the binding design decisions that shape the codebase.

| Constraint | Rationale |
|---|---|
| All audio rendering, including graph evaluation, voice processing, and mixing, happens inside `moth-synth-worklet.js` in the AudioWorklet thread. The main thread only manages state and sends messages via `port.postMessage()`. | The AudioWorklet thread is scheduled on the real-time audio path and is isolated from GC pauses, React renders, and DOM work. This prevents UI activity from causing audio glitches. |
| Module graph topology is compiled to closures at topology-change time by `rebuildCompiledRouting()` and `compileModuleEvaluator()`. The audio `process()` loop calls those closures directly and never traverses the graph dynamically. | Audio render cost stays predictable and avoids dynamic dispatch or object lookups at audio rate. Complex modular routing remains viable at 44100+ samples per second. |
| Parameter changes mutate stable `params` objects in place through `update-params`; slider and knob changes must not trigger `rebuildCompiledRouting()`. | Real-time parameter sweeps such as cutoff, resonance, BPM, and oscillator frequency stay instantaneous and allocation-free. Recompiling on every knob movement would cause audio dropouts. |
| Shared module outputs are evaluated at most once per audio frame using `frameCache`, keyed by `"voiceId|moduleId"`. | Multi/splitter modules and shared routing compute once per frame regardless of fan-out. Evaluation time scales with graph size rather than connection count. |
| Stateful module data is keyed by `voiceId` in Maps, never stored as one global closure-level state when the signal is per-voice. | Each polyphonic voice has independent oscillator phase, envelope state, filter state, delay/reverb buffers, and sampler playback state. Voice stealing and reuse do not corrupt other voices. |
| Voice pool states are only `'free'` and `'active'`; envelope release tails are owned by the envelope module, not by a voice-pool RELEASE state. | Voice allocation remains simple and deterministic. The voice pool does not need to know envelope durations or couple allocation to envelope internals. |
| Voice allocation in poly mode prefers the oldest freed voice first and steals the oldest active voice only when no free voice exists. | This maximises time for envelope tails to finish before a voice is reused, reduces audible clicks on steals, and keeps repeated patterns deterministic. |
| Voice dependency is computed per graph by `isModuleVoiceDependent()` rather than assumed globally. | Graphs with no reachable keyboard module render once globally with `laneContext = null`, avoiding unnecessary per-voice work. CPU cost scales with actual polyphony need. |
| Notes use a flat per-track array: `{ note, bar, beat, duration, velocity }`. There is no nested sequence/pattern/arrangement hierarchy. `noteSegments` are derived on load/update and are not persisted. | The session format is simple to serialise, diff, merge, and import from MIDI. It removes old pattern/arrangement indirection. |
| All inter-module signals use pseudo-voltage conventions: 1V/octave pitch, 0-5V gate/velocity/envelope, and audio/CV values documented by each module. Out-of-range CV is clamped explicitly. | Patching semantics match Eurorack-style expectations and remain predictable/composable. Explicit clamping avoids silent floating-point saturation. |
| Playhead animation uses direct DOM writes in `TrackRow` requestAnimationFrame loops and does not use React state for the playhead position. | The playhead updates at 60fps without causing React renders or transport-wide UI churn. |
| Cross-thread or high-frequency callbacks passed into `useEffect` dependency arrays must be stable references, usually `useCallback(fn, [])` in the parent. | Prevents cleanup/setup loops caused by new function references on every render, especially for viewport and transport callbacks. |
| React state holds only the serialisable representation needed to render UI and reconstruct worklet state. Audio buffers, voice states, graph evaluators, and audio runtime state live in the worklet. | Audio state never triggers React renders. UI and audio communicate through one-way message passing instead of shared mutable objects. |
| New modules must follow the existing register/connect/compile flow: React registers serialisable params, `audioEngine.js` mirrors messages, and the worklet owns runtime audio state. | This preserves the two-thread architecture and keeps UI state separate from audio-rate behavior. |

---

## Core Architecture: Module Graph

### Two-thread model

- **Main thread (`audioEngine.js`)**: Public API for `registerModule`, `connectModules`, `disconnectInput`, `noteOn`, `noteOff`, `upsertTrack`, sampler messages, diagnostics, scope data, and voice status. Mirrors serialisable state to the worklet.
- **AudioWorklet thread (`moth-synth-worklet.js`)**: Owns audio rendering, module graph compilation, voice allocation, graph evaluation, sample mixing, diagnostics, and runtime audio state.

### Graph compilation

When modules or connections change, `rebuildCompiledRouting()` and `compileModuleEvaluator()` rebuild the evaluation tree.

Compilation recurses down the graph from the track output to sources:

- `compileModuleEvaluator(moduleId)` is called on the module wired to `{trackId}:track-output` through `audio-input`.
- For each input port, `createInputReader(moduleId, inputName)` finds the connected source and recursively compiles that source module.
- Leaf modules include keyboard CV/gate/velocity modules and unconnected ports, which return `0`.
- Each compiled module becomes a closure capturing upstream readers, a stable mutable `params` object, and module-local persistent state keyed by `voiceId` where needed.
- `activeStack` prevents infinite recursion on cyclic graphs.
- `compiledModuleEvaluators` caches evaluators reused by multiple downstream consumers.

Evaluation returns up the tree once per audio sample:

- `process()` calls the compiled track output evaluator as `outputRead(timeMs, laneContext)`.
- Input readers recursively call upstream evaluators with the same `(timeMs, laneContext)` signature.
- Keyboard leaf modules read directly from `laneContext`.
- Each evaluator returns a single floating-point sample.
- `frameCache` is cleared at the start of every sample and prevents duplicate module evaluation within that frame.

### `laneContext`

`laneContext` is the voice object passed from the worklet `process()` loop into the graph for voice-dependent render paths:

```js
{
  voiceId: string,
  state: 'free' | 'active',
  noteNumber: number | null,
  velocity: number,
  gate: number,
  cv: number,
  cvStart: number,
  cvGlideStartMs: number | null,
  portamentoTime: number
}
```

For global non-voice-dependent graphs, `laneContext` is `null` and keyboard modules return `0`.

### Voice dependency propagation

- `keyboard-cv`, `keyboard-gate`, and `keyboard-velocity` are always voice-dependent.
- Other module types are voice-dependent when any relevant input is connected to a voice-dependent upstream source.
- The result is cached in `voiceDependencyCache` and invalidated on graph changes.
- If the output source is voice-dependent, `process()` renders once per track voice and sums. Otherwise it renders once globally.

### Signal scaling in `process()`

- Voice samples are scaled by `/10` before summing: `trackSample += voiceSignal / 10`.
- Global non-voice-dependent output is also scaled by `/10`.
- Per-track EQ uses 1-pole IIR filters for low shelf at 250 Hz and high shelf at 4000 Hz.
- Pan uses constant-power law: `panL = cos(angle)`, `panR = sin(angle)`, where `angle = (pan + 1) * 0.25 * Math.PI`.
- When more than one track is active, `1 / sqrt(activeTrackCount)` is applied to the stereo mix.
- Final stereo output is clamped to +/-1 and a diagnostic is reported on clipping.

---

## Signal Model

All evaluator functions share this signature:

```js
(timeMs, laneContext) => number
```

Voltage conventions:

- **Pitch CV:** 1V/octave, A4 / MIDI 69 = 0V
- **Audio:** oscillator output is `amplitude * wave`, where `wave` is in `[-1, +1]`
- **Gate:** 0V off, +5V on
- **Velocity:** 0-5V, scaled from input velocity 0-1 using `GATE_HIGH_VOLTAGE = 5`
- **Envelope output:** 0-5V
- **Random stepped voltage:** +/-10V

---

## Audio Engine File Structure

| File | Role |
|---|---|
| `src/audio/audioEngine.js` | Main-thread public API and worklet message bridge. Registers modules, connections, tracks, sampler samples/triggers, scope listeners, diagnostics, and voice status subscriptions. |
| `src/audio/moth-synth-worklet.js` | AudioWorklet processor. Compiles module graph closures, renders audio sample-by-sample, manages voice allocation, per-voice module state, sampler playback, diagnostics, scope buffers, EQ, pan, and mixing. |
| `src/audio/sequencer.js` | Playback engine: `play`, `stop`, `rewind`, `seekTo`, `loadSession`, `updateSession`, MIDI input selection, MIDI import, and recording. |
| `src/audio/noteUtils.js` | Pure note/time utilities: `absoluteBeatToBarBeat`, `barBeatToAbsoluteBeat`, `midiToNoteName`, `noteNameToMidi`, `getBeatsPerBar`, `getEventPriority`. |
| `src/audio/trackMigration.js` | Converts legacy sequence/arrangement data to flat `notes[]`. |
| `src/audio/midiConvert.js` | MIDI file parsing: `buildNotesFromMidiEvents`, `buildNoteSegments`, `convertMidiToSession`. Uses `midi-file`. |
| `src/audio/voiceAllocator.js` | Legacy/unused round-robin allocator. Not imported by the active engine. |
| `src/audio/synthConstants.js` | Legacy/unused constants referenced only by `voiceAllocator.js`. |

---

## Song and Session Data Model

### Saved project structure

```json
{
  "version": 1,
  "savedAt": "ISO8601 timestamp",
  "sequence": {
    "bpm": 120,
    "timeSignatures": [{ "numerator": 4, "denominator": 4 }],
    "tempoMap": []
  },
  "selectedTrackId": "track-id",
  "tracks": []
}
```

### Track structure

```json
{
  "id": "track-manual-{timestamp}-{counter}",
  "name": "Track Name",
  "polyphony": 4,
  "portamento": 0,
  "durationMs": 8000,
  "mix": {
    "volume": 0.8,
    "mute": false,
    "solo": false,
    "high": 0,
    "mid": 0,
    "low": 0,
    "pan": 0
  },
  "notes": [],
  "noteSegments": [],
  "modules": [],
  "connections": []
}
```

### Note format

- `note`: note name string such as `"F4"`, `"Gs4"`, `"C4s"`, or `"-"` for rest
- `bar`: 1-indexed bar number
- `beat`: 0-indexed beat within bar, e.g. `0.0` is the start of the bar
- `duration`: duration in beats, e.g. `0.25` for a 16th note or `1.0` for a quarter note
- `velocity`: float 0-1

### Derived `noteSegments`

`noteSegments` are computed on `loadSession` and `updateSession`, not persisted:

```js
{ noteNumber, startMs: startBeat * msPerBeat, endMs: startMs + duration * msPerBeat }
```

They are used by the transport mini piano-roll display.

### Module object

```json
{
  "id": "{trackId}:{type}-{instanceNum}",
  "type": "oscillator",
  "instanceNum": 1,
  "x": 120,
  "y": 80,
  "params": {}
}
```

### Connection object

```json
{
  "id": "conn-{timestamp}",
  "from": { "moduleId": "keyboard-singleton", "outputId": "cv-out" },
  "to": { "moduleId": "{trackId}:oscillator-1", "outputId": "freq-input" }
}
```

Special module IDs in connections:

- `keyboard-singleton` resolves to `{trackId}:keyboard-cv`, `{trackId}:keyboard-gate`, or `{trackId}:keyboard-velocity` depending on `outputId`.
- `track-output-singleton` resolves to `{trackId}:track-output`.
- Multi module outputs `output-a` and `output-b` both resolve to the same module ID.

---

## Module Types

| Label | Type | Inputs | Outputs | Notes |
|---|---|---|---|---|
| Keyboard CV | `keyboard-cv` | none | `cv-out` | Singleton fixed left panel. 1V/octave, A4/MIDI 69 = 0V. Interpolates during portamento glide. Always voice-dependent. |
| Keyboard Gate | `keyboard-gate` | none | `gate-out` | Singleton fixed left panel. 0V/+5V per voice. Always voice-dependent. |
| Keyboard Velocity | `keyboard-velocity` | none | `velocity-out` | Singleton fixed left panel. 0-5V per voice. Always voice-dependent. |
| Oscillator / VCO | `oscillator` | `freq-input`, `amp-input`, `shape-input`, `duty-input` | `output` | Audio oscillator with per-voice phase. Frequency range 0.1-8000 Hz. |
| Filter / VCF | `filter` | `audio-input`, `cutoff-input`, `resonance-input` | `output` | State-variable filter with lowpass/highpass modes and per-voice state. |
| Envelope / ENV | `envelope` | `gate-input`, `attack-input`, `decay-input`, `sustain-input`, `release-input` | `output` | ADSR, 0-5V output, per-voice state machine. |
| Random / RND | `random` | `rate-input` | `output` | +/-10V stepped random voltage. Rate range 0.1-8000 Hz. |
| Mixer / MIX | `mixer` | `input-a`, `input-b` | `output` | Fixed 50/50 mix: `signalA * 0.5 + signalB * 0.5`. |
| Multi / MUL | `multi` | `signal-input` | `output-a`, `output-b` | Signal splitter. Both outputs resolve to the same evaluator. |
| VCA / AMPLIFIER | `vca` | `audio-input`, `gain-input` | `output` | Gain 0-2x with optional phase invert. |
| MFX | `mfx` | `audio-input`, `time-input`, `feedback-input` | `output` | Delay/reverb effect module with per-voice buffers. |
| Sampler / SAM | `sampler` | `freq-input`, `gate-input` | `output` | Records/re-records a 5 second 12 kHz mono microphone sample on the main thread and plays it in the worklet. Trigger mode is mono/restart; gate-wired mode is poly with independent sampler playback slots and tails continue until sample end. |
| Scope / SCO | `scope` | `signal-input` | `signal-output` | Passthrough plus per-module scope buffer and UI scope data publishing. |
| Track Output | `track-output` | `audio-input` | none | Internal fixed output endpoint for each track. |

### Keyboard modules

- Three modules are registered per track: `{trackId}:keyboard-cv`, `{trackId}:keyboard-gate`, `{trackId}:keyboard-velocity`.
- The UI renders them as one fixed `Keyboard` singleton.

### Oscillator (`oscillator`)

- FREQ input is exponential pitch offset in V/octave: `finalFreq = baseFreq * 2^V`.
- AMP input scales slider amplitude: `finalAmp = amplitude * clamp(V / 5, 0, 1)`.
- AMP slider stores linear gain 0-2. UI uses two-segment log scale: left half -60 dB to 0 dB, right half 0 dB to +6 dB.
- Shape: `0` square, `0.5` sine, `1` triangle.
- Duty is clamped 2-98% and applied on peak/trough-aligned phase.
- Per-voice state: `{ phase, lastTime }`.

### Filter (`filter`)

- Cutoff range: 20-20000 Hz, exponential slider with reversed direction.
- Cutoff CV: `finalCutoff = baseCutoff * 2^(V / 5)`.
- Resonance CV: `finalResonance = baseResonance + V / 20`, clamped 0-0.99.
- Per-voice state: `{ lowpass, bandpass }`.

### Envelope (`envelope`)

- State machine: `idle -> attack -> decay -> sustain -> release -> idle`.
- On retrigger, attack ramps from the current envelope value rather than from zero.
- Attack/decay/release CV inputs nudge exponentially with `* 2^(V / 10)`.
- Sustain CV uses linear additive `+ V / 20`.
- Time range per stage: 0.001-10 seconds.

### Random Voltage Generator (`random`)

- Rate CV: `finalRate = baseRate * 2^(V / 10)`.
- Per-voice state: `{ lastOutputTime, currentValue }`.

### VCA (`vca`)

- Gain slider: 0-2x, default 1.
- Gain CV: `finalGain = clamp(gain + V / 5, 0, 2)`.
- Polarity toggle: `+` normal or `-` phase invert.

### MFX (`mfx`)

- Delay mode: up to 2000 ms. `time-input` CV nudges delay time by about +/-200 ms/V. Feedback range 0-0.8. Mix range 0-1 dry/wet.
- Reverb mode: Freeverb-style, 4 parallel comb filters plus 2 series all-pass filters. `time` is room size 0-1 and controls comb feedback 0.7-0.9. `feedback` controls damping. Mix range 0-1 dry/wet.
- Delay and reverb state are independent per voice.

### Sampler (`sampler`)

- Records a 5 second mono sample at 12 kHz from the microphone using the SAM `RECORD` button.
- Recording and resampling happen on the main thread; playback happens only in the synth AudioWorklet.
- The recorded frequency is captured at record time and used as the reference for playback speed.
- `freq-input` is exponential V/octave playback speed modulation on top of the frequency slider.
- If `gate-input` is not wired, `TRIGGER` starts playback and a second trigger restarts the sample in mono mode.
- If `gate-input` is wired, the trigger button is disabled and gate rising edges allocate sampler playback slots.
- SAM maintains its own sampler playback allocation separate from the track voice pool.
- Sample playback continues after gate/note-off until the sample ends.
- New gate triggers use free sampler playback slots first. Only when all sampler slots are active does SAM steal the oldest active sampler playback.

### Scope (`scope`)

- Input is passed through unchanged as `signal-output`.
- Per-module scope buffer is 4096 samples.
- Voices are summed per audio frame so only one scope sample is written per frame regardless of voice count.
- Zero-crossing trigger searches backward for a rising edge within 1000 samples before the write index.
- Publishes `module-scope-data` messages. `audioEngine.js` routes them to `subscribeToModuleScopeData(moduleId, fn)` listeners.
- Display auto-scales with a 5-frame peak history.

### Module instance numbering

- `instanceNum` is `max(existing instanceNums of same type on this track) + 1`.
- ID pattern: `{trackId}:{type}-{instanceNum}`.
- UI headers display labels such as `VCO - 1`, `VCF - 2`, `SAM - 1`, `SCO - 1`.
- Deleting a module does not reuse an instance number while higher instance numbers still exist.

---

## Polyphonic Voice Architecture

- Default polyphony is 4 voices per track.
- Track polyphony is configurable from 1 to 16 through `track.polyphony`.
- Voice states are only `'free'` and `'active'`.
- `getActiveVoices(trackState)` returns only voices with `state === 'active'`.

### Poly mode, polyphony >= 2

1. Prefer oldest freed voice: `voiceFreeOrder[0]`.
2. Fallback to any free voice not yet in free order.
3. Last resort: steal oldest active voice from `voiceAllocationOrder[0]`.

`voiceAllocationOrder` stores active voice IDs in press order. `voiceFreeOrder` stores free voice IDs in release order.

### Mono mode, polyphony = 1

- A note stack is maintained.
- New notes push onto the stack.
- Releasing the current note resumes the previous held note, using last-note priority.
- Portamento interpolates CV from the previous note over `portamentoTime` seconds.
- Gate stays high while any key is held.

### Voice mixing per track

- Each voice contributes `voiceSignal / 10`.
- A non-voice-dependent output contributes `outputRead(sampleTimeMs, null) / 10`.
- Multi-track normalization applies `1 / sqrt(activeTrackCount)` when more than one track is active.

---

## Sequencer Playback Engine

Key exports from `sequencer.js`:

- `loadSession(sessionMeta, tracks)`: loads session, computes `noteSegments`, resets playback to 0.
- `updateSession(sessionMeta, tracks)`: preserves playback state and reschedules from current position if playing.
- `play()`: schedules note events using `setTimeout` and starts rAF progress updates.
- `stop()`, `rewind()`, `seekTo(ms)`.
- `getPlaybackPositionMs()`: current position, or 0 if no sequence is loaded.
- `getIsPlaying()`: boolean.
- `subscribeToTransport(fn)`: transport state subscription.
- `importMidiFile(arrayBuffer)`: MIDI to session conversion through `midiConvert.js`.
- `startRecording()` / `stopRecording()`: wall-clock based note recording using `performance.now()` for duration accuracy.

---

## UI Conventions

### Layout

- Two view modes: VOICE and NOTES, toggled by folder-style tabs in the top toolbar.
- VOICE mode has a fixed 80px keyboard panel on the left, a center module canvas, and a fixed 80px amplifier strip on the right.
- NOTES mode shows the piano roll; module add buttons are hidden.
- Toolbar is always visible and contains the MOTH logo, view tabs, selected track name, polyphony, optional PORTA slider, MIDI selector, load/save/reset/import controls, BPM, and audio status.
- Transport at the bottom contains track list, mini timelines, playback controls, recording control, and voice status.

### Folder-style tabs

- Active tab: `alignSelf: flex-end`, `marginBottom: -2px`, `borderBottom: '2px solid #101010'`, `zIndex: 1001`.
- Inactive tabs are shorter, darker, and dimmer.
- Toolbar uses `overflow: visible` and `position: relative` so active tabs can bleed through the toolbar border.

### Green track selection

- Selected track row background: `#0d1f0d`.
- Selected track row left border: `3px solid #5aaa5a`.
- Selected track text and navbar track name: `#8adb8a`.

### Canvas

- `src/components/Canvas.jsx` exists but is not used. The active canvas is the inline `Canvas` function at the bottom of `App.jsx`.
- Module positions are stored as `{ x, y }` on module objects and are visual only. They must not affect audio graph state.

### Modules and dragging

- `ModuleShell` header/banner starts dragging through `onMouseDown`.
- Controls inside module bodies must not initiate drag.
- Dragging uses global `mousemove`/`mouseup`, not the HTML5 drag API.
- Drag coordinates use `getBoundingClientRect()` on the canvas container.

### Ports and connections

- Ports are 18px circles rendered in flow within module bounds.
- Inputs appear on the left with red borders; outputs appear on the right with blue borders; ports turn green while connecting.
- One connection is allowed per input port. Connecting to an occupied input removes the existing connection first.
- Wire drag line is visible over all panels.
- Connections render as SVG bezier curves in a fixed-position overlay with `z-index: 9999` and `pointer-events: none`.
- Wire endpoints have green 4px circle endcaps.
- Port positions are calculated live with `getBoundingClientRect()` and normalised to the main content area.

### Sliders

- Labels always show the current base/offset value regardless of CV connection state.
- Sliders do not visually respond to incoming CV.
- Oscillator, random, and sampler frequency sliders are logarithmic from 0.1 to 8000 Hz.

### Track names

- Track names are editable by clicking them in the transport strip.

### Playhead animation

- Each `TrackRow` in `Transport.jsx` runs its own `requestAnimationFrame` loop.
- The loop calls `getPlaybackPositionMs()` and `getIsPlaying()` directly.
- The loop writes `playheadRef.current.style.left` directly and does not call `setState`.

### Notes-mode viewport bounding box

`PianoRoll` reports the visible region to `App` through `onViewportChange(vp)`:

```js
{
  startMs,
  endMs,
  topFraction,
  bottomFraction
}
```

- `onViewportChange` is a stable `useCallback` in `App.jsx`.
- Updates occur on scroll, `totalCells` changes, and container resize via `ResizeObserver`.
- Transport `TrackRow` renders the viewport box using `startMs / timelineDurationMs` and `topFraction` as CSS percentages.

---

## Shared UI Components

| Component | Description |
|---|---|
| `ModuleShell` | Outer wrapper for modules. Background `#3a3a3a`, border `2px solid #666`, radius 18px, header `#2e2e2e`, draggable header, optional remove button. |
| `Port` | 18px round socket. Input red border, output blue border, green while connecting. |
| `InputPort` | Port on the left and label on the right. Used for plain signal/CV inputs without sliders. |
| `OutputPort` | Label on the left and port on the right. Accepts optional children before the label. |
| `InputSlider` | Label above a port plus range input row, optional tick labels below. |
| `AppSelect` | Styled select matching toolbar controls. Used for MIDI device, MIDI channel, POLY, and similar selects. Replaced the deleted `SelectControl`. |
| `ControlBlock` | Compact labelled control wrapper used in amplifier knobs and toolbar PORTA slider. |
| `NavDivider` | Vertical toolbar separator. |
| `ToolbarButton` | Standard toolbar/transport button. |
| `SmallButton` | Compact inline button for track row actions. |

Label colours: main labels `#bbb`, tick labels `#aaa`, module titles `#ccc`. Green accent family: `#5aaa5a` and `#8adb8a`.

---

## Known Architecture Notes

- `src/components/Canvas.jsx` is old/unused. The active canvas is inline in `App.jsx`.
- `Amplifier.jsx` is the right-side track strip for volume, EQ, pan, and solo. The signal amplifier module is `VCA.jsx`.
- Keyboard module types must be registered in `App.jsx` when each track is set up and resolved in `resolveSourceModuleId()`.
- Multi-output UIs use `App.jsx` to map clicked output ports to registered source IDs. Multi outputs resolve to the module ID because both outputs carry the same signal.
- Build output in `dist/` may change asset hashes after `npm run build`; do not mix generated hash churn with source changes unless intentionally updating built assets.

---

## Feature Status

- [x] Multitrack architecture from MIDI import or manual track creation
- [x] Per-track module graphs and connection state
- [x] Polyphonic voice engine with configurable 1-16 voice polyphony
- [x] Flat note data model with derived `noteSegments`
- [x] MIDI import through `midi-file`
- [x] Transport playback: play, stop, rewind, seek
- [x] Direct-DOM playhead animation
- [x] Editable track names in transport
- [x] Split audio engine files: `sequencer.js`, `noteUtils.js`, `trackMigration.js`, `midiConvert.js`
- [x] MFX module with delay and reverb
- [x] SAM sampler module with microphone recording and worklet playback
- [ ] Record MIDI notes into the active track, overriding note information where recording is active at the playhead
