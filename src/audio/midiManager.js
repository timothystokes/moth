// Web MIDI API Manager
// Handles MIDI input and forwards note events to the audio engine.

import { parseMidi } from 'midi-file';
import { noteOn, noteOff } from './audioEngine.js';

const noteOnListeners = [];
const noteOffListeners = [];
const sequenceTransportListeners = new Set();

let midiAccess = null;
let selectedInputId = null;
let selectedTrackId = null;
let loadedArrangement = null;
let isSequencePlaying = false;
let playbackPositionMs = 0;
let playbackStartTimestampMs = 0;
let playbackTimeouts = [];
let playbackCompletionTimeout = null;
let activeSequenceNotes = new Map();
let importBatchId = 0;
let playbackAnimationFrameId = null;

function normalizeTrackDisplayName(trackName, trackIndex, channel) {
    const prefix = trackName?.trim() ? trackName.trim() : `Track ${trackIndex + 1}`;
    return `${prefix} · Ch ${channel + 1}`;
}

function getEventPriority(event) {
    if (event.type === 'setTempo') {
        return 0;
    }

    if (event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)) {
        return 1;
    }

    return 2;
}

function getCurrentPlaybackPositionMs() {
    if (!loadedArrangement) {
        return 0;
    }

    if (!isSequencePlaying) {
        return playbackPositionMs;
    }

    return Math.min(
        loadedArrangement.durationMs,
        playbackPositionMs + (performance.now() - playbackStartTimestampMs)
    );
}

function getSequenceTransportState() {
    return {
        hasSequence: Boolean(loadedArrangement),
        fileName: loadedArrangement?.fileName ?? null,
        durationMs: loadedArrangement?.durationMs ?? 0,
        trackCount: loadedArrangement?.tracks.length ?? 0,
        tracks: loadedArrangement?.tracks ?? [],
        isPlaying: isSequencePlaying,
        playbackPositionMs: getCurrentPlaybackPositionMs()
    };
}

function notifySequenceTransportListeners() {
    const state = getSequenceTransportState();
    sequenceTransportListeners.forEach((listener) => listener(state));
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
        if (!isSequencePlaying) {
            playbackAnimationFrameId = null;
            return;
        }

        notifySequenceTransportListeners();
        playbackAnimationFrameId = window.requestAnimationFrame(update);
    };

    playbackAnimationFrameId = window.requestAnimationFrame(update);
}

function clearScheduledSequencePlayback() {
    playbackTimeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
    playbackTimeouts = [];

    if (playbackCompletionTimeout !== null) {
        window.clearTimeout(playbackCompletionTimeout);
        playbackCompletionTimeout = null;
    }

    stopPlaybackProgressUpdates();
}

function releaseActiveSequenceNotes() {
    activeSequenceNotes.forEach((count, key) => {
        if (count <= 0) {
            return;
        }

        const [trackId, noteNumber] = key.split('::');
        handleNoteOff(trackId, Number(noteNumber), performance.now());
    });

    activeSequenceNotes = new Map();
}

function makeActiveNoteKey(trackId, noteNumber) {
    return `${trackId}::${noteNumber}`;
}

function registerSequenceNoteOn(trackId, noteNumber) {
    const key = makeActiveNoteKey(trackId, noteNumber);
    activeSequenceNotes.set(key, (activeSequenceNotes.get(key) ?? 0) + 1);
}

function registerSequenceNoteOff(trackId, noteNumber) {
    const key = makeActiveNoteKey(trackId, noteNumber);
    const activeCount = activeSequenceNotes.get(key) ?? 0;

    if (activeCount <= 1) {
        activeSequenceNotes.delete(key);
        return;
    }

    activeSequenceNotes.set(key, activeCount - 1);
}

function stopSequencePlayback({ resetPosition = false } = {}) {
    if (isSequencePlaying) {
        playbackPositionMs = getCurrentPlaybackPositionMs();
    }

    clearScheduledSequencePlayback();
    releaseActiveSequenceNotes();
    isSequencePlaying = false;

    if (resetPosition) {
        playbackPositionMs = 0;
    }

    notifySequenceTransportListeners();
}

function createDefaultTimeSignature() {
    return {
        tick: 0,
        timeMs: 0,
        numerator: 4,
        denominator: 4,
        clocksPerClick: 24,
        notated32ndNotesPerBeat: 8
    };
}

function getTicksPerDisplayedBeat(ticksPerBeat, denominator) {
    return (ticksPerBeat * 4) / denominator;
}

