// Track migration — converts old sequences+arrangement format to the flat notes[] model.
// Pure functions; no shared state.

import { QUANTIZE_RESOLUTION, absoluteBeatToBarBeat, barBeatToAbsoluteBeat } from './noteUtils.js';

// Total beat-length of a legacy sequence (used only for repeat-offset math).
function getSequenceLengthBeats(sequence, timeSignatures) {
    if (!Array.isArray(sequence?.events) || sequence.events.length === 0) return 0;
    return sequence.events.reduce((max, ev) => {
        const startBeat = ev.bar != null && ev.beat != null
            ? barBeatToAbsoluteBeat(ev.bar, ev.beat, timeSignatures) : 0;
        return Math.max(max, startBeat + (ev.duration || ev.beats || 0));
    }, 0);
}

// Migrate a legacy sequential-steps sequence to bar/beat absolute format.
// Also renames the old "beats" field to "duration" if needed.
function migrateLegacySequence(sequence, timeSignatures) {
    if (!Array.isArray(sequence?.events) || sequence.events.length === 0) return sequence;

    const needsFieldRename = sequence.events.some(ev => 'beats' in ev && !('duration' in ev));
    const needsBarBeat = sequence.events[0]?.bar == null;
    if (!needsBarBeat && !needsFieldRename) return sequence;

    let cumulativeBeat = 0;
    const events = [];
    for (const ev of sequence.events) {
        const dur = ev.duration ?? ev.beats ?? QUANTIZE_RESOLUTION;
        if (ev.note && ev.note !== '-') {
            const { bar, beat } = needsBarBeat
                ? absoluteBeatToBarBeat(cumulativeBeat, timeSignatures)
                : { bar: ev.bar, beat: ev.beat };
            events.push({ note: ev.note, bar, beat, duration: dur, velocity: ev.velocity ?? 0.8 });
        }
        if (needsBarBeat) cumulativeBeat += dur;
    }
    return { ...sequence, events };
}

// Convert a track to a flat notes[] array.
// Handles both the current format (track.notes[]) and the legacy sequences+arrangement format.
export function flattenTrackToNotes(track, timeSignatures) {
    if (Array.isArray(track?.notes)) {
        return track.notes.map(ev => ({
            note: ev.note,
            bar: ev.bar,
            beat: ev.beat,
            duration: ev.duration ?? ev.beats ?? QUANTIZE_RESOLUTION,
            velocity: ev.velocity ?? 0.8
        }));
    }

    // Legacy path: flatten sequences + arrangement into absolute bar/beat positions.
    const sequences = Array.isArray(track?.sequences) ? track.sequences : [];
    const arrangement = Array.isArray(track?.arrangement) ? track.arrangement : [];
    const notes = [];

    for (const entry of arrangement) {
        const seq = sequences.find(s => s.id === entry.sequenceId);
        if (!seq) continue;
        const migratedSeq = migrateLegacySequence(seq, timeSignatures);
        const seqLengthBeats = getSequenceLengthBeats(migratedSeq, timeSignatures);
        const repeat = entry.repeat ?? 1;
        for (let rep = 0; rep < repeat; rep++) {
            const repOffsetBeats = (entry.startBeat ?? 0) + rep * seqLengthBeats;
            for (const ev of migratedSeq.events) {
                const evAbsoluteBeat = barBeatToAbsoluteBeat(ev.bar ?? 1, ev.beat ?? 1, timeSignatures);
                const totalBeat = repOffsetBeats + evAbsoluteBeat;
                const { bar, beat } = absoluteBeatToBarBeat(totalBeat, timeSignatures);
                notes.push({
                    note: ev.note,
                    bar,
                    beat,
                    duration: ev.duration ?? ev.beats ?? QUANTIZE_RESOLUTION,
                    velocity: ev.velocity ?? 0.8
                });
            }
        }
    }

    return notes.sort((a, b) => {
        const aBeat = barBeatToAbsoluteBeat(a.bar, a.beat, timeSignatures);
        const bBeat = barBeatToAbsoluteBeat(b.bar, b.beat, timeSignatures);
        return aBeat - bBeat;
    });
}
