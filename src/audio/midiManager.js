// Web MIDI API Manager
// Handles MIDI input and forwards note events to the audio engine.

import { parseMidi } from 'midi-file';
import { noteOn, noteOff } from './audioEngine.js';

// Listeners for note events
const noteOnListeners = [];
const noteOffListeners = [];
const sequenceTransportListeners = new Set();

let midiAccess = null;
let selectedInputId = null;
let loadedSequence = null;
let loadedMidiFile = null;
let isSequencePlaying = false;
let playbackPositionMs = 0;
let playbackStartTimestampMs = 0;
let playbackTimeouts = [];
let playbackCompletionTimeout = null;
const activeSequenceNotes = new Map();

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
    if (!loadedSequence) {
        return 0;
    }

    if (!isSequencePlaying) {
        return playbackPositionMs;
    }

    return Math.min(
        loadedSequence.durationMs,
        playbackPositionMs + (performance.now() - playbackStartTimestampMs)
    );
}

function getSequenceTransportState() {
    return {
        hasSequence: Boolean(loadedSequence),
        fileName: loadedSequence?.fileName ?? null,
        channel: loadedSequence?.channel ?? null,
        channelDisplay: loadedSequence ? loadedSequence.channel + 1 : null,
        availableChannels: loadedMidiFile?.channels ?? [],
        durationMs: loadedSequence?.durationMs ?? 0,
        eventCount: loadedSequence?.events.length ?? 0,
        isPlaying: isSequencePlaying,
        playbackPositionMs: getCurrentPlaybackPositionMs()
    };
}

function notifySequenceTransportListeners() {
    const state = getSequenceTransportState();
    sequenceTransportListeners.forEach((listener) => listener(state));
}

function clearScheduledSequencePlayback() {
    playbackTimeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
    playbackTimeouts = [];

    if (playbackCompletionTimeout !== null) {
        window.clearTimeout(playbackCompletionTimeout);
        playbackCompletionTimeout = null;
    }
}

function releaseActiveSequenceNotes() {
    activeSequenceNotes.forEach((count, noteNumber) => {
        if (count > 0) {
            handleNoteOff(Number(noteNumber), performance.now());
        }
    });

    activeSequenceNotes.clear();
}

function registerSequenceNoteOn(noteNumber) {
    activeSequenceNotes.set(noteNumber, (activeSequenceNotes.get(noteNumber) ?? 0) + 1);
}