function createMeterResolver(timeSignatures, ticksPerBeat) {
    const sortedTimeSignatures = (Array.isArray(timeSignatures) && timeSignatures.length > 0
        ? timeSignatures
        : [createDefaultTimeSignature()])
        .slice()
        .sort((left, right) => left.tick - right.tick);

    const segments = [];
    let barStart = 0;

    sortedTimeSignatures.forEach((signature, index) => {
        const nextSignature = sortedTimeSignatures[index + 1] ?? null;
        const ticksPerDisplayedBeat = getTicksPerDisplayedBeat(ticksPerBeat, signature.denominator);
        const ticksPerBar = ticksPerDisplayedBeat * signature.numerator;

        segments.push({
            ...signature,
            barStart,
            ticksPerDisplayedBeat,
            ticksPerBar,
            nextTick: nextSignature?.tick ?? Number.POSITIVE_INFINITY
        });

        if (nextSignature) {
            const tickSpan = Math.max(0, nextSignature.tick - signature.tick);
            barStart += Math.floor(tickSpan / ticksPerBar);
        }
    });

    return (tick) => {
        const safeTick = Math.max(0, tick ?? 0);
        let segment = segments[0];
        for (const candidate of segments) {
            if (safeTick >= candidate.tick) {
                segment = candidate;
            } else {
                break;
            }
        }

        const offsetTicks = Math.max(0, safeTick - segment.tick);
        const barsIntoSegment = Math.floor(offsetTicks / segment.ticksPerBar);
        const tickInBar = offsetTicks % segment.ticksPerBar;
        const beat = Math.floor(tickInBar / segment.ticksPerDisplayedBeat) + 1;
        const tickInBeat = tickInBar % segment.ticksPerDisplayedBeat;

        return {
            bar: segment.barStart + barsIntoSegment + 1,
            beat,
            tickInBeat,
            numerator: segment.numerator,
            denominator: segment.denominator
        };
    };
}

