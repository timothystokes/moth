# Project Context & Criteria

## Project Overview
**Project Name:** MOTH1  
**Created:** February 12, 2026  
**Status:** Planning/Initial Development

### Description
Web based modular synthesiser

### Goals & Objectives
- [x] Oscilator with sliders for frequency and amplitude and shape. Inputs: frequency and amplitude and shape (Sawtooth, Square and Sin). Output: audio
    - Amplitude input detects signal type: gate signals (0-1 range) multiply slider value (VCA behavior), CV signals (±10V) add offset
    - When gate connected, slider sets maximum amplitude (gate acts as volume control multiplier)
- [x] Filter with 2 Sliders and 2 Inputs for Cutoff and Resonance. 1 audio output
    - The filter should have a switch to say if it's a low pass or high pass filter. And should implement the logic to apply the filtering based on the cutoff and resonance to the input values before they are passed to the output.
    - Filter uses state variable filter (second-order) for proper resonance peaks
    - Cutoff slider uses exponential scaling (reversed direction) for musical feel
    - Maintains separate filter state per voice for clean polyphonic operation
- [x] Random Voltage Generator with rate slider and input
    - Generates random voltage values between -10V and +10V at adjustable rate (0.1-50 Hz)
    - Rate can be modulated via CV input
    - Useful for creating random modulation, texture, and variation
- [ ] Envelope generator with 4 sliders, 4 inputs and 1 output
- [x] Virtual Keyboard that can be used with a mouse and which generates a key signal (1v per octave)
    - Keyboard displays 88 keys (A0 to C8) with proper black/white key layout in vertical orientation
    - Integrated with Web MIDI API for hardware MIDI controller support
    - Keyboard is implemented as a singleton in a fixed left-hand panel
    - Virtual notes can be triggered via mouse or MIDI input
    - Registers a gate output module that returns per-voice gate values (0-1) from voiceContext
- [x] Web MIDI API Integration
    - Automatic MIDI device detection and connection
    - Support for multiple simultaneous notes (polyphonic)
    - Note on/off messages with velocity support
    - Virtual keyboard acts as both UI and MIDI input
- [x] Amplifier. Sliders for Amplitude. Inputs: Amplitude, Output: NONE. it goes directly to the web audio interface. 
    - Should show a small Oscilliscope showing the actual values over time visually.
    - The oscilliscope should auto scale to some degree to focus on showing the shapes. i.e. at very low frequencies one cycle should be shown. At very high frequencies no more than 40 cycles should be shown.
    - The Oscilliscope should start each sample when it observes the previous 3 values below 0 and the next 3 values above 0. i.e. when the wave crosses the 0 threashold. In this way the waves will visualy align for each frame and make the waveform easier to see. 
    - Use a buffer the width of the oscilliscope to ensure there is not page tearing when draweing the sampled values. 
    - The zero crossing function needs to be done before the 360 samples are processes else the display will read into the next cycle the amount that is dropped before the crossing point.
    - Now handles polyphonic voice mixing - processes each active note separately and mixes them together
- [x] A power button to connect the web audio api should be shown on the top right of the top nav bar. 


## Technical Stack

### Languages & Frameworks
- **Primary Language:** JavaScript
- **Frameworks:** React
- **Runtime/Platform:** Node.js

### Dependencies & Libraries
- Pure React

### Development Tools
- **Build Tools:** npm
- **Testing Framework:** 
- **Linting/Formatting:** 
- **Version Control:** Git

## Architecture & Structure

### Polyphonic Voice Architecture (NEW - February 15, 2026)
- **Voice Allocation System**: Persistent voice allocation with silence-based deallocation
  - Pool of 16 voices (configurable MAX_VOICES)
  - Voice states: FREE (available), ACTIVE (note held), RELEASE (note off but still audible)
  - Voices persist until their output is consistently zero (silence detection)
  - Sequential notes reuse the same voice (frequency changes but voice continues)
  - Simultaneous notes use multiple voices