function registerSequenceNoteOff(noteNumber) {
    const activeCount = activeSequenceNotes.get(noteNumber) ?? 0;

    if (activeCount <= 1) {
        activeSequenceNotes.delete(noteNumber);
        return;
    }

    activeSequenceNotes.set(noteNumber, activeCount - 1);
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

function extractPlayableChannels(timedEvents) {
    const channelMap = new Map();

    timedEvents.forEach((event) => {
        if (event.channel === undefined || (event.type !== 'noteOn' && event.type !== 'noteOff')) {
            return;
        }

        if (!channelMap.has(event.channel)) {
            channelMap.set(event.channel, []);
        }

        channelMap.get(event.channel).push({
            type: event.type === 'noteOn' && event.velocity > 0 ? 'noteOn' : 'noteOff',
            timeMs: event.timeMs,
            noteNumber: event.noteNumber,
            velocity: event.type === 'noteOn' ? event.velocity / 127 : 0
        });
    });

    return Array.from(channelMap.entries())
        .map(([channel, events]) => ({
            channel,
            channelDisplay: channel + 1,
            eventCount: events.length,
            durationMs: events.length > 0 ? events[events.length - 1].timeMs : 0,
            events
        }))
        .filter((channelData) => channelData.events.some((event) => event.type === 'noteOn'))
        .sort((left, right) => left.channel - right.channel);
}

function buildSequenceForChannel(fileData, channel) {
    const channelData = fileData.channels.find((entry) => entry.channel === channel);

    if (!channelData) {
        throw new Error('The selected MIDI channel is not available in this file.');
    }

    return {
        fileName: fileData.fileName,
        channel: channelData.channel,
        durationMs: channelData.durationMs,
        events: channelData.events
    };
}

function buildMidiFileData(midiData, fileName) {
    const { header, tracks } = midiData;

    if (!header.ticksPerBeat) {
        throw new Error('This MIDI file uses an unsupported time division.');
    }

    const absoluteEvents = [];

    tracks.forEach((track, trackIndex) => {
        let absoluteTicks = 0;

        track.forEach((event, eventIndex) => {
            absoluteTicks += event.deltaTime ?? 0;

            if (event.type === 'setTempo' || event.type === 'noteOn' || event.type === 'noteOff') {
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
        left.absoluteTicks - right.absoluteTicks ||
        getEventPriority(left) - getEventPriority(right) ||
        left.trackIndex - right.trackIndex ||
        left.eventIndex - right.eventIndex
    ));

    let currentTempo = 500000;
    let currentTicks = 0;
    let currentTimeMs = 0;

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
        }

        return timedEvent;
    });

    const channels = extractPlayableChannels(timedEvents);

    if (channels.length === 0) {
        throw new Error('No note data was found in this MIDI file.');
    }

    return {
        fileName,
        channels
    };
}

// Initialize Web MIDI API
export async function initializeMIDI() {
    if (!navigator.requestMIDIAccess) {
        console.warn('Web MIDI API not supported in this browser');
        return false;
    }
    
    try {
        midiAccess = await navigator.requestMIDIAccess();
        console.log('MIDI Access obtained');
        
        // Listen for device connections/disconnections
        midiAccess.onstatechange = handleStateChange;
        
        // If there's an input, auto-select the first one
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

// Get list of available MIDI inputs
export function getMIDIInputs() {
    if (!midiAccess) return [];
    return Array.from(midiAccess.inputs.values()).map(input => ({
        id: input.id,
        name: input.name,
        manufacturer: input.manufacturer,
        state: input.state
    }));
}

// Select a specific MIDI input device
export function selectMIDIInput(inputId) {
    if (!midiAccess) return false;
    
    // Disconnect previous input
    if (selectedInputId) {
        const prevInput = midiAccess.inputs.get(selectedInputId);
        if (prevInput) {
            prevInput.onmidimessage = null;
        }
    }
    
    // Connect new input
    const input = midiAccess.inputs.get(inputId);
    if (!input) return false;
    
    input.onmidimessage = handleMIDIMessage;
    selectedInputId = inputId;
    console.log(`MIDI input selected: ${input.name}`);
    return true;
}

// Handle MIDI state changes (device connect/disconnect)
function handleStateChange(event) {
    console.log(`MIDI device ${event.port.state}: ${event.port.name}`);
    
    // If our selected device disconnected, clear selection
    if (event.port.id === selectedInputId && event.port.state === 'disconnected') {
        selectedInputId = null;
    }
}

// Handle incoming MIDI messages
function handleMIDIMessage(event) {
    const [status, note, velocity] = event.data;
    const command = status >> 4; // Upper 4 bits
    const channel = status & 0x0F; // Lower 4 bits
    
    switch (command) {
        case 0x9: // Note On
            if (velocity > 0) {
                handleNoteOn(note, velocity / 127, event.timeStamp);
            } else {
                // Some devices send note on with velocity 0 as note off
                handleNoteOff(note, event.timeStamp);
            }
            break;
            
        case 0x8: // Note Off
            handleNoteOff(note, event.timeStamp);
            break;
            
        // Could add more MIDI message types here (CC, pitch bend, etc.)
    }
}

// Internal note on handler
function handleNoteOn(noteNumber, velocity, timestamp) {
    noteOn(noteNumber, velocity);
    
    const noteData = {
        noteNumber,
        velocity,
        noteOnTime: timestamp
    };
    
    // Notify listeners
    noteOnListeners.forEach(listener => listener(noteData));
}

// Internal note off handler
function handleNoteOff(noteNumber, timestamp) {
    noteOff(noteNumber);
    
    // Notify listeners
    noteOffListeners.forEach(listener => listener({ noteNumber, timestamp }));
}

export async function loadMIDIFile(file) {
    if (!file) {
        throw new Error('No MIDI file was provided.');
    }

    const arrayBuffer = await file.arrayBuffer();
    const midiData = parseMidi(new Uint8Array(arrayBuffer));

    stopSequencePlayback({ resetPosition: true });
    loadedMidiFile = buildMidiFileData(midiData, file.name);
    loadedSequence = buildSequenceForChannel(loadedMidiFile, loadedMidiFile.channels[0].channel);
    notifySequenceTransportListeners();

    return getSequenceTransportState();
}

export function selectLoadedSequenceChannel(channel) {
    if (!loadedMidiFile) {
        throw new Error('Load a MIDI file before choosing a channel.');
    }

    stopSequencePlayback({ resetPosition: true });
    loadedSequence = buildSequenceForChannel(loadedMidiFile, channel);
    notifySequenceTransportListeners();

    return getSequenceTransportState();
}

export async function playLoadedSequence() {
    if (!loadedSequence) {
        throw new Error('Load a MIDI file before pressing play.');
    }

    if (isSequencePlaying) {
        return getSequenceTransportState();
    }

    const startOffsetMs = getCurrentPlaybackPositionMs();
    playbackPositionMs = startOffsetMs;
    playbackStartTimestampMs = performance.now();
    isSequencePlaying = true;

    const remainingEvents = loadedSequence.events.filter((event) => event.timeMs >= startOffsetMs);
    playbackTimeouts = remainingEvents.map((event) => window.setTimeout(() => {
        if (event.type === 'noteOn') {
            registerSequenceNoteOn(event.noteNumber);
            handleNoteOn(event.noteNumber, event.velocity || 0.8, performance.now());
            return;
        }

        registerSequenceNoteOff(event.noteNumber);
        handleNoteOff(event.noteNumber, performance.now());
    }, Math.max(0, event.timeMs - startOffsetMs)));

    playbackCompletionTimeout = window.setTimeout(() => {
        clearScheduledSequencePlayback();
        releaseActiveSequenceNotes();
        isSequencePlaying = false;
        playbackPositionMs = loadedSequence.durationMs;
        notifySequenceTransportListeners();
    }, Math.max(0, loadedSequence.durationMs - startOffsetMs) + 10);

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

// Get all currently active notes - DEPRECATED, use voiceAllocator.getActiveVoices()
export function getActiveNotes() {
    // This is now handled by voiceAllocator
    // Kept for backward compatibility but should not be used
    console.warn('getActiveNotes() is deprecated, use getActiveVoices() from voiceAllocator');
    return [];
}

// Add virtual note (from computer keyboard or UI)
export function addVirtualNote(noteNumber, velocity = 0.8) {
    handleNoteOn(noteNumber, velocity, performance.now());
}

// Remove virtual note
export function removeVirtualNote(noteNumber) {
    handleNoteOff(noteNumber, performance.now());
}

// Subscribe to note on events
export function onNoteOn(callback) {
    noteOnListeners.push(callback);
    return () => {
        const index = noteOnListeners.indexOf(callback);
        if (index > -1) noteOnListeners.splice(index, 1);
    };
}

// Subscribe to note off events
export function onNoteOff(callback) {
    noteOffListeners.push(callback);
    return () => {
        const index = noteOffListeners.indexOf(callback);
        if (index > -1) noteOffListeners.splice(index, 1);
    };
}

// Clear all active notes (panic button)
export function clearAllNotes() {
    noteOff(-1);
}
