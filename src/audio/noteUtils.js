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

// Convert a 0-based absolute beat offset to { bar (1-indexed), beat (0-indexed within bar) }.
export function absoluteBeatToBarBeat(absoluteBeat, timeSignatures) {
    const beatsPerBar = getBeatsPerBar(timeSignatures);
    const bar = Math.floor(absoluteBeat / beatsPerBar) + 1;
    const beat = absoluteBeat % beatsPerBar;
    return { bar, beat: Math.round(beat * 10000) / 10000 };
}

// Convert { bar (1-indexed), beat (0-indexed within bar) } to a 0-based absolute beat offset.
export function barBeatToAbsoluteBeat(bar, beat, timeSignatures) {
    const beatsPerBar = getBeatsPerBar(timeSignatures);
    return (bar - 1) * beatsPerBar + beat;
}

// A4 = MIDI 69. Returns note names in the format "C4", "C4s", "D4", "D4s" etc.
export function midiToNoteName(n) {
    const octave = Math.floor(n / 12) - 1;
    const note = CHROMATIC_SCALE[n % 12];
    return note.length === 2 ? note[0] + octave + 's' : note + octave;
}

// Returns the MIDI note number for a note name string ("C4s" → 61, "F4" → 65), or null if invalid.
export function noteNameToMidi(name) {
    if (!name || name === '-') return null;
    const match = name.match(/^([A-G])(-?\d+)(s?)$/);
    if (!match) return null;
    const noteIndex = CHROMATIC_SCALE.indexOf(match[3] === 's' ? match[1] + 's' : match[1]);
    if (noteIndex < 0) return null;
    return (parseInt(match[2], 10) + 1) * 12 + noteIndex;
}

// Priority used when sorting simultaneous MIDI events: tempo changes first, noteOffs before noteOns.
export function getEventPriority(event) {
    if (event.type === 'setTempo') return 0;
    if (event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)) return 1;
    return 2;
}