export function buildNotesFromEvents(events, ticksPerBeat = null, timeSignatures = null) {
    const pendingNotes = new Map();
    const notes = [];
    const resolveMeterPosition = ticksPerBeat ? createMeterResolver(timeSignatures, ticksPerBeat) : null;

    events.forEach((event) => {
        if (event.type === 'noteOn') {
            const stack = pendingNotes.get(event.noteNumber) ?? [];
            stack.push(event);
            pendingNotes.set(event.noteNumber, stack);
            return;
        }

        if (event.type !== 'noteOff') {
            return;
        }

        const stack = pendingNotes.get(event.noteNumber);
        if (!stack || stack.length === 0) {
            return;
        }

        const startEvent = stack.pop();
        if (stack.length === 0) {
            pendingNotes.delete(event.noteNumber);
        }

        const startTick = startEvent.tick ?? startEvent.absoluteTicks ?? null;
        const endTick = event.tick ?? event.absoluteTicks ?? startTick;
        const durationTicks = startTick !== null && endTick !== null ? Math.max(1, endTick - startTick) : null;
        const startMs = startEvent.timeMs ?? 0;
        const durationMs = Math.max(1, (event.timeMs ?? startMs) - startMs);
        const meterPosition = resolveMeterPosition && startTick !== null ? resolveMeterPosition(startTick) : null;

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

    const lastEvent = events[events.length - 1] ?? null;
    pendingNotes.forEach((stack, noteNumber) => {
        stack.forEach((startEvent) => {
            const startTick = startEvent.tick ?? startEvent.absoluteTicks ?? null;
            const endTick = lastEvent?.tick ?? lastEvent?.absoluteTicks ?? startTick;
            const durationTicks = startTick !== null && endTick !== null ? Math.max(1, endTick - startTick) : null;
            const startMs = startEvent.timeMs ?? 0;
            const durationMs = Math.max(1, (lastEvent?.timeMs ?? startMs) - startMs);
            const meterPosition = resolveMeterPosition && startTick !== null ? resolveMeterPosition(startTick) : null;

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

    return notes.sort((left, right) => left.startMs - right.startMs || left.noteNumber - right.noteNumber);
}

export function buildNoteSegments(items) {
    const noteSegments = [];

    if (!Array.isArray(items) || items.length === 0) {
        return noteSegments;
    }

    if ('durationMs' in items[0]) {
        items.forEach((note) => {
            noteSegments.push({
                noteNumber: note.noteNumber,
                velocity: note.velocity,
                startMs: note.startMs,
                endMs: note.startMs + Math.max(1, note.durationMs)
            });
        });

        return noteSegments.sort((left, right) => left.startMs - right.startMs || left.noteNumber - right.noteNumber);
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
        if (!stack || stack.length === 0) {
            return;
        }

        const startNote = stack.pop();
        if (stack.length === 0) {
            pendingNotes.delete(event.noteNumber);
        }

        noteSegments.push({
            noteNumber: event.noteNumber,
            velocity: startNote.velocity,
            startMs: startNote.startMs,
            endMs: Math.max(startNote.startMs + 1, event.timeMs)
        });
    });

    const lastEventTimeMs = items.length > 0 ? items[items.length - 1].timeMs : 0;
    pendingNotes.forEach((stack, noteNumber) => {
        stack.forEach((pendingNote) => {
            noteSegments.push({
                noteNumber,
                velocity: pendingNote.velocity,
                startMs: pendingNote.startMs,
                endMs: Math.max(pendingNote.startMs + 1, lastEventTimeMs)
            });
        });
    });

    return noteSegments.sort((left, right) => left.startMs - right.startMs || left.noteNumber - right.noteNumber);
}

function buildPlaybackEventsFromNotes(tracks) {
    return tracks.flatMap((track) =>
        (track.notes ?? []).flatMap((note) => ([
            {
                type: 'noteOn',
                trackId: track.id,
                noteNumber: note.noteNumber,
                velocity: note.velocity,
                timeMs: note.startMs
            },
            {
                type: 'noteOff',
                trackId: track.id,
                noteNumber: note.noteNumber,
                velocity: 0,
                timeMs: note.startMs + Math.max(1, note.durationMs)
            }
        ]))
    ).sort((left, right) => (
        left.timeMs - right.timeMs
        || getEventPriority(left) - getEventPriority(right)
        || left.noteNumber - right.noteNumber
    ));
}

function buildMidiArrangement(midiData, fileName) {
    const { header, tracks } = midiData;

    if (!header.ticksPerBeat) {
        throw new Error('This MIDI file uses an unsupported time division.');
    }

    const trackNames = new Map();
    const absoluteEvents = [];

    tracks.forEach((track, trackIndex) => {
        let absoluteTicks = 0;

        track.forEach((event, eventIndex) => {
            absoluteTicks += event.deltaTime ?? 0;

            if (event.type === 'trackName' && !trackNames.has(trackIndex)) {
                trackNames.set(trackIndex, event.text ?? event.name ?? `Track ${trackIndex + 1}`);
                return;
            }

            if (event.type === 'setTempo' || event.type === 'timeSignature' || event.type === 'noteOn' || event.type === 'noteOff') {
                absoluteEvents.push({
                    ...event,
                    absoluteTicks,
                    trackIndex,
                    eventIndex
                });
            }
        });
    });

    if (absoluteEvents.length === 0) {
        throw new Error('No playable MIDI events were found in this file.');
    }

    absoluteEvents.sort((left, right) => (
        left.absoluteTicks - right.absoluteTicks
        || getEventPriority(left) - getEventPriority(right)
        || left.trackIndex - right.trackIndex
        || left.eventIndex - right.eventIndex
    ));

    let currentTempo = 500000;
    let currentTicks = 0;
    let currentTimeMs = 0;
    const tempoMap = [{ tick: 0, timeMs: 0, microsecondsPerBeat: currentTempo, bpm: 60000000 / currentTempo }];
    const timeSignatures = [createDefaultTimeSignature()];

    const timedEvents = absoluteEvents.map((event) => {
        const deltaTicks = event.absoluteTicks - currentTicks;
        currentTimeMs += (deltaTicks * currentTempo) / header.ticksPerBeat / 1000;
        currentTicks = event.absoluteTicks;

        const timedEvent = {
            ...event,
            timeMs: currentTimeMs
        };

        if (event.type === 'setTempo') {
            currentTempo = event.microsecondsPerBeat;
            tempoMap.push({
                tick: event.absoluteTicks,
                timeMs: currentTimeMs,
                microsecondsPerBeat: event.microsecondsPerBeat,
                bpm: 60000000 / event.microsecondsPerBeat
            });
        }

        if (event.type === 'timeSignature') {
            timeSignatures.push({
                tick: event.absoluteTicks,
                timeMs: currentTimeMs,
                numerator: event.numerator,
                denominator: event.denominator,
                clocksPerClick: event.metronome ?? 24,
                notated32ndNotesPerBeat: event.thirtyseconds ?? 8
            });
        }

        return timedEvent;
    });

    importBatchId += 1;
    const groupedTracks = new Map();

    timedEvents.forEach((event) => {
        if (event.channel === undefined || (event.type !== 'noteOn' && event.type !== 'noteOff')) {
            return;
        }

        const normalizedType = event.type === 'noteOn' && event.velocity > 0 ? 'noteOn' : 'noteOff';
        const key = `${event.trackIndex}:${event.channel}`;
        if (!groupedTracks.has(key)) {
            groupedTracks.set(key, {
                id: `import-${importBatchId}-track-${event.trackIndex}-channel-${event.channel}`,
                name: normalizeTrackDisplayName(trackNames.get(event.trackIndex), event.trackIndex, event.channel),
                sourceTrackIndex: event.trackIndex,
                channel: event.channel,
                channelDisplay: event.channel + 1,
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

    const arrangementTracks = Array.from(groupedTracks.values())
        .filter((track) => track.noteEvents.some((event) => event.type === 'noteOn'))
        .map((track) => {
            const notes = buildNotesFromEvents(track.noteEvents, header.ticksPerBeat, timeSignatures);
            const noteSegments = buildNoteSegments(notes);
            const durationMs = Math.max(
                notes.length > 0 ? notes[notes.length - 1].startMs + notes[notes.length - 1].durationMs : 0,
                noteSegments.length > 0 ? noteSegments[noteSegments.length - 1].endMs : 0
            );

            return {
                ...track,
                notes,
                durationMs,
                noteCount: notes.length,
                noteSegments
            };
        })
        .sort((left, right) => (
            left.sourceTrackIndex - right.sourceTrackIndex
            || left.channel - right.channel
        ));

    if (arrangementTracks.length === 0) {
        throw new Error('No note data was found in this MIDI file.');
    }

    const durationMs = arrangementTracks.reduce(
        (maximum, track) => Math.max(maximum, track.durationMs),
        0
    );

    return {
        fileName,
        ticksPerBeat: header.ticksPerBeat,
        tempoMap,
        timeSignatures,
        durationMs,
        tracks: arrangementTracks
    };
}

export async function initializeMIDI() {
    if (!navigator.requestMIDIAccess) {
        console.warn('Web MIDI API not supported in this browser');
        return false;
    }

    try {
        midiAccess = await navigator.requestMIDIAccess();
        midiAccess.onstatechange = handleStateChange;

        const inputs = Array.from(midiAccess.inputs.values());
        if (inputs.length > 0 && !selectedInputId) {
            selectMIDIInput(inputs[0].id);
        }

        return true;
    } catch (error) {
        console.error('Failed to get MIDI access:', error);
        return false;
    }
}

export function setSelectedTrack(trackId) {
    selectedTrackId = trackId ?? null;
}

export function getMIDIInputs() {
    if (!midiAccess) {
        return [];
    }

    return Array.from(midiAccess.inputs.values()).map((input) => ({
        id: input.id,
        name: input.name,
        manufacturer: input.manufacturer,
        state: input.state
    }));
}

export function selectMIDIInput(inputId) {
    if (!midiAccess) {
        return false;
    }

    if (selectedInputId) {
        const previousInput = midiAccess.inputs.get(selectedInputId);
        if (previousInput) {
            previousInput.onmidimessage = null;
        }
    }

    const input = midiAccess.inputs.get(inputId);
    if (!input) {
        return false;
    }

    input.onmidimessage = handleMIDIMessage;
    selectedInputId = inputId;
    return true;
}

function handleStateChange(event) {
    if (event.port.id === selectedInputId && event.port.state === 'disconnected') {
        selectedInputId = null;
    }
}

function handleMIDIMessage(event) {
    if (!selectedTrackId) {
        return;
    }

    const [status, note, velocity] = event.data;
    const command = status >> 4;

    switch (command) {
        case 0x9:
            if (velocity > 0) {
                handleNoteOn(selectedTrackId, note, velocity / 127, event.timeStamp);
            } else {
                handleNoteOff(selectedTrackId, note, event.timeStamp);
            }
            break;
        case 0x8:
            handleNoteOff(selectedTrackId, note, event.timeStamp);
            break;
        default:
            break;
    }
}

function handleNoteOn(trackId, noteNumber, velocity, timestamp) {
    if (!trackId) {
        return;
    }

    noteOn(trackId, noteNumber, velocity);

    noteOnListeners.forEach((listener) => listener({
        trackId,
        noteNumber,
        velocity,
        noteOnTime: timestamp
    }));
}

function handleNoteOff(trackId, noteNumber, timestamp) {
    if (!trackId) {
        return;
    }

    noteOff(trackId, noteNumber);
    noteOffListeners.forEach((listener) => listener({ trackId, noteNumber, timestamp }));
}

export async function loadMIDIFile(file) {
    if (!file) {
        throw new Error('No MIDI file was provided.');
    }

    const arrayBuffer = await file.arrayBuffer();
    const midiData = parseMidi(new Uint8Array(arrayBuffer));

    stopSequencePlayback({ resetPosition: true });
    loadedArrangement = buildMidiArrangement(midiData, file.name);
    notifySequenceTransportListeners();

    return loadedArrangement;
}

export function loadProjectSequence(projectSequence, projectTracks) {
    stopSequencePlayback({ resetPosition: true });

    const arrangementTracks = (projectTracks ?? [])
        .filter((track) => Array.isArray(track?.midi?.notes) && track.midi.notes.length > 0)
        .map((track) => ({
            id: track.id,
            name: track.name,
            sourceTrackIndex: track.source?.midiTrackIndex ?? 0,
            channel: track.source?.channel ?? 0,
            channelDisplay: (track.source?.channel ?? 0) + 1,
            notes: track.midi.notes,
            noteSegments: buildNoteSegments(track.midi.notes),
            durationMs: track.midi.durationMs ?? 0,
            noteCount: track.midi.noteCount ?? track.midi.notes.length
        }));

    loadedArrangement = arrangementTracks.length > 0
        ? {
            fileName: projectSequence?.fileName ?? 'Project Sequence',
            ticksPerBeat: projectSequence?.ticksPerBeat ?? null,
            tempoMap: projectSequence?.tempoMap ?? [],
            timeSignatures: projectSequence?.timeSignatures ?? [],
            durationMs: arrangementTracks.reduce((maximum, track) => Math.max(maximum, track.durationMs), 0),
            tracks: arrangementTracks
        }
        : null;

    notifySequenceTransportListeners();
    return getSequenceTransportState();
}

export async function playLoadedSequence() {
    if (!loadedArrangement) {
        throw new Error('Load a MIDI file before pressing play.');
    }

    if (isSequencePlaying) {
        return getSequenceTransportState();
    }

    const startOffsetMs = getCurrentPlaybackPositionMs();
    playbackPositionMs = startOffsetMs;
    playbackStartTimestampMs = performance.now();
    isSequencePlaying = true;
    startPlaybackProgressUpdates();

    const remainingEvents = buildPlaybackEventsFromNotes(loadedArrangement.tracks)
        .filter((event) => event.timeMs >= startOffsetMs);

    playbackTimeouts = remainingEvents.map((event) => window.setTimeout(() => {
        if (event.type === 'noteOn') {
            registerSequenceNoteOn(event.trackId, event.noteNumber);
            handleNoteOn(event.trackId, event.noteNumber, event.velocity || 0.8, performance.now());
            return;
        }

        registerSequenceNoteOff(event.trackId, event.noteNumber);
        handleNoteOff(event.trackId, event.noteNumber, performance.now());
    }, Math.max(0, event.timeMs - startOffsetMs)));

    playbackCompletionTimeout = window.setTimeout(() => {
        clearScheduledSequencePlayback();
        releaseActiveSequenceNotes();
        isSequencePlaying = false;
        playbackPositionMs = loadedArrangement.durationMs;
        notifySequenceTransportListeners();
    }, Math.max(0, loadedArrangement.durationMs - startOffsetMs) + 10);

    notifySequenceTransportListeners();
    return getSequenceTransportState();
}

export function stopLoadedSequence() {
    stopSequencePlayback();
    return getSequenceTransportState();
}

export function rewindLoadedSequence() {
    stopSequencePlayback({ resetPosition: true });
    return getSequenceTransportState();
}

export function subscribeToSequenceTransport(callback) {
    sequenceTransportListeners.add(callback);
    callback(getSequenceTransportState());

    return () => {
        sequenceTransportListeners.delete(callback);
    };
}

export function getActiveNotes() {
    return [];
}

export function addVirtualNote(trackId, noteNumber, velocity = 0.8) {
    handleNoteOn(trackId, noteNumber, velocity, performance.now());
}

export function removeVirtualNote(trackId, noteNumber) {
    handleNoteOff(trackId, noteNumber, performance.now());
}

export function onNoteOn(callback) {
    noteOnListeners.push(callback);
    return () => {
        const index = noteOnListeners.indexOf(callback);
        if (index > -1) {
            noteOnListeners.splice(index, 1);
        }
    };
}

export function onNoteOff(callback) {
    noteOffListeners.push(callback);
    return () => {
        const index = noteOffListeners.indexOf(callback);
        if (index > -1) {
            noteOffListeners.splice(index, 1);
        }
    };
}

export function clearAllNotes() {
    noteOff(null, -1);
}
