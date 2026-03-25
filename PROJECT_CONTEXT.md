# Project Context & Criteria

## Project Overview
**Project Name:** MOTH1  
**Created:** February 12, 2026  
**Status:** Active Development

### Description
Web-based modular synthesiser built with React and Vite.

### Goals & Objectives
- [x] Oscillator with sliders and inputs for frequency, amplitude, and shape. Output: audio (±10V)
    - Shape blends continuously: square (0) → sine (0.5) → triangle (1)
    - Frequency slider defaults to A4 = 440Hz
    - Keyboard CV affects oscillator pitch only when patched into the FREQ input
    - FREQ input is a relative exponential pitch offset around the slider value
    - Amplitude input detects signal type by value range: gate signals (0–1) multiply slider value (VCA behaviour), CV signals (outside 0–1) add offset
    - When gate connected, slider sets maximum amplitude; gate acts as volume control multiplier
    - Duty control is clamped to 2%–98% and always applies on a peak/trough-aligned phase basis
    - On the SQR←SIN side, square-style pulse width is introduced gradually as shape moves toward square
- [x] Filter with low-pass/high-pass switch. Inputs: audio, cutoff, resonance. Output: audio
    - State variable filter (second-order) for proper resonance peaks
    - Cutoff slider uses exponential scaling (reversed direction) for musical feel
    - Maintains separate filter state per voice for clean polyphonic operation
- [x] Random Voltage Generator with rate slider and rate CV input. Output: random voltage (±10V)
    - Generates random values between −10V and +10V at adjustable rate (0.1–2000 Hz)
    - Rate slider uses the same logarithmic mapping as oscillator frequency
    - Rate CV applies a relative exponential nudge (scaled so ±10V = ±1 octave)
- [x] Envelope generator with 4 sliders (ADSR), 4 CV inputs, and 1 output
    - Triggered from an explicit `GATE IN` input
    - Attack, decay, and release use logarithmic time sliders and relative exponential CV nudges
    - Sustain uses a 0–1 slider with additive CV offset
    - Output is 0–1, intended for VCA / amplitude modulation and other control uses
    - When any envelope output is connected, released voices remain active until the envelope reaches silence
- [x] Virtual Keyboard (singleton, fixed left panel)
    - 88 keys (A0 to C8) in vertical orientation with proper black/white layout
    - Integrated with Web MIDI API for hardware controller support
    - Outputs: CV (1V/octave, A4 / MIDI 69 = 0V) and Gate (0–1 per voice from voiceContext)
    - Virtual notes triggered via mouse click or MIDI input
    - Keyboard socket outputs now define whether a patch is voice-dependent; unpatched modules stay on slider/default values only
    - When `GATE OUT` is unpatched, latch mode keeps voice 1 available as an always-on keyboard control source
- [x] Web MIDI API Integration
    - Automatic MIDI device detection and connection
    - Polyphonic: multiple simultaneous notes supported
    - Note on/off with velocity; virtual keyboard uses same voice allocation system
    - MIDI file transport can load `.mid/.midi` files, extract playable channels, and schedule note playback through the same note-on/note-off path as live keyboard/MIDI input
- [x] Amplifier (singleton, fixed right panel). Inputs: audio, amplitude CV. No output — connects directly to Web Audio API
    - Built-in oscilloscope displaying waveform with zero-crossing trigger alignment
    - Uses a circular buffer to prevent tearing when drawing sampled values
    - Handles polyphonic voice mixing only when the patched signal graph depends on per-voice keyboard CV/gate data; otherwise evaluates once in global mode
- [x] Power button in top-right of toolbar to initialise the Web Audio API
- [x] Bottom transport bar
    - Fixed transport strip across the bottom of the UI
    - Supports upload, play, stop, and rewind for MIDI files
    - Shows loaded sequence name, selected channel, event count, and duration
    - Channel selector lists only playable MIDI channels and rebinds the active sequence


## Technical Stack
- **Language:** JavaScript
- **Framework:** React 18
- **Build Tool:** Vite
- **Runtime:** Browser (Node.js for dev tooling only)
- **Dependencies:** React, ReactDOM, midi-file
- **Version Control:** Git


## Architecture

### Signal Model
All inter-module signals are pseudo-voltages evaluated as pure functions over time:
- **1V/octave** for pitch CV (A4 / MIDI 69 = 0V)
- **±10V** for audio signals
- **0–1** for gate values (0 = off, velocity value when held)
- **0–1** for velocity values

### Universal Processor Signature
All audio processing functions conceptually use: `(timeMs, voiceContext) => outputValue`
- `timeMs`: milliseconds derived inside the AudioWorklet sample loop
- `voiceContext`: `{ noteNumber, cv, gate, velocity, voiceId }` for voice-dependent graphs, or `null` for global evaluation
- Voice context now propagates only when the patched graph depends on keyboard CV/gate or modules downstream of them
- Unpatched module inputs fall back to slider/default values exactly as if no MIDI note existed

