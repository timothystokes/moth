// Sequencer — stateful playback engine, session loader, and MIDI I/O.
// Pure utilities live in noteUtils.js, trackMigration.js, and midiConvert.js.
// This file owns all mutable state and re-exports the full public API.

import { noteOn, noteOff } from './audioEngine.js';
import {
    QUANTIZE_RESOLUTION,
    barBeatToAbsoluteBeat,
    noteNameToMidi,
    getEventPriority
} from './noteUtils.js';
import { flattenTrackToNotes } from './trackMigration.js';
import { convertMidiToSession } from './midiConvert.js';

// ── Re-export public utilities ────────────────────────────────────────────────
export {
    QUANTIZE_RESOLUTION,
    quantizeToGrid,
    absoluteBeatToBarBeat,
    barBeatToAbsoluteBeat,
    getBeatsPerBar,
    midiToNoteName,
    noteNameToMidi,
    getEventPriority
} from './noteUtils.js';

export { flattenTrackToNotes } from './trackMigration.js';
export { buildNotesFromMidiEvents, buildNoteSegments, convertMidiToSession } from './midiConvert.js';

// ── Shared engine state ───────────────────────────────────────────────────────

const noteOnListeners = [];
const noteOffListeners = [];
const transportListeners = new Set();
const midiStateChangeListeners = new Set();

let midiAccess = null;
let selectedInputId = null;
let activeTrackId = null;
let midiChannelFilter = null;
let loadedSession = null;
let isPlaying = false;
let playbackPositionMs = 0;
let playbackStartTimestampMs = 0;
let playbackTimeouts = [];
let playbackCompletionTimeout = null;
let activeSequenceNotes = new Map();
let playbackAnimationFrameId = null;

// ── Internal helpers ──────────────────────────────────────────────────────────

function getCurrentPlaybackPositionMs() {
    if (!loadedSession) return 0;
    if (!isPlaying) return playbackPositionMs;
    return playbackPositionMs + (performance.now() - playbackStartTimestampMs);
}

function getTransportState() {
    return {
        hasSequence: Boolean(loadedSession),
        durationMs: loadedSession?.durationMs ?? 0,
        trackCount: loadedSession?.tracks.length ?? 0,
        tracks: loadedSession?.tracks ?? [],
        isPlaying,
        playbackPositionMs: getCurrentPlaybackPositionMs()
    };
}

function notifyTransportListeners() {
    const state = getTransportState();
    transportListeners.forEach(listener => listener(state));
}

function stopPlaybackProgressUpdates() {
    if (playbackAnimationFrameId !== null) {
        window.cancelAnimationFrame(playbackAnimationFrameId);
        playbackAnimationFrameId = null;
    }
}

function startPlaybackProgressUpdates() {
    stopPlaybackProgressUpdates();
    const update = () => {
        if (!isPlaying) { playbackAnimationFrameId = null; return; }
        notifyTransportListeners();
        playbackAnimationFrameId = window.requestAnimationFrame(update);
    };
    playbackAnimationFrameId = window.requestAnimationFrame(update);
}

function clearScheduledPlayback() {
    playbackTimeouts.forEach(id => window.clearTimeout(id));
    playbackTimeouts = [];
    if (playbackCompletionTimeout !== null) {
        window.clearTimeout(playbackCompletionTimeout);
        playbackCompletionTimeout = null;
    }
    stopPlaybackProgressUpdates();
}

function releaseActiveSequenceNotes() {
    activeSequenceNotes.forEach((count, key) => {
        if (count <= 0) return;
        const [trackId, noteNumber] = key.split('::');
        handleNoteOff(trackId, Number(noteNumber), performance.now());
    });
    activeSequenceNotes = new Map();
}

function makeNoteKey(trackId, noteNumber) { return `${trackId}::${noteNumber}`; }

function registerNoteOn(trackId, noteNumber) {
    const key = makeNoteKey(trackId, noteNumber);
    activeSequenceNotes.set(key, (activeSequenceNotes.get(key) ?? 0) + 1);
}

function registerNoteOff(trackId, noteNumber) {
    const key = makeNoteKey(trackId, noteNumber);
    const count = activeSequenceNotes.get(key) ?? 0;
    if (count <= 1) { activeSequenceNotes.delete(key); return; }
    activeSequenceNotes.set(key, count - 1);
}

function stopSequencePlayback({ resetPosition = false } = {}) {
    if (isPlaying) playbackPositionMs = getCurrentPlaybackPositionMs();
    clearScheduledPlayback();
    releaseActiveSequenceNotes();
    isPlaying = false;
    if (resetPosition) playbackPositionMs = 0;
    notifyTransportListeners();
}

function handleNoteOn(trackId, noteNumber, velocity, timestamp) {
    if (!trackId) return;
    noteOn(trackId, noteNumber, velocity);
    noteOnListeners.forEach(l => l({ trackId, noteNumber, velocity, noteOnTime: timestamp }));
}

