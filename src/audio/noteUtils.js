// Pure note-utility functions — no side-effects, no shared state.
// Safe to import from anywhere without pulling in audio engine state.

export const CHROMATIC_SCALE = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'];

// Default quantization grid: 1/16th note = 0.25 quarter-note beats.
export const QUANTIZE_RESOLUTION = 0.25;

export function quantizeToGrid(value, resolution = QUANTIZE_RESOLUTION) {
    return Math.round(value / resolution) * resolution;
}

// Returns the beats-per-bar for the first (initial) time signature.
export function getBeatsPerBar(timeSignatures) {
    const sig = Array.isArray(timeSignatures) && timeSignatures.length > 0 ? timeSignatures[0] : null;
    return sig?.numerator ?? 4;
}

// Convert a 0-based absolute beat offset to a 1-indexed { bar, beat }.
export function absoluteBeatToBarBeat(absoluteBeat, timeSignatures) {
    const beatsPerBar = getBeatsPerBar(timeSignatures);
    const bar = Math.floor(absoluteBeat / beatsPerBar) + 1;
    const beat = (absoluteBeat % beatsPerBar) + 1;
    return { bar, beat: Math.round(beat * 10000) / 10000 };
}

// Convert a 1-indexed { bar, beat } back to a 0-based absolute beat offset.
export function barBeatToAbsoluteBeat(bar, beat, timeSignatures) {
    const beatsPerBar = getBeatsPerBar(timeSignatures);
    return (bar - 1) * beatsPerBar + (beat - 1);
}

// A4 = MIDI 69.
export function midiToNoteName(n) {
    const octave = Math.floor(n / 12) - 1;
    return CHROMATIC_SCALE[n % 12] + octave;
}

// Returns the MIDI note number for a note name string ("Cs4" → 61), or null if invalid.
export function noteNameToMidi(name) {
    if (!name || name === '-') return null;
    const match = name.match(/^([A-G]s?)(-?\d+)$/);
    if (!match) return null;
    const noteIndex = CHROMATIC_SCALE.indexOf(match[1]);
    if (noteIndex < 0) return null;
    return (parseInt(match[2], 10) + 1) * 12 + noteIndex;
}

// Priority used when sorting simultaneous MIDI events: tempo changes first, noteOffs before noteOns.
export function getEventPriority(event) {
    if (event.type === 'setTempo') return 0;
    if (event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)) return 1;
    return 2;
}