### Audio Engine (`audioEngine.js`)
- Modules register serializable module definitions via `registerModule(id, module)` and the AudioWorklet evaluates them sample-by-sample
- Connections are mirrored into the worklet as `fromModuleId -> toModuleId.inputName`
- Per-frame output caching uses `${voiceId|global}|${moduleId}` keys and clears each sample
- If a connection's source module no longer exists, that input is omitted so the destination falls back to its slider/default value exactly as if unplugged
- The amplifier owns the Web Audio API lifecycle (`AudioContext`, worklet init, scope subscription)

### Polyphonic Voice Architecture (`voiceAllocator.js`)
- Pool of 8 voices (`MAX_VOICES`)
- Voice states: `FREE`, `ACTIVE` (note held, gate > 0), `RELEASE` (note released, gate = 0)
- **Voice lifecycle:**
    1. **Note On:** allocate a free voice, set CV/gate/velocity (gate = velocity 0–1)
    2. **Note Off:** set gate to 0 and move the voice into `RELEASE`
    3. **Release persistence:** released voices remain in the mix with their existing voice context until a later note-on reassigns that voice slot
    4. **Voice assignment:** each new gate event advances a strict cyclic ring and reuses the next voice in sequence regardless of free/release state
- `getActiveVoices()` returns only `ACTIVE` and `RELEASE` voices
- Keyboard latch mode reserves voice 1 as the default always-on control voice when keyboard gate is not patched
- Voice CV uses A4 / MIDI 69 = 0V so patched oscillator FREQ inputs align naturally with a 440Hz base tuning

### Amplifier Voice Processing
- Determines whether the amplifier input graph is voice-dependent by tracing connections back through modules
- If the graph depends on keyboard CV/gate, it evaluates once per active voice and mixes with `1/sqrt(n)` scaling
- If the graph is not voice-dependent, it evaluates once in global mode regardless of incoming MIDI notes
- Released voices remain in the voice mix until their voice slot is reassigned by the ring allocator
- Scope capture now performs trigger alignment inside the worklet from the continuous audio ring buffer before publishing snapshots to the UI

### Gate Signal Handling
- Keyboard registers both a CV output module (`keyboard-singleton-cv`) and a gate output module (`keyboard-singleton-gate`)
- Keyboard gate output returns `voiceContext.gate` per voice; keyboard CV output returns `voiceContext.cv`
- Envelope modules require a dedicated `GATE IN` socket; patch keyboard `GATE OUT` here to start ADSR cycles
- Oscillator amplitude input uses value-range detection: values in 0–1 multiply (VCA), values outside that range add offset (CV)
- MIDI note events now affect a patch only through keyboard-driven voice-dependent paths; oscillators without keyboard/CV connections remain controlled solely by sliders and patched inputs
- Envelope state is tracked per envelope instance and per voice context; repeated same-pitch notes are allowed to overlap, and earlier instances continue through release on their existing voice slots

### MIDI File Transport
- MIDI files are parsed in the browser with `midi-file`
- Tempo changes are respected when converting MIDI ticks to playback milliseconds
- Transport state includes loaded file name, selected channel, available playable channels, event count, duration, playback position, and playing state
- Playback, stop, and rewind use scheduled note-on/note-off events routed through the same audio engine path as live MIDI input
- Changing the selected MIDI channel stops playback, rewinds, and swaps the active event list for that file


## UI & Interaction

### Layout
- **Left panel** (fixed, 200px): Keyboard module
- **Centre canvas** (flex-grow): draggable modules on a grid background
- **Right panel** (fixed, 200px): Amplifier module
- **Toolbar** (top, 50px): buttons to add modules + power button
- **Transport** (bottom, 78px): MIDI file slot, transport controls, and channel/sequence metadata

### Modules
- Each module has a banner bar for drag initiation; controls below the banner work without moving the module
- Dragging uses `onMouseDown` on the banner + global `mousemove`/`mouseup` listeners (not HTML5 drag API — no ghost images)
- Drag coordinates account for canvas offset via `getBoundingClientRect()`

### Ports & Connections
- Ports are 16px squares with absolute positioning, protruding from module edges
- Inputs on the left (red border), outputs on the right (blue border), green when connecting
- Ports align horizontally with their corresponding sliders; they share the same label
- Clicking a port starts a connection; clicking a second port completes it (output↔input only; same-type connections are rejected)
- Clicking a port that already has a connection removes it first, then starts a new connection drag
- Clicking the canvas background cancels an in-progress connection
- Each port supports only a single connection
- Connections are rendered as SVG bezier curves in a fixed-position overlay (`z-index: 9999`, `pointer-events: none`)
- Port positions are calculated live from the DOM via `getBoundingClientRect()` on each render and normalized to the main content area so the bottom transport does not disturb cable rendering

### Slider Behaviour
- When no connection is present, sliders provide the base parameter value (displayed as text)
- When a connection is present, the slider still sets the base value which is then modulated by the incoming signal
- Slider labels show the current value only when unconnected; when connected, just the parameter name is shown
- Sliders do not visually move in response to incoming CV — they act as offsets/multipliers for the signal stream
- Oscillator frequency range goes down to 0.1 Hz, allowing use as an LFO
- Random generator rate uses the same logarithmic slider range and formatting as oscillator frequency
