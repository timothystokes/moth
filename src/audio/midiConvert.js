// MIDI conversion — parses MIDI binary data and converts it to the internal session format.
// Pure functions; no shared state. Imports from noteUtils only.

import { parseMidi } from 'midi-file';
import {
    QUANTIZE_RESOLUTION,
    quantizeToGrid,
    absoluteBeatToBarBeat,
    midiToNoteName,
    getEventPriority
} from './noteUtils.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function createDefaultTimeSignature() {
    return { tick: 0, timeMs: 0, numerator: 4, denominator: 4, clocksPerClick: 24, notated32ndNotesPerBeat: 8 };
}

function getTicksPerDisplayedBeat(ticksPerBeat, denominator) {
    return (ticksPerBeat * 4) / denominator;
}

// Returns a function that maps an absolute tick position to { bar, beat, ... }.
function createMeterResolver(timeSignatures, ticksPerBeat) {
    const sorted = (Array.isArray(timeSignatures) && timeSignatures.length > 0
        ? timeSignatures : [createDefaultTimeSignature()])
        .slice().sort((l, r) => l.tick - r.tick);

    const segments = [];
    let barStart = 0;
    sorted.forEach((sig, index) => {
        const nextSig = sorted[index + 1] ?? null;
        const ticksPerDisplayedBeat = getTicksPerDisplayedBeat(ticksPerBeat, sig.denominator);
        const ticksPerBar = ticksPerDisplayedBeat * sig.numerator;
        segments.push({ ...sig, barStart, ticksPerDisplayedBeat, ticksPerBar, nextTick: nextSig?.tick ?? Infinity });
        if (nextSig) {
            const tickSpan = Math.max(0, nextSig.tick - sig.tick);
            barStart += Math.floor(tickSpan / ticksPerBar);
        }
    });

    return (tick) => {
        const safeTick = Math.max(0, tick ?? 0);
        let seg = segments[0];
        for (const c of segments) { if (safeTick >= c.tick) seg = c; else break; }
        const offset = Math.max(0, safeTick - seg.tick);
        const barsIn = Math.floor(offset / seg.ticksPerBar);
        const tickInBar = offset % seg.ticksPerBar;
        const beat = Math.floor(tickInBar / seg.ticksPerDisplayedBeat) + 1;
        return {
            bar: seg.barStart + barsIn + 1,
            beat,
            tickInBeat: tickInBar % seg.ticksPerDisplayedBeat,
            numerator: seg.numerator,
            denominator: seg.denominator
        };
    };
}

