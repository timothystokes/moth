# Project Context

## Project Overview
**Project Name:** MOTH1
**Status:** Active Development

Web-based modular synthesiser built with React 18 and Vite. Runs entirely in the browser. Models analog-style signal routing between modules using a pseudo-voltage signal model evaluated in an AudioWorklet.

## Completed Architecture

- [x] Multitrack architecture — tracks derived from MIDI import or created manually
- [x] Per-track module graphs and connection state
- [x] Polyphonic voice engine (4 voices per track, cyclic ring allocation)
- [x] Flat note data model: `{ note, bar, beat, duration, velocity }` — no nested sequences
- [x] noteSegments computed on load from notes + BPM, stripped on save
- [x] MIDI import via `midi-file` → flat notes per track
- [x] Transport playback: play, stop, rewind, seekTo
- [x] Playhead animation via direct DOM rAF (per TrackRow), not React state
- [x] Track names editable by clicking in the transport strip
- [x] Audio engine split into: sequencer.js, noteUtils.js, trackMigration.js, midiConvert.js
- [x] Add a MFX module with Delay and Reverb settings
- [ ] Add a record button to record midi notes into the active track (override any note info on the playhead where record was active)

## Module Inventory

| Label | type | Inputs | Output |
|---|---|---|---|
| OSCILLATOR | `oscillator` | freq-input, amp-input, shape-input, duty-input | audio ±1V |
| FILTER | `filter` | audio-input, cutoff-input, resonance-input | audio |
| ENVELOPE | `envelope` | gate-input, attack-input, decay-input, sustain-input, release-input | 0–5V |
| RANDOM | `random` | rate-input | ±10V |
| MIXER | `mixer` | input-a, input-b, level-a-input, level-b-input | audio |
| MULTI | `multi` | signal-input | output-a, output-b (splitter) |
| AMPLIFIER | `vca` | audio-input, gain-input | output |
| Keyboard CV | `keyboard-cv` | — | CV (1V/oct) |
| Keyboard Gate | `keyboard-gate` | — | gate (0/+5V) |
| Keyboard Velocity | `keyboard-velocity` | — | velocity (0–5V) |

## Signal Voltage Reference
- Audio: ±1V (oscillator output = amplitude × wave, wave ∈ [−1,+1])
- Gate: 0V / +5V
- Velocity: 0–5V
- Envelope: 0–5V
- Pitch CV: 1V/octave, MIDI 69 (A4) = 0V

## Frequency Ranges
- Oscillator: 0.1–8000 Hz (log slider)
- Random rate: 0.1–8000 Hz (log slider)
- Filter cutoff: 20–20000 Hz (exponential slider, reversed direction)

## Filter CV Behaviour
- Cutoff input: `finalCutoff = baseCutoff × 2^(V/5)` — 0V = no change, +5V = +1 octave
- Resonance input: `finalResonance = resonance + V/20` — linear additive, clamped 0–0.99

## VCA (Amplifier) Behaviour
- Gain slider: 0–2× (default 1×)
- Gain CV: `finalGain = clamp(gain + V/5, 0, 2)`
- Polarity: `+` normal, `−` inverts (×−1)

## Oscillator AMP Behaviour
- Amplitude stored as linear gain (0–2.0); default 1.0 = 0dB
- Slider: two-segment log scale — left half −60dB→0dB, right half 0dB→+6dB; 0dB at midpoint
- AMP socket: input signal scales amplitude as max: `finalAmp = amplitude × clamp(V / GATE_HIGH_VOLTAGE, 0, 1)`
  i.e. 5V input = full slider amplitude; 0V = silence; slider sets the ceiling

## Envelope Retrigger Behaviour
- On new gate while releasing: attack ramps from current envelope value (not from 0)
- This produces smooth legato — no click/drop on fast repeated notes

## Voice Mixing
- Voices sum directly — no amplitude normalization
- More simultaneous voices = proportionally louder
- Releasing voices contribute their fading signal until their slot is reassigned

## Shared UI Components (src/components/)
- Port.jsx — 18px round socket circle (radial gradient). margin: 0 3px. Input=red border, Output=blue border.
- InputPort.jsx — port circle left, label text right. marginBottom: 6px.
- OutputPort.jsx — label text left, port circle right (right-aligned). marginBottom: 6px.
- InputSlider.jsx — label above row, port+range input row, optional tick labels below. marginBottom: 10px. Range input has marginLeft: 6px, marginRight: 3px.
- ModuleShell.jsx — outer wrapper for all modules. background: #3a3a3a, border: 2px solid #666, borderRadius: 18px, header background: #2e2e2e, header title color: #ccc. Content padding: 10px 10px 6px.
- SelectControl.jsx — label left + styled select right. height 22px, border #555, radius 4px, bg #2a2a2a.

## Known Architecture Notes
- `src/components/Canvas.jsx` exists but is NOT used — the active canvas is the inline `Canvas` function at the bottom of `App.jsx`
- `Amplifier.jsx` is the oscilloscope/power panel (right side), NOT a signal module — the signal amplifier module is `VCA.jsx`
- All keyboard module types must be registered in `App.jsx` when a track is set up and resolved in `resolveSourceModuleId`

