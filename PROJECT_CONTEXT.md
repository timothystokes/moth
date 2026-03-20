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
- [x] Web MIDI API Integration
    - Automatic MIDI device detection and connection
    - Polyphonic: multiple simultaneous notes supported
    - Note on/off with velocity; virtual keyboard uses same voice allocation system
- [x] Amplifier (singleton, fixed right panel). Inputs: audio, amplitude CV. No output — connects directly to Web Audio API
    - Built-in oscilloscope displaying waveform with zero-crossing trigger alignment
    - Uses a circular buffer to prevent tearing when drawing sampled values
    - Handles polyphonic voice mixing: processes each active voice separately and mixes together
- [x] Power button in top-right of toolbar to initialise the Web Audio API


## Technical Stack
- **Language:** JavaScript
- **Framework:** React 18
- **Build Tool:** Vite
- **Runtime:** Browser (Node.js for dev tooling only)
- **Dependencies:** React, ReactDOM (no other libraries)
- **Version Control:** Git


## Architecture

### Signal Model
All inter-module signals are pseudo-voltages evaluated as pure functions over time:
- **1V/octave** for pitch CV (A4 / MIDI 69 = 0V)
- **±10V** for audio signals
- **0–1** for gate values (0 = off, velocity value when held)
- **0–1** for velocity values

### Universal Processor Signature
All audio processing functions use: `(time, voiceContext, inputFns) => outputValue`
- `time`: milliseconds (derived from `e.playbackTime` in the amplifier's ScriptProcessorNode callback)
- `voiceContext`: `{ cv, gate, velocity, voiceId }` or `null` for global modulators (e.g. LFOs)
- `inputFns`: object mapping input names to functions `(time, voiceContext) => value`
- All input function calls must pass `voiceContext` through so it cascades the entire signal chain
- Components may use or ignore specific voiceContext fields based on their purpose

### Audio Engine (`audioEngine.js`)
- Modules register a processor function via `registerModule(id, processorFn)`
- Connections create wrapper functions that look up the current module output function, allowing modules to re-register with updated parameters without breaking connections
- Per-voice output caching using `${time}-${voiceId}-${moduleId}` keys; cache clears each time step
- If a connection's source module no longer exists, that input is omitted so the destination falls back to its slider/default value exactly as if unplugged
- Only the Amplifier uses the Web Audio API (`AudioContext`). All other modules are pure math

### Polyphonic Voice Architecture (`voiceAllocator.js`)
- Pool of 16 voices (`MAX_VOICES`)
- Voice states: `FREE`, `ACTIVE` (note held, gate > 0), `RELEASE` (note released, gate = 0)
- **Voice lifecycle:**
    1. **Note On:** allocate a free voice, set CV/gate/velocity (gate = velocity 0–1)
    2. **Note Off:** set gate to 0
        - Gate monitoring disabled (default): voice immediately returns to `FREE` and is available for reuse
        - Gate monitoring enabled: voice enters `RELEASE` state, persists until output is silent
    3. **Silence detection** (gate monitoring only): after 100 consecutive near-zero samples (threshold 0.0001), voice returns to `FREE`
    4. **Voice stealing:** if all voices busy, steal a releasing voice first, then the oldest active voice
- `getActiveVoices()` returns `ACTIVE`, `RELEASE`, and `FREE` voices that still have a non-zero CV (for gate-monitoring-disabled mode where freed voices keep sounding)
- Gate monitoring is currently always disabled; intended to be enabled automatically when envelope generators are connected
- Voice CV uses A4 / MIDI 69 = 0V so patched oscillator FREQ inputs align naturally with a 440Hz base tuning

### Amplifier Voice Processing
- Loops through all voices from `getActiveVoices()`
- Calls the audio chain for each voice with its unique voiceContext
- Reports each voice's output level to the voice allocator for silence detection
- Mixes voices with `1/sqrt(n)` scaling to prevent clipping
- Falls back to non-voice mode (null voiceContext) when no voices are active, allowing LFOs and other global modulators to be heard
- Amplitude CV detection: uses module ID (checks for `-gate` suffix) to distinguish gate signals (multiply) from standard CV (add offset)
- Enables gate monitoring only when an envelope output is actually connected into the patch

### Gate Signal Handling
- Keyboard registers both a CV output module (`keyboard-singleton-cv`) and a gate output module (`keyboard-singleton-gate`)
- Keyboard registers a gate output module (`keyboard-singleton-gate`) that returns `voiceContext.gate` per voice
- Envelope modules require a dedicated `GATE IN` socket; patch keyboard `GATE OUT` here to start ADSR cycles
- Oscillator amplitude input uses value-range detection: values in 0–1 multiply (VCA), values outside that range add offset (CV)
- These two detection methods (ID-based in amplifier, value-based in oscillator) are independent implementations


## UI & Interaction

### Layout
- **Left panel** (fixed, 200px): Keyboard module
- **Centre canvas** (flex-grow): draggable modules on a grid background
- **Right panel** (fixed, 200px): Amplifier module
- **Toolbar** (top, 50px): buttons to add modules + power button

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
- Port positions are calculated live from the DOM via `getBoundingClientRect()` on each render

### Slider Behaviour
- When no connection is present, sliders provide the base parameter value (displayed as text)
- When a connection is present, the slider still sets the base value which is then modulated by the incoming signal
- Slider labels show the current value only when unconnected; when connected, just the parameter name is shown
- Sliders do not visually move in response to incoming CV — they act as offsets/multipliers for the signal stream
- Oscillator frequency range goes down to 0.1 Hz, allowing use as an LFO
- Random generator rate uses the same logarithmic slider range and formatting as oscillator frequency