- **Voice Lifecycle**:
  1. Note On: Allocate a free voice, set CV/gate/velocity (gate = velocity 0-1)
  2. Note Off: Set gate to 0 (RELEASE state)
     - **If gate monitoring disabled** (no envelope connected): Voice immediately returns to FREE state but continues playing with same CV/frequency. Available for next note to reuse.
     - **If gate monitoring enabled** (envelope connected): Voice stays in RELEASE state until output is silent
  3. Silence Detection: After 100 samples of near-zero output, voice returns to FREE state (only when gate monitoring enabled)
  4. Voice Stealing: If all voices busy, steal oldest voice or releasing voice
- **Gate Monitoring Mode**:
  - **Disabled (default)**: Voices become FREE immediately on note release, oscillator keeps playing same frequency
  - **Enabled**: Voices persist in RELEASE state until envelope closes and output goes silent
  - Automatically enabled when envelope generators are connected (future implementation)
  - Sequential notes instantly reuse the same voice when monitoring disabled
- **MIDI Integration**: Web MIDI API integrated via `midiManager.js` for hardware MIDI controller support
  - Note on triggers voice allocation
  - Note off triggers voice release (not deallocation)
  - Virtual keyboard events use same allocation system
- **Voice Context**: Each audio processor receives `voiceContext` parameter containing:
  - `cv`: MIDI note as 1V/octave voltage (C2/MIDI 36 = 0V)
  - `gate`: 0 (note off) to 1 (full velocity when note held)
  - `velocity`: Normalized velocity 0-1 (frozen at note-on)
  - `voiceId`: Unique identifier for the voice (e.g., `voice-5`)
- **Audio Engine**: 
  - Processor signature: `(time, voiceContext, inputFns) => outputValue`
  - Per-voice caching using `${time}-${voiceId}-${moduleId}` cache keys
  - Module state (filters, envelopes) maintains separate state per voice
- **Voice Context Cascading (CRITICAL)**:
  - ALL components MUST accept `(time, voiceContext, inputFns)` in their processor function
  - ALL components MUST pass voiceContext when calling ANY input function
  - Components may use or ignore specific parts of voiceContext (cv, gate, velocity) based on their purpose
  - Example: Oscillator uses CV for pitch but ignores gate (envelope will handle gate later)
  - Example: Filter passes voiceContext through but doesn't directly use cv/gate
  - The voiceContext cascades automatically through the entire signal chain
- **Amplifier Voice Processing**:
  - Loops through all ACTIVE and RELEASE voices from voice allocator
  - Calls audio chain for each voice with unique voice context
  - Monitors each voice's output level after processing
  - Updates voice allocator with output levels for silence detection
  - Mixes voices together with sqrt(n) scaling to prevent clipping
  - Falls back to non-voice mode for LFOs and other global modulators
  - Detects gate signals (0-1 range) vs CV signals (±10V): gates multiply, CV adds
- **Gate Signal Handling**:
  - Keyboard registers gate output module that returns `voiceContext.gate` per-voice
  - All voices have their own gate value (0 = note off, 0-1 = velocity when held)
  - When gate is 0, all voices produce zero amplitude (silence)
  - Components that receive gate inputs (oscillator amplitude, future envelope) detect 0-1 range and multiply instead of add
  - This enables VCA (voltage controlled amplifier) behavior where slider sets maximum and gate controls actual level

### Core Architecture
- Completely functional based coding style (no objects)
- Modular (1 file per audio component)
- ALL Signals between Component are sent using a pseudo voltage sent as a non-integer number and a time signature sent as an integer in milliseconds.
    - 1v per octave for frequency control (C2/MIDI 36 = 0V)
    - -10v to +10v for audio signals
    - 0 to 1 for gate values (0 = off, 0-1 = velocity/intensity)
    - 0 to 1 for velocity values
- Sound modules use those signals to calculate or process input
- **Universal Processor Signature**: ALL audio processing functions MUST use signature `(time, voiceContext, inputFns) => outputValue`
  - `time`: Milliseconds since audio started
  - `voiceContext`: Object containing `{ cv, gate, velocity, voiceId }` (or null for global modulators)
  - `inputFns`: Object mapping input names to functions that accept `(time, voiceContext)`
  - Components may use or ignore cv/gate/velocity based on their purpose (e.g., oscillator uses cv but ignores gate)
  - ALL input function calls MUST pass voiceContext through: `inputFn(time, voiceContext)`
