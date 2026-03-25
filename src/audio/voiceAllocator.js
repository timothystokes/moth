// Simple Round Robin Voice Allocator
const MAX_VOICES = 8; // Maximum polyphony
let nextVoiceIndex = 0;

const voices = [];
for (let i = 0; i < MAX_VOICES; i++) {
    voices.push({
        voiceId: `voice-${i}`,
        noteNumber: null,
        velocity: 0, // 0..5V (continuous)
        gate: 0,     // 0 or 5 (switch, +5V logic)
        cv: 0
    });
}


function claimRoundRobinVoice() {
    const voice = voices[nextVoiceIndex];
    nextVoiceIndex = (nextVoiceIndex + 1) % MAX_VOICES;
    return voice;
}

// No latch mode in simple allocator

// Allocate a voice for a note (round robin)
export function allocateVoice(noteNumber, velocity) {
    const voice = claimRoundRobinVoice();
    voice.noteNumber = noteNumber;
    // velocity is now 0..5V, gate is 0 or 5V
    voice.velocity = velocity; // 0..5V
    voice.gate = velocity > 0 ? 5 : 0; // 0 or 5V logic
    voice.cv = (noteNumber - 69) / 12; // 1V/octave, A4=0V
    return voice.voiceId;
}

// Release a note: set gate=0 for the lane that matches noteNumber
export function releaseNote(noteNumber) {
    for (let i = 0; i < MAX_VOICES; i++) {
        const voice = voices[i];
        if (voice.noteNumber === noteNumber) {
            voice.gate = 0;
            break;
        }
    }
}


// Force release all voices (panic)
export function releaseAllVoices() {
    voices.forEach(voice => {
        voice.gate = 0;
    });
}

