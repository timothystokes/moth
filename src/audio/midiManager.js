// Web MIDI API Manager
// Handles MIDI input and triggers voice allocation

import { allocateVoice, releaseNote } from './voiceAllocator.js';

// Listeners for note events
const noteOnListeners = [];
const noteOffListeners = [];

let midiAccess = null;
let selectedInputId = null;

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
    // Allocate a voice for this note
    const voiceId = allocateVoice(noteNumber, velocity);
    
    const noteData = {
        noteNumber,
        velocity,
        noteOnTime: timestamp,
        voiceId
    };
    
    // Notify listeners
    noteOnListeners.forEach(listener => listener(noteData));
}

// Internal note off handler
function handleNoteOff(noteNumber, timestamp) {
    // Release the note (voice persists until silent)
    releaseNote(noteNumber);
    
    // Notify listeners
    noteOffListeners.forEach(listener => listener({ noteNumber, timestamp }));
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
    const notes = Array.from(activeNotes.keys());
    notes.forEach(noteNumber => handleNoteOff(noteNumber, performance.now()));
}