function handleNoteOff(trackId, noteNumber, timestamp) {
    if (!trackId) return;
    noteOff(trackId, noteNumber);
    noteOffListeners.forEach(l => l({ trackId, noteNumber, timestamp }));
}

function handleMidiStateChange(event) {
    if (event.port.id === selectedInputId && event.port.state === 'disconnected') selectedInputId = null;
    midiStateChangeListeners.forEach(l => l(getMidiInputs()));
}

function handleMidiMessage(event) {
    if (!activeTrackId) return;
    const [status, note, velocity] = event.data;
    const command = status >> 4;
    const channel = status & 0x0f;
    if (midiChannelFilter !== null && channel !== midiChannelFilter) return;
    switch (command) {
        case 0x9:
            if (velocity > 0) handleNoteOn(activeTrackId, note, velocity / 127, event.timeStamp);
            else handleNoteOff(activeTrackId, note, event.timeStamp);
            break;
        case 0x8:
            handleNoteOff(activeTrackId, note, event.timeStamp);
            break;
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getPlaybackPositionMs() { return getCurrentPlaybackPositionMs(); }
export function getIsPlaying() { return isPlaying; }

export function loadSession(sessionMeta, tracks) {
    stopSequencePlayback({ resetPosition: true });

    const bpm = sessionMeta?.bpm ?? sessionMeta?.tempoMap?.[0]?.bpm ?? 120;
    const msPerBeat = 60000 / bpm;
    const timeSignatures = sessionMeta?.timeSignatures ?? [];

    const validTracks = (tracks ?? []).filter(track =>
        (Array.isArray(track?.notes) && track.notes.length > 0) ||
        (Array.isArray(track?.sequences) && track.sequences.length > 0 &&
         Array.isArray(track?.arrangement) && track.arrangement.length > 0)
    );

    if (!validTracks.length) {
        console.warn('[loadSession] no valid tracks found.', (tracks ?? []).map(t => ({ id: t.id, notes: t.notes?.length })));
        loadedSession = null;
        notifyTransportListeners();
        return getTransportState();
    }

    const sessionTracks = validTracks.map(track => {
        const notes = flattenTrackToNotes(track, timeSignatures);
        const durationMs = Number.isFinite(track.durationMs) && track.durationMs > 0
            ? track.durationMs
            : notes.reduce((max, note) => {
                const startBeat = barBeatToAbsoluteBeat(note.bar ?? 1, note.beat ?? 1, timeSignatures);
                return Math.max(max, (startBeat + (note.duration || QUANTIZE_RESOLUTION)) * msPerBeat);
            }, 0);

        // Re-compute noteSegments from notes[] when not provided (project files strip them on save).
        const provided = Array.isArray(track.noteSegments) && track.noteSegments.length > 0 ? track.noteSegments : null;
        const noteSegments = provided ?? notes
            .filter(n => n.note && n.note !== '-')
            .map(note => {
                const noteNumber = noteNameToMidi(note.note);
                if (noteNumber == null) return null;
                const startBeat = barBeatToAbsoluteBeat(note.bar ?? 1, note.beat ?? 1, timeSignatures);
                const startMs = startBeat * msPerBeat;
                const endMs = startMs + (note.duration || QUANTIZE_RESOLUTION) * msPerBeat;
                return { noteNumber, startMs, endMs };
            })
            .filter(Boolean)
            .sort((a, b) => a.startMs - b.startMs || a.noteNumber - b.noteNumber);

        return { id: track.id, name: track.name, notes, noteSegments, durationMs, mix: track.mix ?? { volume: 0.8, mute: false } };
    });

    loadedSession = {
        bpm,
        ticksPerBeat: sessionMeta?.ticksPerBeat ?? null,
        tempoMap: sessionMeta?.tempoMap ?? [],
        timeSignatures,
        durationMs: sessionTracks.reduce((max, t) => Math.max(max, t.durationMs), 0),
        tracks: sessionTracks
    };

    notifyTransportListeners();
    return getTransportState();
}

export async function importMidiFile(file) {
    if (!file) throw new Error('No MIDI file was provided.');
    const arrayBuffer = await file.arrayBuffer();
    stopSequencePlayback({ resetPosition: true });
    const session = convertMidiToSession(arrayBuffer);
    loadedSession = session;
    notifyTransportListeners();
    return session;
}

export async function play() {
    if (!loadedSession) throw new Error('No sequence loaded.');
    if (isPlaying) return getTransportState();

    const startOffsetMs = getCurrentPlaybackPositionMs();
    playbackPositionMs = startOffsetMs;
    playbackStartTimestampMs = performance.now();
    isPlaying = true;
    startPlaybackProgressUpdates();

    const msPerBeat = 60000 / (loadedSession.bpm ?? 120);
    const timeSignatures = loadedSession.timeSignatures ?? [];
    const events = [];

    for (const track of loadedSession.tracks) {
        for (const note of (track.notes ?? [])) {
            if (!note.note || note.note === '-') continue;
            const noteNumber = noteNameToMidi(note.note);
            if (noteNumber == null) continue;
            const absoluteBeat = barBeatToAbsoluteBeat(note.bar ?? 1, note.beat ?? 1, timeSignatures);
            const timeMs = absoluteBeat * msPerBeat;
            const noteDurationMs = (note.duration || QUANTIZE_RESOLUTION) * msPerBeat;
            events.push({ type: 'noteOn', trackId: track.id, noteNumber, velocity: note.velocity || 0.8, timeMs });
            events.push({ type: 'noteOff', trackId: track.id, noteNumber, timeMs: timeMs + noteDurationMs });
        }
    }

    events.sort((a, b) => a.timeMs - b.timeMs || getEventPriority(a) - getEventPriority(b));
    const remaining = events.filter(e => e.timeMs >= startOffsetMs);

    playbackTimeouts = remaining.map(event =>
        window.setTimeout(() => {
            if (event.type === 'noteOn') {
                registerNoteOn(event.trackId, event.noteNumber);
                handleNoteOn(event.trackId, event.noteNumber, event.velocity, performance.now());
            } else {
                registerNoteOff(event.trackId, event.noteNumber);
                handleNoteOff(event.trackId, event.noteNumber, performance.now());
            }
        }, Math.max(0, event.timeMs - startOffsetMs))
    );

    const totalDurationMs = events.length > 0 ? Math.max(...events.map(e => e.timeMs)) : 0;
    playbackCompletionTimeout = window.setTimeout(() => {
        clearScheduledPlayback();
        releaseActiveSequenceNotes();
        isPlaying = false;
        playbackPositionMs = totalDurationMs;
        notifyTransportListeners();
    }, Math.max(0, totalDurationMs - startOffsetMs) + 10);

    notifyTransportListeners();
    return getTransportState();
}

export function stop() { stopSequencePlayback(); return getTransportState(); }
export function rewind() { stopSequencePlayback({ resetPosition: true }); return getTransportState(); }

export function seekTo(ms) {
    if (!loadedSession) return;
    const maxMs = Math.max(loadedSession.durationMs, ...loadedSession.tracks.map(t => t.durationMs || 0));
    const clamped = Math.max(0, Math.min(ms, maxMs || ms));
    const wasPlaying = isPlaying;
    stopSequencePlayback();
    playbackPositionMs = clamped;
    if (wasPlaying) play(); else notifyTransportListeners();
}

export function subscribeToTransport(callback) {
    transportListeners.add(callback);
    callback(getTransportState());
    return () => transportListeners.delete(callback);
}

export async function initializeMidi() {
    if (!navigator.requestMIDIAccess) { console.warn('Web MIDI API not supported'); return false; }
    try {
        midiAccess = await navigator.requestMIDIAccess();
        midiAccess.onstatechange = handleMidiStateChange;
        const inputs = Array.from(midiAccess.inputs.values());
        if (inputs.length > 0 && !selectedInputId) selectMidiInput(inputs[0].id);
        return true;
    } catch (error) {
        console.error('Failed to get MIDI access:', error);
        return false;
    }
}

export function setActiveTrack(trackId) { activeTrackId = trackId ?? null; }

export function getMidiInputs() {
    if (!midiAccess) return [];
    return Array.from(midiAccess.inputs.values()).map(input => ({
        id: input.id, name: input.name, manufacturer: input.manufacturer, state: input.state
    }));
}

export function selectMidiInput(inputId) {
    if (!midiAccess) return false;
    if (selectedInputId) {
        const prev = midiAccess.inputs.get(selectedInputId);
        if (prev) prev.onmidimessage = null;
    }
    const input = midiAccess.inputs.get(inputId);
    if (!input) return false;
    input.onmidimessage = handleMidiMessage;
    selectedInputId = inputId;
    return true;
}

export function setMidiChannel(channel) {
    midiChannelFilter = (channel === null || channel === 'all') ? null : Number(channel);
}

export function getMidiChannel() { return midiChannelFilter; }

export function subscribeMidiStateChange(callback) {
    midiStateChangeListeners.add(callback);
    return () => midiStateChangeListeners.delete(callback);
}

export function getActiveNotes() {
    const notes = [];
    activeSequenceNotes.forEach((count, key) => {
        if (count > 0) {
            const [trackId, noteNumberStr] = key.split('::');
            notes.push({ trackId, noteNumber: Number(noteNumberStr) });
        }
    });
    return notes;
}

export function triggerNoteOn(trackId, noteNumber, velocity = 0.8) {
    handleNoteOn(trackId, noteNumber, velocity, performance.now());
}

export function triggerNoteOff(trackId, noteNumber) {
    handleNoteOff(trackId, noteNumber, performance.now());
}

export function onNoteOn(callback) {
    noteOnListeners.push(callback);
    return () => { const i = noteOnListeners.indexOf(callback); if (i > -1) noteOnListeners.splice(i, 1); };
}

export function onNoteOff(callback) {
    noteOffListeners.push(callback);
    return () => { const i = noteOffListeners.indexOf(callback); if (i > -1) noteOffListeners.splice(i, 1); };
}

export function clearAllNotes() { noteOff(null, -1); }
