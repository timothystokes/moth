const MAX_VOICES = 8;
const VOICE_FREE = 'free';
const VOICE_ACTIVE = 'active';
const VOICE_RELEASE = 'release';
const TIME_MIN = 0.001;
const TIME_MAX = 10;
const KEYBOARD_LATCH_VOICE_INDEX = 0;
const GATE_HIGH_VOLTAGE = 5;
const ENVELOPE_MAX_VOLTAGE = 5;

function createVoice(trackId, index) {
    return {
        voiceId: `${trackId}:voice-${index}`,
        state: VOICE_FREE,
        noteNumber: null,
        velocity: 0,
        gate: 0,
        cv: 0,
        noteOnTime: 0
    };
}

function createTrackState(trackId, track = {}) {
    return {
        trackId,
        volume: track.volume ?? 0.8,
        mute: Boolean(track.mute),
        keyboardLatchModeEnabled: Boolean(track.keyboardLatchModeEnabled),
        nextVoiceIndex: 0,
        noteToVoiceMap: new Map(),
        voices: Array.from({ length: MAX_VOICES }, (_, index) => createVoice(trackId, index))
    };
}

class MothSynthProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.modules = new Map();
        this.connections = new Map();
        this.trackStates = new Map();
        this.frameCache = new Map();
        this.voiceDependencyCache = new Map();
        this.currentTimeMs = 0;
        this.scopeBuffer = new Float32Array(4096);
        this.scopeWriteIndex = 0;
        this.scopeSampleCounter = 0;
        this.scopeTrackId = null;

        this.oscillatorStates = new Map();
        this.filterStates = new Map();
        this.envelopeStates = new Map();
        this.randomStates = new Map();

        this.port.onmessage = (event) => {
            this.handleMessage(event.data);
        };
    }

    handleMessage(message) {
        switch (message.type) {
            case 'sync-state':
                this.modules.clear();
                this.connections.clear();
                this.trackStates.clear();
                message.modules.forEach(({ moduleId, module }) => {
                    this.modules.set(moduleId, module);
                });
                message.connections.forEach(({ fromModuleId, toModuleId, inputName }) => {
                    this.setConnection(fromModuleId, toModuleId, inputName);
                });
                message.tracks?.forEach(({ trackId, track }) => {
                    this.upsertTrack(trackId, track);
                });
                this.scopeTrackId = message.scopeTrackId ?? null;
                break;
            case 'upsert-module':
                this.modules.set(message.moduleId, message.module);
                break;
            case 'remove-module':
                this.modules.delete(message.moduleId);
                this.clearRuntimeState(message.moduleId);
                break;
            case 'connect':
                this.setConnection(message.fromModuleId, message.toModuleId, message.inputName);
                break;
            case 'disconnect':
                this.removeConnection(message.toModuleId, message.inputName);
                break;
            case 'upsert-track':
                this.upsertTrack(message.trackId, message.track);
                break;
            case 'remove-track':
                this.removeTrack(message.trackId);
                break;
            case 'set-scope-track':
                this.scopeTrackId = message.trackId ?? null;
                break;
            case 'note-on':
                this.allocateVoice(message.trackId, message.noteNumber, message.velocity);
                break;
            case 'note-off':
                this.releaseVoice(message.trackId, message.noteNumber);
                break;
            case 'all-notes-off':
                this.trackStates.forEach((trackState) => {
                    this.getActiveVoices(trackState).forEach((voice) => {
                        voice.gate = 0;
                        voice.state = VOICE_RELEASE;
                    });
                });
                break;
            case 'clear-state':
                this.modules.clear();
                this.connections.clear();
                this.trackStates.clear();
                this.resetRuntimeState();
                this.scopeTrackId = null;
                break;
            default:
                break;
        }
    }

    upsertTrack(trackId, track) {
        const existing = this.trackStates.get(trackId) ?? createTrackState(trackId, track);
        existing.volume = track.volume ?? existing.volume;
        existing.mute = Boolean(track.mute);
        existing.keyboardLatchModeEnabled = Boolean(track.keyboardLatchModeEnabled);
        this.trackStates.set(trackId, existing);
        this.updateKeyboardLatchVoice(existing);
    }

    removeTrack(trackId) {
        this.trackStates.delete(trackId);
        const trackPrefix = `${trackId}:`;

        Array.from(this.modules.keys())
            .filter((moduleId) => moduleId.startsWith(trackPrefix))
            .forEach((moduleId) => {
                this.modules.delete(moduleId);
                this.clearRuntimeState(moduleId);
            });

        Array.from(this.connections.keys()).forEach((toModuleId) => {
            if (toModuleId.startsWith(trackPrefix)) {
                this.connections.delete(toModuleId);
                return;
            }

            const inputs = this.connections.get(toModuleId);
            const nextInputs = Object.fromEntries(
                Object.entries(inputs).filter(([, fromModuleId]) => !fromModuleId.startsWith(trackPrefix))
            );
            if (Object.keys(nextInputs).length > 0) {
                this.connections.set(toModuleId, nextInputs);
            } else {
                this.connections.delete(toModuleId);
            }
        });

        if (this.scopeTrackId === trackId) {
            this.scopeTrackId = null;
        }
    }

    setConnection(fromModuleId, toModuleId, inputName) {
        if (!this.connections.has(toModuleId)) {
            this.connections.set(toModuleId, {});
        }

        this.connections.get(toModuleId)[inputName] = fromModuleId;
    }

    removeConnection(toModuleId, inputName) {
        const inputs = this.connections.get(toModuleId);
        if (inputs) {
            delete inputs[inputName];
        }
    }

    resetRuntimeState() {
        this.oscillatorStates.clear();
        this.filterStates.clear();
        this.envelopeStates.clear();
        this.randomStates.clear();
    }

    clearRuntimeState(moduleId) {
        this.oscillatorStates.delete(moduleId);
        this.filterStates.delete(moduleId);
        this.envelopeStates.delete(moduleId);
        this.randomStates.delete(moduleId);
    }

    getTrackOutputModuleId(trackId) {
        return `${trackId}:track-output`;
    }

    getTrackState(trackId) {
        if (!trackId) {
            return null;
        }

        if (!this.trackStates.has(trackId)) {
            this.trackStates.set(trackId, createTrackState(trackId));
        }

        return this.trackStates.get(trackId);
    }

    getKeyboardLatchVoice(trackState) {
        return trackState.voices[KEYBOARD_LATCH_VOICE_INDEX];
    }

    updateKeyboardLatchVoice(trackState) {
        const latchedVoice = this.getKeyboardLatchVoice(trackState);
        if (!latchedVoice) {
            return;
        }

        if (trackState.keyboardLatchModeEnabled) {
            if (latchedVoice.state === VOICE_FREE) {
                latchedVoice.state = VOICE_ACTIVE;
                latchedVoice.noteOnTime = this.currentTimeMs;
            }
            return;
        }

        if (latchedVoice.gate <= 0 && latchedVoice.noteNumber === null) {
            this.clearVoice(trackState, latchedVoice);
        }
    }

    addVoiceMapping(trackState, noteNumber, voiceId) {
        const voiceIds = trackState.noteToVoiceMap.get(noteNumber) ?? [];
        voiceIds.push(voiceId);
        trackState.noteToVoiceMap.set(noteNumber, voiceIds);
    }

    removeVoiceMapping(trackState, noteNumber, voiceId) {
        if (noteNumber === null || noteNumber === undefined) {
            return;
        }

        const voiceIds = trackState.noteToVoiceMap.get(noteNumber);
        if (!voiceIds) {
            return;
        }

        const nextVoiceIds = voiceIds.filter((id) => id !== voiceId);
        if (nextVoiceIds.length > 0) {
            trackState.noteToVoiceMap.set(noteNumber, nextVoiceIds);
        } else {
            trackState.noteToVoiceMap.delete(noteNumber);
        }
    }

    clearVoice(trackState, voice) {
        this.removeVoiceMapping(trackState, voice.noteNumber, voice.voiceId);
        voice.state = VOICE_FREE;
        voice.noteNumber = null;
        voice.velocity = 0;
        voice.gate = 0;
        voice.cv = 0;
        voice.noteOnTime = 0;
    }

    claimRoundRobinVoice(trackState) {
        const voice = trackState.voices[trackState.nextVoiceIndex];
        trackState.nextVoiceIndex = (trackState.nextVoiceIndex + 1) % MAX_VOICES;
        return voice;
    }

    allocateVoice(trackId, noteNumber, velocity) {
        const trackState = this.getTrackState(trackId);
        if (!trackState) {
            return;
        }

        const targetVoice = trackState.keyboardLatchModeEnabled
            ? this.getKeyboardLatchVoice(trackState)
            : this.claimRoundRobinVoice(trackState);

        this.clearVoice(trackState, targetVoice);
        targetVoice.state = VOICE_ACTIVE;
        targetVoice.noteNumber = noteNumber;
        targetVoice.velocity = velocity;
        targetVoice.gate = GATE_HIGH_VOLTAGE;
        targetVoice.cv = (noteNumber - 69) / 12;
        targetVoice.noteOnTime = this.currentTimeMs;

        this.addVoiceMapping(trackState, noteNumber, targetVoice.voiceId);
    }

    releaseVoice(trackId, noteNumber) {
        const trackState = this.getTrackState(trackId);
        if (!trackState) {
            return;
        }

        const voiceIds = trackState.noteToVoiceMap.get(noteNumber);
        const voiceId = voiceIds?.[voiceIds.length - 1];
        if (!voiceId) {
            return;
        }

        const voice = trackState.voices.find((candidate) => candidate.voiceId === voiceId);
        if (!voice || voice.state === VOICE_FREE) {
            this.removeVoiceMapping(trackState, noteNumber, voiceId);
            return;
        }

        this.removeVoiceMapping(trackState, noteNumber, voiceId);
        voice.gate = 0;

        if (trackState.keyboardLatchModeEnabled && voice.voiceId === this.getKeyboardLatchVoice(trackState).voiceId) {
            voice.state = VOICE_ACTIVE;
            return;
        }

        voice.state = VOICE_RELEASE;
    }

    getActiveVoices(trackState) {
        return trackState.voices.filter((voice) => voice.state === VOICE_ACTIVE || voice.state === VOICE_RELEASE);
    }

    getConnectionSource(moduleId, inputName) {
        const inputs = this.connections.get(moduleId);
        return inputs ? inputs[inputName] : null;
    }

    isInputVoiceDependent(moduleId, inputName, visited) {
        const sourceModuleId = this.getConnectionSource(moduleId, inputName);
        return sourceModuleId ? this.isModuleVoiceDependent(sourceModuleId, visited) : false;
    }

    isModuleVoiceDependent(moduleId, visited = new Set()) {
        if (this.voiceDependencyCache.has(moduleId)) {
            return this.voiceDependencyCache.get(moduleId);
        }

        if (visited.has(moduleId)) {
            return false;
        }

        const module = this.modules.get(moduleId);
        if (!module) {
            return false;
        }

        visited.add(moduleId);

        let isVoiceDependent;

        switch (module.type) {
            case 'keyboard-cv':
            case 'keyboard-gate':
                isVoiceDependent = true;
                break;
            case 'oscillator':
                isVoiceDependent = ['freq-input', 'amp-input', 'shape-input', 'duty-input']
                    .some((inputName) => this.isInputVoiceDependent(moduleId, inputName, visited));
                break;
            case 'filter':
                isVoiceDependent = ['audio-input', 'cutoff-input', 'resonance-input']
                    .some((inputName) => this.isInputVoiceDependent(moduleId, inputName, visited));
                break;
            case 'envelope':
                isVoiceDependent = ['gate-input', 'attack-input', 'decay-input', 'sustain-input', 'release-input']
                    .some((inputName) => this.isInputVoiceDependent(moduleId, inputName, visited));
                break;
            case 'random':
                isVoiceDependent = this.isInputVoiceDependent(moduleId, 'rate-input', visited);
                break;
            case 'mixer':
                isVoiceDependent = ['input-a', 'input-b', 'level-a-input', 'level-b-input']
                    .some((inputName) => this.isInputVoiceDependent(moduleId, inputName, visited));
                break;
            case 'multi':
                isVoiceDependent = this.isInputVoiceDependent(moduleId, 'signal-input', visited);
                break;
            default:
                isVoiceDependent = false;
                break;
        }

        visited.delete(moduleId);
        this.voiceDependencyCache.set(moduleId, isVoiceDependent);
        return isVoiceDependent;
    }

    getInputValue(moduleId, inputName, timeMs, voiceContext) {
        const sourceModuleId = this.getConnectionSource(moduleId, inputName);
        return sourceModuleId ? this.getModuleOutput(sourceModuleId, timeMs, voiceContext) : 0;
    }

    getRuntimeMap(store, moduleId) {
        if (!store.has(moduleId)) {
            store.set(moduleId, new Map());
        }

        return store.get(moduleId);
    }

    getModuleOutput(moduleId, timeMs, voiceContext) {
        const cacheKey = `${voiceContext?.voiceId ?? 'global'}|${moduleId}`;
        if (this.frameCache.has(cacheKey)) {
            return this.frameCache.get(cacheKey);
        }

        const module = this.modules.get(moduleId);
        if (!module) {
            return 0;
        }

        const output = this.processModule(moduleId, module, timeMs, voiceContext);
        this.frameCache.set(cacheKey, output);
        return output;
    }

    processModule(moduleId, module, timeMs, voiceContext) {
        switch (module.type) {
            case 'oscillator':
                return this.processOscillator(moduleId, module.params, timeMs, voiceContext);
            case 'filter':
                return this.processFilter(moduleId, module.params, timeMs, voiceContext);
            case 'envelope':
                return this.processEnvelope(moduleId, module.params, timeMs, voiceContext);
            case 'random':
                return this.processRandom(moduleId, module.params, timeMs, voiceContext);
            case 'mixer':
                return this.processMixer(moduleId, module.params, timeMs, voiceContext);
            case 'multi':
                return this.getInputValue(moduleId, 'signal-input', timeMs, voiceContext);
            case 'keyboard-cv':
                return voiceContext?.cv ?? 0;
            case 'keyboard-gate':
                return voiceContext?.gate ?? 0;
            default:
                return 0;
        }
    }

    processOscillator(moduleId, params, timeMs, voiceContext) {
        const frequency = params.frequency;
        const amplitude = params.amplitude;
        const shape = params.shape;
        const dutyCycle = params.dutyCycle;
        const freqNudgeOctaves = this.getConnectionSource(moduleId, 'freq-input')
            ? this.getInputValue(moduleId, 'freq-input', timeMs, voiceContext)
            : 0;
        const ampModActive = this.getConnectionSource(moduleId, 'amp-input');
        const shapeModActive = this.getConnectionSource(moduleId, 'shape-input');
        const dutyModActive = this.getConnectionSource(moduleId, 'duty-input');

        let finalFreq = frequency * Math.pow(2, freqNudgeOctaves);
        let finalAmp = amplitude;

        if (ampModActive) {
            const modVoltage = this.getInputValue(moduleId, 'amp-input', timeMs, voiceContext);
            if (modVoltage >= 0 && modVoltage <= GATE_HIGH_VOLTAGE) {
                finalAmp = amplitude * (modVoltage / GATE_HIGH_VOLTAGE);
            } else {
                finalAmp = Math.max(0, Math.min(1, amplitude + modVoltage / 20));
            }
        }

        let finalShape = shape;
        if (shapeModActive) {
            finalShape = Math.max(0, Math.min(1, shape + this.getInputValue(moduleId, 'shape-input', timeMs, voiceContext) / 20));
        }

        let finalDuty = Math.max(0.02, Math.min(0.98, dutyCycle));
        if (dutyModActive) {
            finalDuty = Math.max(0.02, Math.min(0.98, dutyCycle + this.getInputValue(moduleId, 'duty-input', timeMs, voiceContext) / 20));
        }

        const voiceId = voiceContext?.voiceId ?? 'default';
        const runtimeMap = this.getRuntimeMap(this.oscillatorStates, moduleId);
        const voiceState = runtimeMap.get(voiceId) ?? { phase: 0, lastTime: null };

        let accPhase = voiceState.phase;
        if (voiceState.lastTime !== null && voiceState.lastTime !== timeMs) {
            const dt = (timeMs - voiceState.lastTime) / 1000;
            accPhase = (voiceState.phase + 2 * Math.PI * finalFreq * dt) % (2 * Math.PI);
        }

        runtimeMap.set(voiceId, { phase: accPhase, lastTime: timeMs });

        const p = accPhase / (2 * Math.PI);
        const d = finalDuty;
        const ps = (p + 0.25) % 1;
        const pw = Math.min(ps / (2 * d), 0.5) + Math.max((ps - d) / (2 * (1 - d)), 0);
        const sineWave = -Math.cos(pw * 2 * Math.PI);
        const triangleWave = pw < 0.5 ? pw * 4 - 1 : 3 - pw * 4;
        const squareness = finalShape <= 0.5 ? (0.5 - finalShape) * 2 : 0;
        const pulseWidthAmount = squareness;
        const squareDuty = 0.5 + (d - 0.5) * pulseWidthAmount;
        const squareWindowPhase = (pw - (0.5 - squareDuty / 2) + 1) % 1;
        const squarePhase = Math.min(squareWindowPhase / (2 * squareDuty), 0.5)
            + Math.max((squareWindowPhase - squareDuty) / (2 * (1 - squareDuty)), 0);
        const squareCarrier = Math.sin(squarePhase * 2 * Math.PI);
        const leftHalfSine = sineWave * (1 - pulseWidthAmount) + squareCarrier * pulseWidthAmount;
        const squareEdgeExponent = 0.001 + (1 - squareness) * 0.5;
        const squareTargetWave = Math.sign(squareCarrier) * Math.pow(Math.abs(squareCarrier), squareEdgeExponent);
        const leftHalfWave = leftHalfSine * (1 - squareness) + squareTargetWave * squareness;

        let wave;
        if (finalShape <= 0.5) {
            wave = leftHalfWave;
        } else {
            const sineToTriangle = (finalShape - 0.5) * 2;
            wave = sineWave * (1 - sineToTriangle) + triangleWave * sineToTriangle;
        }

        return wave * finalAmp * 10;
    }

    processFilter(moduleId, params, timeMs, voiceContext) {
        const cutoff = 20 * Math.pow(1000, 1 - params.cutoffSlider);
        const resonance = params.resonance;
        const filterType = params.filterType;
        const inputSignal = this.getInputValue(moduleId, 'audio-input', timeMs, voiceContext);

        let finalCutoff = cutoff;
        if (this.getConnectionSource(moduleId, 'cutoff-input')) {
            finalCutoff = cutoff * Math.pow(2, this.getInputValue(moduleId, 'cutoff-input', timeMs, voiceContext) / 5);
            finalCutoff = Math.max(20, Math.min(20000, finalCutoff));
        }

        let finalResonance = resonance;
        if (this.getConnectionSource(moduleId, 'resonance-input')) {
            finalResonance = resonance + this.getInputValue(moduleId, 'resonance-input', timeMs, voiceContext) / 20;
            finalResonance = Math.max(0, Math.min(0.99, finalResonance));
        }

        const voiceId = voiceContext?.voiceId ?? 'global';
        const runtimeMap = this.getRuntimeMap(this.filterStates, moduleId);
        const filterState = runtimeMap.get(voiceId) ?? { lowpass: 0, bandpass: 0 };
        const nyquist = sampleRate / 2;
        const safeCutoff = Math.min(finalCutoff, nyquist * 0.8);
        const f = Math.min(2 * Math.sin(Math.PI * safeCutoff / sampleRate), 1.9);
        const qNormalized = Math.max(0.01, 1 - finalResonance);
        const lowpass = filterState.lowpass + f * filterState.bandpass;
        const highpass = inputSignal - lowpass - qNormalized * filterState.bandpass;
        const bandpass = f * highpass + filterState.bandpass;

        if (!Number.isFinite(lowpass) || !Number.isFinite(bandpass)) {
            runtimeMap.set(voiceId, { lowpass: 0, bandpass: 0 });
            return 0;
        }

        runtimeMap.set(voiceId, { lowpass, bandpass });
        return filterType === 'lowpass' ? lowpass : highpass;
    }

    processEnvelope(moduleId, params, timeMs, voiceContext) {
        const attackMod = this.getConnectionSource(moduleId, 'attack-input')
            ? this.getInputValue(moduleId, 'attack-input', timeMs, voiceContext)
            : 0;
        const decayMod = this.getConnectionSource(moduleId, 'decay-input')
            ? this.getInputValue(moduleId, 'decay-input', timeMs, voiceContext)
            : 0;
        const sustainMod = this.getConnectionSource(moduleId, 'sustain-input')
            ? this.getInputValue(moduleId, 'sustain-input', timeMs, voiceContext)
            : 0;
        const releaseMod = this.getConnectionSource(moduleId, 'release-input')
            ? this.getInputValue(moduleId, 'release-input', timeMs, voiceContext)
            : 0;

        const finalAttack = Math.max(TIME_MIN, Math.min(TIME_MAX, params.attack * Math.pow(2, attackMod / 10)));
        const finalDecay = Math.max(TIME_MIN, Math.min(TIME_MAX, params.decay * Math.pow(2, decayMod / 10)));
        const finalSustain = Math.max(0, Math.min(1, params.sustain + sustainMod / 20));
        const finalRelease = Math.max(TIME_MIN, Math.min(TIME_MAX, params.release * Math.pow(2, releaseMod / 10)));

        const voiceId = voiceContext?.voiceId ?? 'default';
        const runtimeMap = this.getRuntimeMap(this.envelopeStates, moduleId);
        const voiceState = runtimeMap.get(voiceId) ?? {
            stage: 'idle',
            value: 0,
            lastTime: null,
            lastGate: 0,
            stageElapsed: 0,
            releaseStartValue: 0,
            lastTriggerNoteOnTime: null
        };

        const gateSourceId = this.getConnectionSource(moduleId, 'gate-input');
        const gate = gateSourceId
            ? this.getInputValue(moduleId, 'gate-input', timeMs, voiceContext)
            : 0;
        const gateOn = gate > 0;
        const gateWasOn = voiceState.lastGate > 0;
        const triggerNoteOnTime = gateSourceId && this.isModuleVoiceDependent(gateSourceId)
            ? (voiceContext?.noteOnTime ?? null)
            : null;
        const hasRetriggeredWhileHigh = gateOn
            && triggerNoteOnTime !== null
            && triggerNoteOnTime !== voiceState.lastTriggerNoteOnTime;

        if ((gateOn && !gateWasOn) || hasRetriggeredWhileHigh) {
            voiceState.stage = 'attack';
            voiceState.value = 0;
            voiceState.stageElapsed = 0;
            voiceState.releaseStartValue = 0;
            voiceState.lastTime = timeMs;
            voiceState.lastTriggerNoteOnTime = triggerNoteOnTime;
        } else if (!gateOn && gateWasOn) {
            voiceState.stage = 'release';
            voiceState.stageElapsed = 0;
            voiceState.releaseStartValue = voiceState.value;
            voiceState.lastTime = timeMs;
        }

        const dt = voiceState.lastTime !== null && voiceState.lastTime !== timeMs
            ? Math.max(0, (timeMs - voiceState.lastTime) / 1000)
            : 0;
        voiceState.stageElapsed += dt;

        switch (voiceState.stage) {
            case 'attack': {
                const progress = finalAttack <= TIME_MIN ? 1 : Math.min(1, voiceState.stageElapsed / finalAttack);
                voiceState.value = progress;
                if (progress >= 1) {
                    voiceState.stage = 'decay';
                    voiceState.stageElapsed = 0;
                    voiceState.value = 1;
                }
                break;
            }
            case 'decay': {
                const progress = finalDecay <= TIME_MIN ? 1 : Math.min(1, voiceState.stageElapsed / finalDecay);
                voiceState.value = 1 + (finalSustain - 1) * progress;
                if (progress >= 1) {
                    voiceState.stage = gateOn ? 'sustain' : 'release';
                    voiceState.stageElapsed = 0;
                    voiceState.value = finalSustain;
                    if (!gateOn) {
                        voiceState.releaseStartValue = voiceState.value;
                    }
                }
                break;
            }
            case 'sustain':
                voiceState.value = finalSustain;
                break;
            case 'release': {
                const progress = finalRelease <= TIME_MIN ? 1 : Math.min(1, voiceState.stageElapsed / finalRelease);
                voiceState.value = voiceState.releaseStartValue * (1 - progress);
                if (progress >= 1 || voiceState.value <= 0.00001) {
                    voiceState.stage = 'idle';
                    voiceState.stageElapsed = 0;
                    voiceState.value = 0;
                    voiceState.releaseStartValue = 0;
                }
                break;
            }
            default:
                voiceState.stage = gateOn ? 'attack' : 'idle';
                voiceState.value = gateOn ? voiceState.value : 0;
                break;
        }

        voiceState.lastGate = gate;
        voiceState.lastTime = timeMs;
        if (!gateOn && triggerNoteOnTime === null) {
            voiceState.lastTriggerNoteOnTime = null;
        }
        runtimeMap.set(voiceId, voiceState);
        return Math.max(0, Math.min(ENVELOPE_MAX_VOLTAGE, voiceState.value * ENVELOPE_MAX_VOLTAGE));
    }

    processRandom(moduleId, params, timeMs, voiceContext) {
        const state = this.randomStates.get(moduleId) ?? { lastOutputTime: 0, currentValue: 0 };
        let finalRate = params.rate;
        if (this.getConnectionSource(moduleId, 'rate-input')) {
            finalRate = params.rate * Math.pow(2, this.getInputValue(moduleId, 'rate-input', timeMs, voiceContext) / 10);
            finalRate = Math.max(0.1, Math.min(2000, finalRate));
        }

        const intervalMs = 1000 / finalRate;
        if (timeMs - state.lastOutputTime >= intervalMs) {
            state.currentValue = Math.random() * 20 - 10;
            state.lastOutputTime = timeMs;
        }

        this.randomStates.set(moduleId, state);
        return state.currentValue;
    }

    processMixer(moduleId, params, timeMs, voiceContext) {
        const signalA = this.getInputValue(moduleId, 'input-a', timeMs, voiceContext);
        const signalB = this.getInputValue(moduleId, 'input-b', timeMs, voiceContext);
        let finalLevelA = params.levelA;
        let finalLevelB = params.levelB;

        if (this.getConnectionSource(moduleId, 'level-a-input')) {
            finalLevelA = Math.max(0, Math.min(1, params.levelA + this.getInputValue(moduleId, 'level-a-input', timeMs, voiceContext) / 20));
        }

        if (this.getConnectionSource(moduleId, 'level-b-input')) {
            finalLevelB = Math.max(0, Math.min(1, params.levelB + this.getInputValue(moduleId, 'level-b-input', timeMs, voiceContext) / 20));
        }

        return signalA * finalLevelA + signalB * finalLevelB;
    }

    publishScopeSnapshot() {
        const snapshotLength = 360;
        const bufferSize = this.scopeBuffer.length;
        let triggerIndex = -1;

        for (let searchOffset = snapshotLength; searchOffset < Math.min(1000, bufferSize - 3); searchOffset++) {
            const index = (this.scopeWriteIndex - searchOffset + bufferSize) % bufferSize;
            const prev3 = (index - 3 + bufferSize) % bufferSize;
            const prev2 = (index - 2 + bufferSize) % bufferSize;
            const prev1 = (index - 1 + bufferSize) % bufferSize;
            const next1 = (index + 1) % bufferSize;
            const next2 = (index + 2) % bufferSize;

            const prev3Below = this.scopeBuffer[prev3] <= 0 && this.scopeBuffer[prev2] <= 0 && this.scopeBuffer[prev1] <= 0;
            const next3Above = this.scopeBuffer[index] >= 0 && this.scopeBuffer[next1] >= 0 && this.scopeBuffer[next2] >= 0;

            if (prev3Below && next3Above) {
                triggerIndex = index;
                break;
            }
        }

        if (triggerIndex === -1) {
            triggerIndex = (this.scopeWriteIndex - snapshotLength + bufferSize) % bufferSize;
        }

        const snapshot = new Float32Array(360);
        for (let index = 0; index < snapshot.length; index++) {
            const bufferIndex = (triggerIndex + index) % this.scopeBuffer.length;
            snapshot[index] = this.scopeBuffer[bufferIndex];
        }

        this.port.postMessage({ type: 'scope-data', samples: snapshot }, [snapshot.buffer]);
    }

    process(_inputs, outputs) {
        const outputChannel = outputs[0][0];
        const msPerSample = 1000 / sampleRate;

        for (let sampleIndex = 0; sampleIndex < outputChannel.length; sampleIndex++) {
            this.frameCache.clear();
            this.voiceDependencyCache.clear();
            const sampleTimeMs = this.currentTimeMs;
            let mixedSample = 0;
            let scopedSample = 0;

            this.trackStates.forEach((trackState, trackId) => {
                const outputSourceId = this.getConnectionSource(this.getTrackOutputModuleId(trackId), 'audio-input');
                if (!outputSourceId || trackState.mute) {
                    return;
                }

                const activeVoices = this.getActiveVoices(trackState);
                const requiresPerVoiceMix = this.isModuleVoiceDependent(outputSourceId);
                let trackSample = 0;

                if (requiresPerVoiceMix && activeVoices.length > 0) {
                    for (const voice of activeVoices) {
                        const voiceContext = {
                            voiceId: voice.voiceId,
                            noteNumber: voice.noteNumber,
                            velocity: voice.velocity,
                            gate: voice.gate,
                            cv: voice.cv,
                            noteOnTime: voice.noteOnTime
                        };

                        const voiceSignal = this.getModuleOutput(outputSourceId, sampleTimeMs, voiceContext);
                        trackSample += voiceSignal / 10;
                    }

                    trackSample /= Math.sqrt(activeVoices.length);
                } else if (!requiresPerVoiceMix) {
                    trackSample = this.getModuleOutput(outputSourceId, sampleTimeMs, null) / 10;
                }

                trackSample *= trackState.volume;
                mixedSample += trackSample;

                if (trackId === this.scopeTrackId) {
                    scopedSample = trackSample;
                }
            });

            outputChannel[sampleIndex] = mixedSample;
            this.scopeBuffer[this.scopeWriteIndex] = scopedSample;
            this.scopeWriteIndex = (this.scopeWriteIndex + 1) % this.scopeBuffer.length;
            this.scopeSampleCounter += 1;
            if (this.scopeSampleCounter >= 2048) {
                this.publishScopeSnapshot();
                this.scopeSampleCounter = 0;
            }

            this.currentTimeMs += msPerSample;
        }

        return true;
    }
}

registerProcessor('moth-synth-processor', MothSynthProcessor);