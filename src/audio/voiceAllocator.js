// Voice Allocation Manager
// Manages a pool of voices that persist until their output reaches zero
// Voices are reused when they become silent, not when notes are released

const MAX_VOICES = 8; // Maximum polyphony

// Voice states
const VOICE_FREE = 'free';       // Available for allocation
const VOICE_ACTIVE = 'active';   // Note is held (gate > 0)
const VOICE_RELEASE = 'release'; // Note released (gate = -1) but still audible

// Configuration
let gateMonitoringEnabled = false; // If false, voices become FREE immediately on release
let nextVoiceIndex = 0;
let keyboardLatchModeEnabled = false;
const KEYBOARD_LATCH_VOICE_INDEX = 0;

// Voice pool
const voices = [];

// Initialize voice pool
for (let i = 0; i < MAX_VOICES; i++) {
    voices.push({
        voiceId: `voice-${i}`,
        state: VOICE_FREE,
        noteNumber: null,
        velocity: 0,
        gate: 0, // Gate: 0 (off) to 1 (full velocity)
        cv: 0,
        noteOnTime: 0,
        lastOutputLevel: 0, // Track output to detect silence
        silentSampleCount: 0 // Count samples at zero output
    });
}

// Note tracking: noteNumber -> [voiceId, ...]
const noteToVoiceMap = new Map();

function addVoiceMapping(noteNumber, voiceId) {
    const voiceIds = noteToVoiceMap.get(noteNumber) ?? [];
    voiceIds.push(voiceId);
    noteToVoiceMap.set(noteNumber, voiceIds);
}

function removeVoiceMapping(noteNumber, voiceId) {
    if (noteNumber === null || noteNumber === undefined) {
        return;
    }

    const voiceIds = noteToVoiceMap.get(noteNumber);
    if (!voiceIds) {
        return;
    }

    const nextVoiceIds = voiceIds.filter(id => id !== voiceId);
    if (nextVoiceIds.length > 0) {
        noteToVoiceMap.set(noteNumber, nextVoiceIds);
    } else {
        noteToVoiceMap.delete(noteNumber);
    }
}

function clearVoice(voice) {
    removeVoiceMapping(voice.noteNumber, voice.voiceId);
    voice.state = VOICE_FREE;
    voice.noteNumber = null;
    voice.velocity = 0;
    voice.gate = 0;
    voice.cv = 0;
    voice.noteOnTime = 0;
    voice.lastOutputLevel = 0;
    voice.silentSampleCount = 0;
}

function claimRoundRobinVoice() {
    const startIndex = nextVoiceIndex;

    for (let offset = 0; offset < MAX_VOICES; offset++) {
        const index = (startIndex + offset) % MAX_VOICES;
        const voice = voices[index];
        if (voice.state === VOICE_FREE) {
            nextVoiceIndex = (index + 1) % MAX_VOICES;
            return voice;
        }
    }

    for (let offset = 0; offset < MAX_VOICES; offset++) {
        const index = (startIndex + offset) % MAX_VOICES;
        const voice = voices[index];
        if (voice.state === VOICE_RELEASE) {
            nextVoiceIndex = (index + 1) % MAX_VOICES;
            return voice;
        }
    }

    const voice = voices[startIndex];
    nextVoiceIndex = (startIndex + 1) % MAX_VOICES;
    return voice;
}

function getKeyboardLatchVoice() {
    return voices[KEYBOARD_LATCH_VOICE_INDEX];
}

export function setKeyboardLatchMode(enabled) {
    keyboardLatchModeEnabled = enabled;

    if (!enabled) {
        const latchedVoice = getKeyboardLatchVoice();
        if (latchedVoice && latchedVoice.gate <= 0) {
            clearVoice(latchedVoice);
        }
    }
}

export function isKeyboardLatchModeEnabled() {
    return keyboardLatchModeEnabled;
}

