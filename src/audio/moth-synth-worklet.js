const MAX_VOICES = 4;
const VOICE_FREE = 'free';
const VOICE_ACTIVE = 'active';
const VOICE_RELEASE = 'release';
const TIME_MIN = 0.001;
const TIME_MAX = 10;
const KEYBOARD_LATCH_VOICE_INDEX = 0;
const GATE_HIGH_VOLTAGE = 5;
const ENVELOPE_MAX_VOLTAGE = 5;
const MAX_OUTPUT_SAMPLE = 1;

function createVoice(trackId, index) {
    return {
        voiceId: `${trackId}:voice-${index}`,
        state: VOICE_FREE,
        noteNumber: null,
        velocity: 0,
        gate: 0,
        cv: 0
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
        this.compiledModuleInputs = new Map();
        this.compiledModuleEvaluators = new Map();
        this.compiledTrackOutputs = new Map();
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
        this.reportedRuntimeIssues = new Set();
        this.diagnosticSerial = 0;
        this.lastVoiceStatusSignature = null;

        this.port.onmessage = (event) => {
            this.handleMessage(event.data);
        };
    }

    invalidateGraphAnalysisCache() {
        this.voiceDependencyCache.clear();
    }

    rebuildCompiledRouting() {
        this.compiledModuleInputs.clear();
        this.compiledModuleEvaluators.clear();
        this.compiledTrackOutputs.clear();

        this.connections.forEach((inputs, toModuleId) => {
            const compiledInputs = {};

            Object.entries(inputs).forEach(([inputName, sourceModuleId]) => {
                compiledInputs[inputName] = { sourceModuleId };
            });

            this.compiledModuleInputs.set(toModuleId, compiledInputs);
        });

        this.connections.forEach((_inputs, toModuleId) => {
            if (!toModuleId.endsWith(':track-output')) {
                return;
            }

            const trackId = toModuleId.slice(0, -':track-output'.length);
            const sourceModuleId = this.getCompiledInputRoute(toModuleId, 'audio-input')?.sourceModuleId ?? null;
            if (!sourceModuleId) {
                return;
            }

            this.compiledTrackOutputs.set(trackId, {
                sourceModuleId,
                read: this.compileModuleEvaluator(sourceModuleId, new Set())
            });
        });
    }

    getCompiledInputRoute(moduleId, inputName) {
        return this.compiledModuleInputs.get(moduleId)?.[inputName] ?? null;
    }

    getCompiledTrackOutputRoute(trackId) {
        return this.compiledTrackOutputs.get(trackId) ?? null;
    }

    reportError(error, context) {
        const normalizedError = error instanceof Error
            ? {
                message: error.message,
                stack: error.stack ?? null,
                name: error.name,
                context
            }
            : {
                message: String(error),
                stack: null,
                name: 'Error',
                context
            };

        try {
            this.port.postMessage({ type: 'worklet-error', error: normalizedError });
        } catch (_postError) {
        }
    }

    reportRuntimeIssueOnce(key, message, context) {
        if (this.reportedRuntimeIssues.has(key)) {
            return;
        }

        this.reportedRuntimeIssues.add(key);
        this.reportError(message, context);
    }

    reportDiagnostic(type, context, severity = 'warning') {
        try {
            this.port.postMessage({
                type: 'worklet-diagnostic',
                diagnostic: {
                    id: ++this.diagnosticSerial,
                    type,
                    severity,
                    context
                }
            });
        } catch (_postError) {
        }
    }

    sanitizeSample(sample, contextKey, context) {
        if (!Number.isFinite(sample)) {
            this.reportRuntimeIssueOnce(
                `${contextKey}:non-finite`,
                'Non-finite sample detected in audio render path.',
                context
            );
            return 0;
        }

        if (Math.abs(sample) > MAX_OUTPUT_SAMPLE) {
            this.reportDiagnostic('sample-clamped', {
                ...context,
                value: sample,
                clampedTo: Math.max(-MAX_OUTPUT_SAMPLE, Math.min(MAX_OUTPUT_SAMPLE, sample))
            }, 'warning');
            return Math.max(-MAX_OUTPUT_SAMPLE, Math.min(MAX_OUTPUT_SAMPLE, sample));
        }

        return sample;
    }

    sanitizeFiniteSample(sample, contextKey, context) {
        if (!Number.isFinite(sample)) {
            this.reportRuntimeIssueOnce(
                `${contextKey}:non-finite`,
                'Non-finite sample detected in intermediate audio render path.',
                context
            );
            return 0;
        }

        return sample;
    }

    buildVoiceStatus() {
        const perTrack = [];
        let noteAffinedVoices = 0;
        let releaseVoices = 0;
        let processingVoices = 0;
        let capacityVoices = 0;

        this.trackStates.forEach((trackState, trackId) => {
            const outputRoute = this.getCompiledTrackOutputRoute(trackId);
            const outputSourceId = outputRoute?.sourceModuleId ?? null;
            const isVoiceDependent = outputSourceId ? this.isModuleVoiceDependent(outputSourceId) : false;
            let trackNoteAffinedVoices = 0;
            let trackReleaseVoices = 0;
            let trackProcessingVoices = 0;

            capacityVoices += trackState.voices.length;

            trackState.voices.forEach((voice) => {
                if (voice.state === VOICE_ACTIVE) {
                    trackNoteAffinedVoices += 1;
                    return;
                }

                if (voice.state === VOICE_RELEASE) {
                    trackReleaseVoices += 1;
                }
            });

            if (!trackState.mute && outputSourceId) {
                trackProcessingVoices = isVoiceDependent ? trackState.voices.length : 1;
            }

            noteAffinedVoices += trackNoteAffinedVoices;
            releaseVoices += trackReleaseVoices;
            processingVoices += trackProcessingVoices;

            perTrack.push({
                trackId,
                capacityVoices: trackState.voices.length,
                outputConnected: Boolean(outputSourceId),
                voiceDependent: isVoiceDependent,
                noteAffinedVoices: trackNoteAffinedVoices,
                releaseVoices: trackReleaseVoices,
                processingVoices: trackProcessingVoices,
                muted: trackState.mute
            });
        });

        return {
            capacityVoices,
            noteAffinedVoices,
            releaseVoices,
            processingVoices,
            activeTrackCount: perTrack.filter((track) => track.processingVoices > 0).length,
            perTrack
        };
    }

    publishVoiceStatusIfChanged() {
        const voiceStatus = this.buildVoiceStatus();
        const signature = JSON.stringify(voiceStatus);
        if (signature === this.lastVoiceStatusSignature) {
            return;
        }

        this.lastVoiceStatusSignature = signature;

        try {
            this.port.postMessage({
                type: 'voice-status',
                voiceStatus
            });
        } catch (_postError) {
        }
    }

    handleMessage(message) {
        try {
            switch (message.type) {
                case 'sync-state':
                    this.modules.clear();
                    this.connections.clear();
                    this.compiledModuleInputs.clear();
                    this.compiledTrackOutputs.clear();
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
                    this.rebuildCompiledRouting();
                    this.invalidateGraphAnalysisCache();
                    break;
                case 'upsert-module':
                    this.modules.set(message.moduleId, message.module);
                    this.rebuildCompiledRouting();
                    this.invalidateGraphAnalysisCache();
                    break;
                case 'remove-module':
                    this.modules.delete(message.moduleId);
                    this.clearRuntimeState(message.moduleId);
                    this.rebuildCompiledRouting();
                    this.invalidateGraphAnalysisCache();
                    break;
                case 'connect':
                    this.setConnection(message.fromModuleId, message.toModuleId, message.inputName);
                    this.rebuildCompiledRouting();
                    this.invalidateGraphAnalysisCache();
                    break;
                case 'disconnect':
                    this.removeConnection(message.toModuleId, message.inputName);
                    this.rebuildCompiledRouting();
                    this.invalidateGraphAnalysisCache();
                    break;
                case 'upsert-track':
                    this.upsertTrack(message.trackId, message.track);
                    break;
                case 'remove-track':
                    this.removeTrack(message.trackId);
                    this.rebuildCompiledRouting();
                    this.invalidateGraphAnalysisCache();
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
                    this.compiledModuleInputs.clear();
                    this.compiledModuleEvaluators.clear();
                    this.compiledTrackOutputs.clear();
                    this.trackStates.clear();
                    this.resetRuntimeState();
                    this.scopeTrackId = null;
                    this.invalidateGraphAnalysisCache();
                    break;
                default:
                    break;
            }

            this.publishVoiceStatusIfChanged();
        } catch (error) {
            this.reportError(error, {
                phase: 'handleMessage',
                messageType: message?.type ?? null
            });
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
        this.reportedRuntimeIssues.clear();
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
        // Scale velocity to 0..5V (assume input velocity is 0..1)
        const velocityV = Math.max(0, Math.min(1, Number.isFinite(velocity) ? velocity : 1)) * GATE_HIGH_VOLTAGE;
        const gateV = velocityV > 0 ? GATE_HIGH_VOLTAGE : 0;

        this.clearVoice(trackState, targetVoice);
        targetVoice.state = VOICE_ACTIVE;
        targetVoice.noteNumber = noteNumber;
        targetVoice.velocity = velocityV; // 0..5V
        targetVoice.gate = gateV;         // 0 or 5V
        targetVoice.cv = (noteNumber - 69) / 12;

        // Debug logging for voice allocation
        // if (typeof console !== 'undefined' && console.log) {
        //     console.log('[MothSynth] allocateVoice', {
        //         trackId,
        //         voiceId: targetVoice.voiceId,
        //         noteNumber,
        //         cv: targetVoice.cv,
        //         velocity: velocityV,
        //         gate: gateV
        //     });
        // }

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

    isInputVoiceDependent(moduleId, inputName, visited) {
        const sourceModuleId = this.getCompiledInputRoute(moduleId, inputName)?.sourceModuleId ?? null;
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

    getRuntimeMap(store, moduleId) {
        if (!store.has(moduleId)) {
            store.set(moduleId, new Map());
        }

        return store.get(moduleId);
    }

    compileModuleEvaluator(moduleId, activeStack = new Set()) {
        if (this.compiledModuleEvaluators.has(moduleId)) {
            return this.compiledModuleEvaluators.get(moduleId);
        }

        if (activeStack.has(moduleId)) {
            this.reportRuntimeIssueOnce(
                `compile-cycle:${moduleId}`,
                `Detected a cyclic module graph while compiling ${moduleId}.`,
                {
                    phase: 'compile-module-evaluator',
                    moduleId
                }
            );
            return () => 0;
        }

        const module = this.modules.get(moduleId);
        if (!module) {
            return () => 0;
        }

        activeStack.add(moduleId);
        const baseEvaluator = this.createModuleFactory(moduleId, module, activeStack);
        activeStack.delete(moduleId);

        const evaluator = (timeMs, laneContext) => {
            const cacheKey = `${laneContext?.voiceId ?? 'global'}|${moduleId}`;
            if (this.frameCache.has(cacheKey)) {
                return this.frameCache.get(cacheKey);
            }

            const output = baseEvaluator(timeMs, laneContext);
            if (!Number.isFinite(output)) {
                this.reportRuntimeIssueOnce(
                    `module-output:${moduleId}`,
                    `Module ${moduleId} produced an invalid output sample.`,
                    {
                        phase: 'module-output',
                        moduleId,
                        moduleType: module.type,
                        voiceId: laneContext?.voiceId ?? null,
                        timeMs
                    }
                );
                this.frameCache.set(cacheKey, 0);
                return 0;
            }

            this.frameCache.set(cacheKey, output);
            return output;
        };

        this.compiledModuleEvaluators.set(moduleId, evaluator);
        return evaluator;
    }

    createInputReader(moduleId, inputName, activeStack) {
        const sourceModuleId = this.getCompiledInputRoute(moduleId, inputName)?.sourceModuleId ?? null;
        return sourceModuleId ? this.compileModuleEvaluator(sourceModuleId, activeStack) : null;
    }

    createModuleFactory(moduleId, module, activeStack) {
        switch (module.type) {
            case 'oscillator':
                return this.createOscillatorFactory(moduleId, module.params, activeStack);
            case 'filter':
                return this.createFilterFactory(moduleId, module.params, activeStack);
            case 'envelope':
                return this.createEnvelopeFactory(moduleId, module.params, activeStack);
            case 'random':
                return this.createRandomFactory(moduleId, module.params, activeStack);
            case 'mixer':
                return this.createMixerFactory(moduleId, module.params, activeStack);
            case 'multi': {
                const signalRead = this.createInputReader(moduleId, 'signal-input', activeStack);
                return (timeMs, laneContext) => (signalRead ? signalRead(timeMs, laneContext) : 0);
            }
            case 'keyboard-cv':
                return (_timeMs, laneContext) => laneContext?.cv ?? 0;
            case 'keyboard-gate':
                return (_timeMs, laneContext) => laneContext?.gate ?? 0;
            case 'keyboard-velocity':
                return (_timeMs, laneContext) => laneContext?.velocity ?? 0;
            default:
                return () => 0;
        }
    }

    createOscillatorFactory(moduleId, params, activeStack) {
        const freqRead = this.createInputReader(moduleId, 'freq-input', activeStack);
        const ampRead = this.createInputReader(moduleId, 'amp-input', activeStack);
        const shapeRead = this.createInputReader(moduleId, 'shape-input', activeStack);
        const dutyRead = this.createInputReader(moduleId, 'duty-input', activeStack);
        // Store oscillator state per voiceId
        const stateMap = new Map();

        return (timeMs, laneContext) => {
            const voiceId = laneContext?.voiceId ?? 'global';
            let oscState = stateMap.get(voiceId);
            if (!oscState) {
                oscState = { phase: 0, lastTime: null };
                stateMap.set(voiceId, oscState);
            }

            const frequency = params.frequency;
            const amplitude = params.amplitude;
            const shape = params.shape;
            const dutyCycle = params.dutyCycle;
            const freqNudgeOctaves = freqRead ? freqRead(timeMs, laneContext) : 0;

            let finalFreq = frequency * Math.pow(2, freqNudgeOctaves);
            let finalAmp = amplitude;

            if (ampRead) {
                const modVoltage = ampRead(timeMs, laneContext);
                if (modVoltage >= 0 && modVoltage <= GATE_HIGH_VOLTAGE) {
                    finalAmp = amplitude * (modVoltage / GATE_HIGH_VOLTAGE);
                } else {
                    finalAmp = Math.max(0, Math.min(1, amplitude + modVoltage / 20));
                }
            }

            let finalShape = shape;
            if (shapeRead) {
                finalShape = Math.max(0, Math.min(1, shape + shapeRead(timeMs, laneContext) / 20));
            }

            let finalDuty = Math.max(0.02, Math.min(0.98, dutyCycle));
            if (dutyRead) {
                finalDuty = Math.max(0.02, Math.min(0.98, dutyCycle + dutyRead(timeMs, laneContext) / 20));
            }

            let accPhase = oscState.phase;
            if (oscState.lastTime !== null && oscState.lastTime !== timeMs) {
                const dt = (timeMs - oscState.lastTime) / 1000;
                accPhase = (oscState.phase + 2 * Math.PI * finalFreq * dt) % (2 * Math.PI);
            }

            oscState.phase = accPhase;
            oscState.lastTime = timeMs;

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

            return finalAmp * wave;
        };
    }

    createFilterFactory(moduleId, params, activeStack) {
        const audioRead = this.createInputReader(moduleId, 'audio-input', activeStack);
        const cutoffRead = this.createInputReader(moduleId, 'cutoff-input', activeStack);
        const resonanceRead = this.createInputReader(moduleId, 'resonance-input', activeStack);
        // Store filter state per voice
        const stateMap = new Map();

        return (timeMs, laneContext) => {
            const voiceId = laneContext?.voiceId ?? 'global';
            let filterState = stateMap.get(voiceId);
            if (!filterState) {
                filterState = { lowpass: 0, bandpass: 0 };
                stateMap.set(voiceId, filterState);
            }

            const cutoff = 20 * Math.pow(1000, 1 - params.cutoffSlider);
            const resonance = params.resonance;
            const filterType = params.filterType;
            const inputSignal = audioRead ? audioRead(timeMs, laneContext) : 0;

            let finalCutoff = cutoff;
            if (cutoffRead) {
                finalCutoff = cutoff * Math.pow(2, cutoffRead(timeMs, laneContext) / 5);
                finalCutoff = Math.max(20, Math.min(20000, finalCutoff));
            }

            let finalResonance = resonance;
            if (resonanceRead) {
                finalResonance = resonance + resonanceRead(timeMs, laneContext) / 20;
                finalResonance = Math.max(0, Math.min(0.99, finalResonance));
            }

            const nyquist = sampleRate / 2;
            const safeCutoff = Math.min(finalCutoff, nyquist * 0.8);
            const f = Math.min(2 * Math.sin(Math.PI * safeCutoff / sampleRate), 1.9);
            const qNormalized = Math.max(0.01, 1 - finalResonance);
            const lowpass = filterState.lowpass + f * filterState.bandpass;
            const highpass = inputSignal - lowpass - qNormalized * filterState.bandpass;
            const bandpass = f * highpass + filterState.bandpass;

            if (!Number.isFinite(lowpass) || !Number.isFinite(bandpass)) {
                filterState.lowpass = 0;
                filterState.bandpass = 0;
                return 0;
            }

            filterState.lowpass = lowpass;
            filterState.bandpass = bandpass;
            return filterType === 'lowpass' ? lowpass : highpass;
        };
    }

    createEnvelopeFactory(moduleId, params, activeStack) {
        const attackRead = this.createInputReader(moduleId, 'attack-input', activeStack);
        const decayRead = this.createInputReader(moduleId, 'decay-input', activeStack);
        const sustainRead = this.createInputReader(moduleId, 'sustain-input', activeStack);
        const releaseRead = this.createInputReader(moduleId, 'release-input', activeStack);
        const gateRead = this.createInputReader(moduleId, 'gate-input', activeStack);
        // Store envelope state per voice
        const stateMap = new Map();

        return (timeMs, laneContext) => {
            const voiceId = laneContext?.voiceId ?? 'global';
            let envState = stateMap.get(voiceId);
            if (!envState) {
                envState = {
                    stage: 'idle',
                    value: 0,
                    lastTime: null,
                    lastGate: 0,
                    stageElapsed: 0,
                    releaseStartValue: 0
                };
                stateMap.set(voiceId, envState);
            }

            const attackMod = attackRead ? attackRead(timeMs, laneContext) : 0;
            const decayMod = decayRead ? decayRead(timeMs, laneContext) : 0;
            const sustainMod = sustainRead ? sustainRead(timeMs, laneContext) : 0;
            const releaseMod = releaseRead ? releaseRead(timeMs, laneContext) : 0;

            const finalAttack = Math.max(TIME_MIN, Math.min(TIME_MAX, params.attack * Math.pow(2, attackMod / 10)));
            const finalDecay = Math.max(TIME_MIN, Math.min(TIME_MAX, params.decay * Math.pow(2, decayMod / 10)));
            const finalSustain = Math.max(0, Math.min(1, params.sustain + sustainMod / 20));
            const finalRelease = Math.max(TIME_MIN, Math.min(TIME_MAX, params.release * Math.pow(2, releaseMod / 10)));

            const gate = gateRead ? gateRead(timeMs, laneContext) : 0;
            const gateOn = gate > 0;
            const gateWasOn = envState.lastGate > 0;

            if (gateOn && !gateWasOn) {
                envState.stage = 'attack';
                envState.value = 0;
                envState.stageElapsed = 0;
                envState.releaseStartValue = 0;
                envState.lastTime = timeMs;
            } else if (!gateOn && gateWasOn) {
                envState.stage = 'release';
                envState.stageElapsed = 0;
                envState.releaseStartValue = envState.value;
                envState.lastTime = timeMs;
            }

            const dt = envState.lastTime !== null && envState.lastTime !== timeMs
                ? Math.max(0, (timeMs - envState.lastTime) / 1000)
                : 0;
            envState.stageElapsed += dt;

            switch (envState.stage) {
                case 'attack': {
                    const progress = finalAttack <= TIME_MIN ? 1 : Math.min(1, envState.stageElapsed / finalAttack);
                    envState.value = progress;
                    if (progress >= 1) {
                        envState.stage = 'decay';
                        envState.stageElapsed = 0;
                        envState.value = 1;
                    }
                    break;
                }
                case 'decay': {
                    const progress = finalDecay <= TIME_MIN ? 1 : Math.min(1, envState.stageElapsed / finalDecay);
                    envState.value = 1 + (finalSustain - 1) * progress;
                    if (progress >= 1) {
                        envState.stage = gateOn ? 'sustain' : 'release';
                        envState.stageElapsed = 0;
                        envState.value = finalSustain;
                        if (!gateOn) {
                            envState.releaseStartValue = envState.value;
                        }
                    }
                    break;
                }
                case 'sustain':
                    envState.value = finalSustain;
                    break;
                case 'release': {
                    const progress = finalRelease <= TIME_MIN ? 1 : Math.min(1, envState.stageElapsed / finalRelease);
                    envState.value = envState.releaseStartValue * (1 - progress);
                    if (progress >= 1 || envState.value <= 0.00001) {
                        envState.stage = 'idle';
                        envState.stageElapsed = 0;
                        envState.value = 0;
                        envState.releaseStartValue = 0;
                    }
                    break;
                }
                default:
                    envState.stage = gateOn ? 'attack' : 'idle';
                    envState.value = gateOn ? envState.value : 0;
                    break;
            }

            envState.lastGate = gate;
            envState.lastTime = timeMs;
            return Math.max(0, Math.min(ENVELOPE_MAX_VOLTAGE, envState.value * ENVELOPE_MAX_VOLTAGE));
        };
    }

    createRandomFactory(moduleId, params, activeStack) {
        const rateRead = this.createInputReader(moduleId, 'rate-input', activeStack);
        // Store random state per voice
        const stateMap = new Map();

        return (timeMs, laneContext) => {
            const voiceId = laneContext?.voiceId ?? 'global';
            let randState = stateMap.get(voiceId);
            if (!randState) {
                randState = { lastOutputTime: 0, currentValue: 0 };
                stateMap.set(voiceId, randState);
            }

            let finalRate = params.rate;

            if (rateRead) {
                finalRate = params.rate * Math.pow(2, rateRead(timeMs, laneContext) / 10);
                finalRate = Math.max(0.1, Math.min(2000, finalRate));
            }

            const intervalMs = 1000 / finalRate;
            if (timeMs - randState.lastOutputTime >= intervalMs) {
                randState.currentValue = Math.random() * 20 - 10;
                randState.lastOutputTime = timeMs;
            }

            return randState.currentValue;
        };
    }

    createMixerFactory(moduleId, params, activeStack) {
        const inputARead = this.createInputReader(moduleId, 'input-a', activeStack);
        const inputBRead = this.createInputReader(moduleId, 'input-b', activeStack);
        const levelARead = this.createInputReader(moduleId, 'level-a-input', activeStack);
        const levelBRead = this.createInputReader(moduleId, 'level-b-input', activeStack);

        return (timeMs, laneContext) => {
            const signalA = inputARead ? inputARead(timeMs, laneContext) : 0;
            const signalB = inputBRead ? inputBRead(timeMs, laneContext) : 0;
            let finalLevelA = params.levelA;
            let finalLevelB = params.levelB;

            if (levelARead) {
                finalLevelA = Math.max(0, Math.min(1, params.levelA + levelARead(timeMs, laneContext) / 20));
            }

            if (levelBRead) {
                finalLevelB = Math.max(0, Math.min(1, params.levelB + levelBRead(timeMs, laneContext) / 20));
            }

            return signalA * finalLevelA + signalB * finalLevelB;
        };
    }

    publishScopeSnapshot() {
        try {
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
                snapshot[index] = Number.isFinite(this.scopeBuffer[bufferIndex]) ? this.scopeBuffer[bufferIndex] * 2 : 0;
            }

            this.port.postMessage({ type: 'scope-data', samples: snapshot }, [snapshot.buffer]);
        } catch (error) {
            this.reportRuntimeIssueOnce('scope-publish', 'Failed to publish scope snapshot.', {
                phase: 'publish-scope-snapshot',
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }

    process(_inputs, outputs) {
        try {
            const outputChannel = outputs[0][0];
            const msPerSample = 1000 / sampleRate;
            const trackRenderPlans = [];

            this.trackStates.forEach((trackState, trackId) => {
                const outputRoute = this.getCompiledTrackOutputRoute(trackId);
                const outputSourceId = outputRoute?.sourceModuleId ?? null;
                if (!outputSourceId || trackState.mute) {
                    return;
                }

                trackRenderPlans.push({
                    trackId,
                    trackState,
                    outputSourceId,
                    outputRead: outputRoute.read,
                    requiresPerVoiceMix: this.isModuleVoiceDependent(outputSourceId),
                    volume: trackState.volume,
                    isScopeTrack: trackId === this.scopeTrackId
                });
            });

            const activeTrackCount = trackRenderPlans.length;

            for (let sampleIndex = 0; sampleIndex < outputChannel.length; sampleIndex++) {
                this.frameCache.clear();
                const sampleTimeMs = this.currentTimeMs;
                let mixedSample = 0;
                let scopedSample = 0;
                const topTrackIds = [null, null, null, null];
                const topModuleIds = [null, null, null, null];
                const topSamples = [0, 0, 0, 0];

                for (const plan of trackRenderPlans) {
                    const { trackId, trackState, outputSourceId, outputRead, requiresPerVoiceMix, volume, isScopeTrack } = plan;
                    let trackSample = 0;

                    if (requiresPerVoiceMix) {
                        let contributingVoiceCount = 0;

                        for (const voice of trackState.voices) {
                            const laneContext = voice;

                            const voiceSignal = outputRead(sampleTimeMs, laneContext);
                            if (!Number.isFinite(voiceSignal)) {
                                this.reportRuntimeIssueOnce(
                                    `track-voice-signal:${trackId}:${outputSourceId}`,
                                    `Track ${trackId} produced an invalid voice signal.`,
                                    {
                                        phase: 'track-voice-signal',
                                        trackId,
                                        moduleId: outputSourceId,
                                        voiceId: voice.voiceId,
                                        timeMs: sampleTimeMs
                                    }
                                );
                                continue;
                            }

                            if (Math.abs(voiceSignal) > 0.000001) {
                                contributingVoiceCount += 1;
                            }

                            trackSample += voiceSignal / 10;
                        }

                        if (contributingVoiceCount > 1) {
                            trackSample /= Math.sqrt(contributingVoiceCount);
                        }
                    } else if (!requiresPerVoiceMix) {
                        trackSample = outputRead(sampleTimeMs, null) / 10;
                    }

                    if (!Number.isFinite(trackSample)) {
                        this.reportRuntimeIssueOnce(
                            `track-sample:${trackId}`,
                            `Track ${trackId} produced an invalid mixed sample.`,
                            {
                                phase: 'track-sample',
                                trackId,
                                moduleId: outputSourceId,
                                timeMs: sampleTimeMs
                            }
                        );
                        trackSample = 0;
                    }

                    trackSample *= volume;
                    trackSample = this.sanitizeFiniteSample(trackSample, `track-sample:${trackId}`, {
                        phase: 'track-post-volume',
                        trackId,
                        moduleId: outputSourceId,
                        timeMs: sampleTimeMs
                    });

                    const trackSampleAbs = Math.abs(trackSample);
                    if (trackSampleAbs > 0.0001) {
                        for (let index = 0; index < topSamples.length; index++) {
                            if (trackSampleAbs > Math.abs(topSamples[index])) {
                                for (let shiftIndex = topSamples.length - 1; shiftIndex > index; shiftIndex--) {
                                    topSamples[shiftIndex] = topSamples[shiftIndex - 1];
                                    topTrackIds[shiftIndex] = topTrackIds[shiftIndex - 1];
                                    topModuleIds[shiftIndex] = topModuleIds[shiftIndex - 1];
                                }

                                topSamples[index] = trackSample;
                                topTrackIds[index] = trackId;
                                topModuleIds[index] = outputSourceId;
                                break;
                            }
                        }
                    }

                    mixedSample += trackSample;

                    if (isScopeTrack) {
                        scopedSample = trackSample;
                    }
                }

                if (activeTrackCount > 1) {
                    mixedSample /= Math.sqrt(activeTrackCount);
                }

                const trackContributions = Math.abs(mixedSample) > MAX_OUTPUT_SAMPLE
                    ? topTrackIds
                        .map((trackId, index) => trackId
                            ? {
                                trackId,
                                moduleId: topModuleIds[index],
                                sample: topSamples[index]
                            }
                            : null)
                        .filter(Boolean)
                    : undefined;

                mixedSample = this.sanitizeSample(mixedSample, 'mixed-sample', {
                    phase: 'mixed-sample',
                    timeMs: sampleTimeMs,
                    activeTrackCount,
                    trackCount: this.trackStates.size,
                    trackContributions
                });
                scopedSample = this.sanitizeFiniteSample(scopedSample, 'scope-sample', {
                    phase: 'scope-sample',
                    timeMs: sampleTimeMs,
                    scopeTrackId: this.scopeTrackId
                });

                outputChannel[sampleIndex] = mixedSample;
                this.scopeBuffer[this.scopeWriteIndex] = scopedSample * 5;
                this.scopeWriteIndex = (this.scopeWriteIndex + 1) % this.scopeBuffer.length;
                this.scopeSampleCounter += 1;
                if (this.scopeSampleCounter >= 2048) {
                    this.publishScopeSnapshot();
                    this.scopeSampleCounter = 0;
                }

                this.currentTimeMs += msPerSample;
            }

            this.publishVoiceStatusIfChanged();
            return true;
        } catch (error) {
            for (let channelIndex = 0; channelIndex < outputs[0].length; channelIndex++) {
                outputs[0][channelIndex].fill(0);
            }

            this.reportError(error, {
                phase: 'process',
                trackCount: this.trackStates.size,
                moduleCount: this.modules.size
            });

            return true;
        }
    }
}

registerProcessor('moth-synth-processor', MothSynthProcessor);