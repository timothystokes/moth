// Voice Allocation Manager
// Manages a pool of voices that persist until their output reaches zero
// Voices are reused when they become silent, not when notes are released

const MAX_VOICES = 16; // Maximum polyphony

// Voice states
const VOICE_FREE = 'free';       // Available for allocation
const VOICE_ACTIVE = 'active';   // Note is held (gate > 0)
const VOICE_RELEASE = 'release'; // Note released (gate = -1) but still audible

// Configuration
let gateMonitoringEnabled = false; // If false, voices become FREE immediately on release

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

// Note tracking: noteNumber -> voiceId
const noteToVoiceMap = new Map();

// Allocate a voice for a note
export function allocateVoice(noteNumber, velocity) {
    // Check if this note is already playing (retriggering)
    if (noteToVoiceMap.has(noteNumber)) {
        const voiceId = noteToVoiceMap.get(noteNumber);
        const voice = voices.find(v => v.voiceId === voiceId);
        if (voice) {
            // Retrigger: reset the voice with new velocity
            voice.state = VOICE_ACTIVE;
            voice.velocity = velocity;
            voice.gate = velocity;
            voice.cv = (noteNumber - 36) / 12; // 1V/octave, C2=0V
            voice.noteOnTime = performance.now();
            voice.silentSampleCount = 0;
            return voice.voiceId;
        }
    }
    
    // Find a free voice
    let targetVoice = voices.find(v => v.state === VOICE_FREE);
    
    // If no free voice, try to steal a releasing voice
    if (!targetVoice) {
        targetVoice = voices.find(v => v.state === VOICE_RELEASE);
    }
    
    // If still no voice, steal the oldest active voice
    if (!targetVoice) {
        targetVoice = voices.reduce((oldest, v) => 
            v.noteOnTime < oldest.noteOnTime ? v : oldest
        );
        // Remove old note mapping
        if (targetVoice.noteNumber !== null) {
            noteToVoiceMap.delete(targetVoice.noteNumber);
        }
    }
    
    // Allocate voice
    targetVoice.state = VOICE_ACTIVE;
    targetVoice.noteNumber = noteNumber;
    targetVoice.velocity = velocity;
    targetVoice.gate = velocity;
    targetVoice.cv = (noteNumber - 36) / 12; // 1V/octave, C2=0V
    targetVoice.noteOnTime = performance.now();
    targetVoice.silentSampleCount = 0;
    
    noteToVoiceMap.set(noteNumber, targetVoice.voiceId);
    
    return targetVoice.voiceId;
}

// Release a note (set gate to -1 but keep voice allocated)
export function releaseNote(noteNumber) {
    const voiceId = noteToVoiceMap.get(noteNumber);
    if (!voiceId) return;
    
    const voice = voices.find(v => v.voiceId === voiceId);
    if (voice && voice.state === VOICE_ACTIVE) {
        voice.gate = 0; // Gate off (0 = off, 0-1 = velocity)
        
        if (gateMonitoringEnabled) {
            // Gate is being used by envelope/VCA - keep voice allocated until silent
            voice.state = VOICE_RELEASE;
        } else {
            // No gate monitoring - voice becomes FREE immediately but keeps playing
            // Remove from note mapping so it can be stolen by next note
            noteToVoiceMap.delete(noteNumber);
            voice.state = VOICE_FREE;
            voice.noteNumber = null;
            // Note: CV and other params stay the same so oscillator keeps playing
        }
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
                if (voice.noteNumber !== null) {
                    noteToVoiceMap.delete(voice.noteNumber);
                }
                voice.state = VOICE_FREE;
                voice.noteNumber = null;
                voice.velocity = 0;
                voice.gate = 0;
                voice.cv = 0;
                voice.silentSampleCount = 0;
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
        .filter(v => {
            // Include ACTIVE and RELEASE voices
            if (v.state === VOICE_ACTIVE || v.state === VOICE_RELEASE) {
                return true;
            }
            // Also include FREE voices that are still playing (have been used)
            // This happens when gate monitoring is disabled - voice is FREE but keeps playing
            if (v.state === VOICE_FREE && v.cv !== 0) {
                return true;
            }
            return false;
        })
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
        if (voice.state === VOICE_ACTIVE) {
            voice.state = VOICE_RELEASE;
            voice.gate = 0;
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