- Only the Amplifier should use the audioContext directly. All other modules are pure mathematical and pass signals via the connectors as values over time.
- The Audio processing should not be passed via react component attributes. It should be processed as an independent pure functional process. The Amplifier uses ScriptProcessorNode's onaudioprocess callback with e.playbackTime for precise timing.
- Don't keep a map of connections, when a connection is made then create a direct higher order function reference between the audio processing functions. The connection stores a wrapper function that looks up the current module output function, allowing modules to re-register with updated parameters.
- The functional references can be direct. You can assume that any input/output can only have a single route.
- Once the connections are chained then the function calls will cascade without having to perform any explicit recursion or looping process.
- The time reference should be generated by the amp and passed explicitly to all functions cascading all the way back to the oscillators. Voice context (cv/gate/velocity) is also passed through the chain.
- The Amp module is a singleton and should always be shown on the canvas at initialization.
- The jacks on the side should just look like squares (16px) sticking out from the side of the module edges using absolute positioning. The labels should be on the inside of the modules. No circles.
- No outline colours when the modules are active.
- The only indicator of things being on should be the power button only on the amplifier module only.
- Connection line positions are calculated using getBoundingClientRect() to get the actual DOM center of each port element, ensuring perfect alignment regardless of module layout.

### Design Patterns
- Web Components where input and output between modules is connected using drag and drop showing a visual connection.
- Components can be dragged around the screen where the connections remain intact (though connections store positions at connection time).
- Each Module should have a banner that is used to initiate dragging it. The rest of the module below the banner should allow normal control operation without the module moving.
- Connections between modules should be connected by dragging the mouse from input/output on one module to input/output on another. Only a single connection can be made between any two ports. If a port is clicked on that has an existing connection then the first thing to happen is that the existing connection should be removed and the UI should allow a new connection to be made. If the user clicks onto no port for the other end then no new connection is established and the UI returns to normal mode.
- The connections between modules MUST ALWAYS be drawn over the top of the view from the relevant input and output ports as SVG paths with z-index 9999.
- The connection points should stick out the side of each module AND should align horizontally to their equivalent sliders where a slider exists for the same control. They share the same label above the port and slider. When no connection is present, sliders provide the base value for the parameter. When a connection IS present, the slider still provides the base value which is then modulated by the connected signal. For example, an oscillator with frequency slider at 130Hz and a 1V CV input connected will produce 260Hz (130 * 2^1). The slider acts as a base frequency that the CV shifts exponentially according to 1V/octave. Modulation voltages (±10V) are scaled appropriately (exponential for frequency, linear for amplitude, etc.) and combined with the base slider value. Generally inputs on the left (red border) and outputs on the right (blue border). Green border when connecting.
- Regardless of the order the connections are wired by the user they should always be drawn from output to input.
- Connection positions are stored at the moment of connection using getBoundingClientRect() to capture exact port center coordinates.
- Ensure there is logic to apply the input jack's assigned function (via a connection) to the amplitude when calculating each value in the audio loop. i.e. a control voltage attached to the Amp port on the Apolifier would modulate the volume from a second oscilator instance if i connected it. The slider position should not actually move based on the port value as it becomes an adjuster for the stream of values not a visual representation of the values.
- Values of each slider should be displayed when there is no connection.
- The Oscilator frequency range should allow low frequencies so they can be used as LFOs.
- seeing as the amplifier is always shown. lock it in as a right hand panel of the UI that is always there. Taking up the full right hand column of the canvas (200px width).
- Keyboard module is locked in as a left hand panel of the UI that is always there. Taking up the full left hand column of the canvas (200px width).
- Central canvas area uses flex-grow: 1 for draggable modules.
- Modules on the canvas can be dragged using mouse events (onMouseDown on module banner + global mousemove/mouseup listeners).
- Drag calculations account for canvas offset (subtracting canvasRect.left and canvasRect.top from clientX/clientY).
- No drag ghost images appear (using pure mouse event system, not HTML5 drag API).
- Connections displayed as SVG lines with bezier curves in a fixed-position overlay (position: fixed, top: 0, left: 0, width: 100vw, height: 100vh, pointer-events: none, z-index: 9999) covering the entire viewport.
- Port positions calculated using getBoundingClientRect() for accurate connection rendering across all panels (left fixed panel, canvas, right fixed panel).