function normalizeTrackDisplayName(trackName, trackIndex, channel) {
    const prefix = trackName?.trim() ? trackName.trim() : `Track ${trackIndex + 1}`;
    return `${prefix} · Ch ${channel + 1}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Build a list of note objects (with startMs/durationMs) from a stream of noteOn/noteOff events.
export function buildNotesFromMidiEvents(events, ticksPerBeat = null, timeSignatures = null) {
    const pendingNotes = new Map();
    const notes = [];
    const resolveMeter = ticksPerBeat ? createMeterResolver(timeSignatures, ticksPerBeat) : null;

    events.forEach((event) => {
        if (event.type === 'noteOn') {
            const stack = pendingNotes.get(event.noteNumber) ?? [];
            stack.push(event);
            pendingNotes.set(event.noteNumber, stack);
            return;
        }
        if (event.type !== 'noteOff') return;

        const stack = pendingNotes.get(event.noteNumber);
        if (!stack || stack.length === 0) return;
        const startEvent = stack.pop();
        if (stack.length === 0) pendingNotes.delete(event.noteNumber);

        const startTick = startEvent.tick ?? startEvent.absoluteTicks ?? null;
        const endTick = event.tick ?? event.absoluteTicks ?? startTick;
        const durationTicks = startTick != null && endTick != null ? Math.max(1, endTick - startTick) : null;
        const startMs = startEvent.timeMs ?? 0;
        const durationMs = Math.max(1, (event.timeMs ?? startMs) - startMs);
        const meterPosition = resolveMeter && startTick != null ? resolveMeter(startTick) : null;

        notes.push({
            noteNumber: startEvent.noteNumber,
            velocity: startEvent.velocity,
            startMs,
            durationMs,
            startTick,
            durationTicks,
            bar: meterPosition?.bar ?? null,
            beat: meterPosition?.beat ?? null,
            tickInBeat: meterPosition?.tickInBeat ?? null,
            numerator: meterPosition?.numerator ?? null,
            denominator: meterPosition?.denominator ?? null
        });
    });

    // Close any notes that never received a noteOff.
    const lastEvent = events[events.length - 1] ?? null;
    pendingNotes.forEach((stack, noteNumber) => {
        stack.forEach((startEvent) => {
            const startTick = startEvent.tick ?? startEvent.absoluteTicks ?? null;
            const endTick = lastEvent?.tick ?? lastEvent?.absoluteTicks ?? startTick;
            const durationTicks = startTick != null && endTick != null ? Math.max(1, endTick - startTick) : null;
            const startMs = startEvent.timeMs ?? 0;
            const durationMs = Math.max(1, (lastEvent?.timeMs ?? startMs) - startMs);
            const meterPosition = resolveMeter && startTick != null ? resolveMeter(startTick) : null;
            notes.push({
                noteNumber,
                velocity: startEvent.velocity,
                startMs,
                durationMs,
                startTick,
                durationTicks,
                bar: meterPosition?.bar ?? null,
                beat: meterPosition?.beat ?? null,
                tickInBeat: meterPosition?.tickInBeat ?? null,
                numerator: meterPosition?.numerator ?? null,
                denominator: meterPosition?.denominator ?? null
            });
        });
    });

    return notes.sort((l, r) => l.startMs - r.startMs || l.noteNumber - r.noteNumber);
}

// Convert a flat list of note/event items into visual display segments { noteNumber, startMs, endMs }.
export function buildNoteSegments(items) {
    const noteSegments = [];
    if (!Array.isArray(items) || items.length === 0) return noteSegments;

    if ('durationMs' in items[0]) {
        items.forEach(note => noteSegments.push({
            noteNumber: note.noteNumber,
            velocity: note.velocity,
            startMs: note.startMs,
            endMs: note.startMs + Math.max(1, note.durationMs)
        }));
        return noteSegments.sort((l, r) => l.startMs - r.startMs || l.noteNumber - r.noteNumber);
    }

    const pendingNotes = new Map();
    items.forEach((event) => {
        if (event.type === 'noteOn') {
            const stack = pendingNotes.get(event.noteNumber) ?? [];
            stack.push({ startMs: event.timeMs, velocity: event.velocity });
            pendingNotes.set(event.noteNumber, stack);
            return;
        }
        const stack = pendingNotes.get(event.noteNumber);
        if (!stack || stack.length === 0) return;
        const startNote = stack.pop();
        if (stack.length === 0) pendingNotes.delete(event.noteNumber);
        noteSegments.push({
            noteNumber: event.noteNumber,
            velocity: startNote.velocity,
            startMs: startNote.startMs,
            endMs: Math.max(startNote.startMs + 1, event.timeMs)
        });
    });

    const lastMs = items.length > 0 ? items[items.length - 1].timeMs : 0;
    pendingNotes.forEach((stack, noteNumber) => {
        stack.forEach(p => noteSegments.push({
            noteNumber, velocity: p.velocity, startMs: p.startMs,
            endMs: Math.max(p.startMs + 1, lastMs)
        }));
    });

    return noteSegments.sort((l, r) => l.startMs - r.startMs || l.noteNumber - r.noteNumber);
}

// Parse a raw MIDI ArrayBuffer and return an internal session object.
// Does NOT modify any shared state — returns data only.
export function convertMidiToSession(arrayBuffer) {
    const midiData = parseMidi(new Uint8Array(arrayBuffer));
    const { header, tracks } = midiData;

    if (!header.ticksPerBeat) throw new Error('This MIDI file uses an unsupported time division.');

    const trackNames = new Map();
    const absoluteEvents = [];
    let batchCounter = (convertMidiToSession._batchCounter = (convertMidiToSession._batchCounter ?? 0) + 1);

    tracks.forEach((track, trackIndex) => {
        let absoluteTicks = 0;
        track.forEach((event, eventIndex) => {
            absoluteTicks += event.deltaTime ?? 0;
            if (event.type === 'trackName' && !trackNames.has(trackIndex)) {
                trackNames.set(trackIndex, event.text ?? event.name ?? `Track ${trackIndex + 1}`);
                return;
            }
            if (['setTempo', 'timeSignature', 'noteOn', 'noteOff'].includes(event.type)) {
                absoluteEvents.push({ ...event, absoluteTicks, trackIndex, eventIndex });
            }
        });
    });

    if (absoluteEvents.length === 0) throw new Error('No playable MIDI events were found in this file.');

    absoluteEvents.sort((l, r) =>
        l.absoluteTicks - r.absoluteTicks ||
        getEventPriority(l) - getEventPriority(r) ||
        l.trackIndex - r.trackIndex ||
        l.eventIndex - r.eventIndex
    );

    let currentTempo = 500000;
    let currentTicks = 0;
    let currentTimeMs = 0;
    const tempoMap = [{ tick: 0, timeMs: 0, microsecondsPerBeat: currentTempo, bpm: 60000000 / currentTempo }];
    const timeSignatures = [createDefaultTimeSignature()];

    const timedEvents = absoluteEvents.map((event) => {
        const deltaTicks = event.absoluteTicks - currentTicks;
        currentTimeMs += (deltaTicks * currentTempo) / header.ticksPerBeat / 1000;
        currentTicks = event.absoluteTicks;
        const timedEvent = { ...event, timeMs: currentTimeMs };
        if (event.type === 'setTempo') {
            currentTempo = event.microsecondsPerBeat;
            tempoMap.push({ tick: event.absoluteTicks, timeMs: currentTimeMs, microsecondsPerBeat: event.microsecondsPerBeat, bpm: 60000000 / event.microsecondsPerBeat });
        }
        if (event.type === 'timeSignature') {
            timeSignatures.push({ tick: event.absoluteTicks, timeMs: currentTimeMs, numerator: event.numerator, denominator: event.denominator, clocksPerClick: event.metronome ?? 24, notated32ndNotesPerBeat: event.thirtyseconds ?? 8 });
        }
        return timedEvent;
    });

    const bpm = tempoMap[0].bpm;
    const msPerBeat = 60000 / bpm;
    const groupedTracks = new Map();

    timedEvents.forEach((event) => {
        if (event.channel === undefined || (event.type !== 'noteOn' && event.type !== 'noteOff')) return;
        const normalizedType = event.type === 'noteOn' && event.velocity > 0 ? 'noteOn' : 'noteOff';
        const key = `${event.trackIndex}:${event.channel}`;
        if (!groupedTracks.has(key)) {
            groupedTracks.set(key, {
                id: `import-${batchCounter}-track-${event.trackIndex}-channel-${event.channel}`,
                name: normalizeTrackDisplayName(trackNames.get(event.trackIndex), event.trackIndex, event.channel),
                noteEvents: []
            });
        }
        groupedTracks.get(key).noteEvents.push({
            type: normalizedType,
            timeMs: event.timeMs,
            tick: event.absoluteTicks,
            noteNumber: event.noteNumber,
            velocity: normalizedType === 'noteOn' ? event.velocity / 127 : 0
        });
    });

    const sessionTracks = Array.from(groupedTracks.values())
        .filter(track => track.noteEvents.some(e => e.type === 'noteOn'))
        .map((track) => {
            const notes = buildNotesFromMidiEvents(track.noteEvents, header.ticksPerBeat, timeSignatures);
            const noteSegments = buildNoteSegments(notes);
            const durationMs = notes.length > 0
                ? notes[notes.length - 1].startMs + notes[notes.length - 1].durationMs : 0;
            const events = notes.map(n => {
                const quantizedStart = quantizeToGrid(n.startMs / msPerBeat);
                const quantizedDur = Math.max(QUANTIZE_RESOLUTION, quantizeToGrid(n.durationMs / msPerBeat));
                const { bar, beat } = absoluteBeatToBarBeat(quantizedStart, timeSignatures);
                return { note: midiToNoteName(n.noteNumber), bar, beat, duration: quantizedDur, velocity: n.velocity };
            });
            return { id: track.id, name: track.name, notes: events, noteSegments, durationMs, mix: { volume: 0.8, mute: false }, modules: [], connections: [] };
        });

    if (sessionTracks.length === 0) throw new Error('No note data was found in this MIDI file.');

    return {
        bpm,
        ticksPerBeat: header.ticksPerBeat,
        tempoMap,
        timeSignatures,
        durationMs: sessionTracks.reduce((max, t) => Math.max(max, t.durationMs), 0),
        tracks: sessionTracks
    };
}