// Allocate a voice for a note
export function allocateVoice(noteNumber, velocity) {
    const targetVoice = keyboardLatchModeEnabled
        ? getKeyboardLatchVoice()
        : claimRoundRobinVoice();

    clearVoice(targetVoice);

    targetVoice.state = VOICE_ACTIVE;
    targetVoice.noteNumber = noteNumber;
    targetVoice.velocity = velocity;
    targetVoice.gate = velocity;
    targetVoice.cv = (noteNumber - 69) / 12; // 1V/octave, A4=0V
    targetVoice.noteOnTime = performance.now();
    targetVoice.silentSampleCount = 0;

    addVoiceMapping(noteNumber, targetVoice.voiceId);
    
    return targetVoice.voiceId;
}

// Release a note (set gate to -1 but keep voice allocated)
export function releaseNote(noteNumber) {
    const voiceIds = noteToVoiceMap.get(noteNumber);
    const voiceId = voiceIds?.[voiceIds.length - 1];
    if (!voiceId) return;

    const voice = voices.find(v => v.voiceId === voiceId);
    if (!voice || voice.state === VOICE_FREE) {
        removeVoiceMapping(noteNumber, voiceId);
        return;
    }

    removeVoiceMapping(noteNumber, voiceId);
    voice.gate = 0;

    if (keyboardLatchModeEnabled && voice.voiceId === getKeyboardLatchVoice().voiceId) {
        voice.state = VOICE_ACTIVE;
        return;
    }

    if (gateMonitoringEnabled) {
        voice.state = VOICE_RELEASE;
    } else {
        clearVoice(voice);
    }
}

// Enable or disable gate monitoring
// When disabled, voices become FREE immediately on note release (but keep playing)
// When enabled, voices persist until output is silent
export function setGateMonitoring(enabled) {
    gateMonitoringEnabled = enabled;
}

// Get gate monitoring status
export function isGateMonitoringEnabled() {
    return gateMonitoringEnabled;
}

// Update voice output level (called by amplifier after processing)
// Returns true if voice should be freed
export function updateVoiceOutput(voiceId, outputLevel) {
    const voice = voices.find(v => v.voiceId === voiceId);
    if (!voice) return false;
    
    voice.lastOutputLevel = Math.abs(outputLevel);
    
    // If in release state and output is silent, mark for deallocation
    if (voice.state === VOICE_RELEASE) {
        const SILENCE_THRESHOLD = 0.0001; // -80dB roughly
        const SILENCE_SAMPLES_REQUIRED = 100; // ~2ms at 44.1kHz
        
        if (voice.lastOutputLevel < SILENCE_THRESHOLD) {
            voice.silentSampleCount++;
            
            if (voice.silentSampleCount >= SILENCE_SAMPLES_REQUIRED) {
                // Voice is truly silent, deallocate it
                clearVoice(voice);
                return true; // Voice was freed
            }
        } else {
            // Reset counter if we hear sound again
            voice.silentSampleCount = 0;
        }
    }
    
    return false;
}

// Get all active and releasing voices (for amplifier to process)
export function getActiveVoices() {
    return voices
        .filter(v => v.state === VOICE_ACTIVE || v.state === VOICE_RELEASE)
        .map(v => ({
            voiceId: v.voiceId,
            noteNumber: v.noteNumber,
            velocity: v.velocity,
            gate: v.gate,
            cv: v.cv,
            state: v.state
        }));
}

// Get voice by ID
export function getVoice(voiceId) {
    const voice = voices.find(v => v.voiceId === voiceId);
    if (!voice) return null;
    
    return {
        voiceId: voice.voiceId,
        noteNumber: voice.noteNumber,
        velocity: voice.velocity,
        gate: voice.gate,
        cv: voice.cv,
        state: voice.state
    };
}

// Force release all voices (panic)
export function releaseAllVoices() {
    voices.forEach(voice => {
        if (voice.state === VOICE_ACTIVE || voice.state === VOICE_RELEASE) {
            voice.gate = 0;
            if (gateMonitoringEnabled) {
                voice.state = VOICE_RELEASE;
            } else {
                clearVoice(voice);
            }
        }
    });
}

// Get voice pool statistics
export function getVoiceStats() {
    return {
        total: MAX_VOICES,
        free: voices.filter(v => v.state === VOICE_FREE).length,
        active: voices.filter(v => v.state === VOICE_ACTIVE).length,
        releasing: voices.filter(v => v.state === VOICE_RELEASE).length
    };
}
