const MAX_VOICES = 4;
const VOICE_FREE = 'free';
const VOICE_ACTIVE = 'active';
const TIME_MIN = 0.001;
const TIME_MAX = 10;
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
        cv: 0,
        cvStart: 0,
        cvGlideStartMs: null,
        portamentoTime: 0
    };
}

function createTrackState(trackId, track = {}) {
    const polyphony = Math.min(16, Math.max(1, track.polyphony ?? MAX_VOICES));
    return {
        trackId,
        volume: track.volume ?? 0.8,
        mute: Boolean(track.mute),
        high: track.high ?? 0,
        mid: track.mid ?? 0,
        low: track.low ?? 0,
        pan: track.pan ?? 0,
        portamentoTime: track.portamento ?? 0,
        noteStack: [],
        lastMonoCv: 0,
        voiceAllocationOrder: [],   // voiceIds of ACTIVE voices, oldest key-press first
        voiceFreeOrder: [],         // voiceIds of FREE voices, oldest key-release first
        noteToVoiceMap: new Map(),
        voices: Array.from({ length: polyphony }, (_, index) => createVoice(trackId, index))
    };
}

class MothSynthProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.modules = new Map();
        this.moduleParams = new Map(); // stable mutable params objects — closures hold references to these
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
        this.moduleScopeBuffers = new Map();

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
        let activeVoices = 0;
        let processingVoices = 0;
        let capacityVoices = 0;

        this.trackStates.forEach((trackState, trackId) => {
            const outputRoute = this.getCompiledTrackOutputRoute(trackId);
            const outputSourceId = outputRoute?.sourceModuleId ?? null;
            const isVoiceDependent = outputSourceId ? this.isModuleVoiceDependent(outputSourceId) : false;
            let trackActiveVoices = 0;
            let trackProcessingVoices = 0;

            capacityVoices += trackState.voices.length;

            trackState.voices.forEach((voice) => {
                if (voice.state === VOICE_ACTIVE) {
                    trackActiveVoices += 1;
                }
            });

            if (!trackState.mute && outputSourceId) {
                trackProcessingVoices = isVoiceDependent ? trackState.voices.length : 1;
            }

            activeVoices += trackActiveVoices;
            processingVoices += trackProcessingVoices;

            perTrack.push({
                trackId,
                capacityVoices: trackState.voices.length,
                outputConnected: Boolean(outputSourceId),
                voiceDependent: isVoiceDependent,
                activeVoices: trackActiveVoices,
                processingVoices: trackProcessingVoices,
                muted: trackState.mute
            });
        });

        return {
            capacityVoices,
            activeVoices,
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
                    // Initialise or reset the mutable params object for this module
                    Object.assign(
                        this.moduleParams.get(message.moduleId) ?? (() => {
                            const p = {}; this.moduleParams.set(message.moduleId, p); return p;
                        })(),
                        message.module.params ?? {}
                    );
                    this.rebuildCompiledRouting();
                    this.invalidateGraphAnalysisCache();
                    break;
                case 'update-params': {
                    // Hot-path: mutate the stable params object in-place — no recompile needed
                    const mp = this.moduleParams.get(message.moduleId);
                    if (mp) Object.assign(mp, message.params);
                    break;
                }
                case 'remove-module':
                    this.modules.delete(message.moduleId);
                    this.moduleParams.delete(message.moduleId);
                    this.moduleScopeBuffers.delete(message.moduleId);
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
                            voice.state = VOICE_FREE;
                        });
                        trackState.voiceAllocationOrder = [];
                        trackState.voiceFreeOrder = trackState.voices.map(v => v.voiceId);
                    });
                    break;
                case 'clear-state':
                    this.modules.clear();
                    this.moduleParams.clear();
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
        existing.high = track.high ?? existing.high ?? 0;
        existing.mid = track.mid ?? existing.mid ?? 0;
        existing.low = track.low ?? existing.low ?? 0;
        existing.pan = track.pan ?? existing.pan ?? 0;

        const desiredPoly = Math.min(16, Math.max(1, track.polyphony ?? existing.voices.length));
        if (existing.voices.length !== desiredPoly) {
            existing.noteStack = [];
            existing.voiceAllocationOrder = [];
            existing.voiceFreeOrder = [];
            // Release any voices being removed
            for (let i = desiredPoly; i < existing.voices.length; i++) {
                const v = existing.voices[i];
                if (v.state !== VOICE_FREE) {
                    this.removeVoiceMapping(existing, v.noteNumber, v.voiceId);
                    v.gate = 0;
                    v.state = VOICE_FREE;
                }
            }
            // Resize: trim or extend with fresh voices
            existing.voices = [
                ...existing.voices.slice(0, desiredPoly),
                ...Array.from({ length: Math.max(0, desiredPoly - existing.voices.length) },
                    (_, i) => createVoice(trackId, existing.voices.length + i))
            ];
        }

        existing.portamentoTime = track.portamento ?? existing.portamentoTime ?? 0;

        this.trackStates.set(trackId, existing);
    }

    removeTrack(trackId) {
        this.trackStates.delete(trackId);
        const trackPrefix = `${trackId}:`;

        Array.from(this.modules.keys())
            .filter((moduleId) => moduleId.startsWith(trackPrefix))
            .forEach((moduleId) => {
                this.modules.delete(moduleId);
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
        this.reportedRuntimeIssues.clear();
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
        voice.cvStart = 0;
        voice.cvGlideStartMs = null;
        voice.portamentoTime = 0;
    }

    claimVoice(trackState) {
        const { voices, voiceFreeOrder, voiceAllocationOrder } = trackState;

        // Prefer oldest freed voice (had most time for envelope tail)
        if (voiceFreeOrder.length > 0) {
            const oldestFreeId = voiceFreeOrder[0];
            const v = voices.find(v => v.voiceId === oldestFreeId);
            if (v) return v;
        }

        // Fallback: any free voice not yet tracked (e.g. never used)
        const freeVoice = voices.find(v => v.state === VOICE_FREE);
        if (freeVoice) return freeVoice;

        // All keys held — steal oldest active (FIFO)
        const oldestActiveId = voiceAllocationOrder[0];
        return voices.find(v => v.voiceId === oldestActiveId) ?? voices[0];
    }

    getGlidedCv(voice) {
        const { cv, cvStart, cvGlideStartMs, portamentoTime } = voice;
        if (!portamentoTime || cvGlideStartMs === null) return cv;
        const elapsed = Math.max(0, (this.currentTimeMs - cvGlideStartMs) / 1000);
        if (elapsed >= portamentoTime) return cv;
        return cvStart + (cv - cvStart) * (elapsed / portamentoTime);
    }

    // Set up a CV glide on a voice toward targetCv, starting from the voice's current
    // interpolated position (or lastMonoCv if the voice is free/silent).
    setupGlide(voice, targetCv, trackState) {
        const portamentoTime = trackState.portamentoTime ?? 0;
        const fromCv = (voice.state !== VOICE_FREE)
            ? this.getGlidedCv(voice)
            : trackState.lastMonoCv;

        trackState.lastMonoCv = targetCv;
        voice.cv = targetCv;

        if (portamentoTime > 0) {
            voice.cvStart = fromCv;
            voice.cvGlideStartMs = this.currentTimeMs;
            voice.portamentoTime = portamentoTime;
        } else {
            voice.cvStart = targetCv;
            voice.cvGlideStartMs = null;
            voice.portamentoTime = 0;
        }
    }

    allocateVoice(trackId, noteNumber, velocity) {
        const trackState = this.getTrackState(trackId);
        if (!trackState) return;

        const velocityV = Math.max(0, Math.min(1, Number.isFinite(velocity) ? velocity : 1)) * GATE_HIGH_VOLTAGE;
        const gateV = velocityV > 0 ? GATE_HIGH_VOLTAGE : 0;
        const targetCv = (noteNumber - 69) / 12;

        // Mono mode: note stacking + optional portamento
        if (trackState.voices.length === 1) {
            const voice = trackState.voices[0];

            trackState.noteStack = trackState.noteStack.filter(n => n !== noteNumber);
            trackState.noteStack.push(noteNumber);

            this.removeVoiceMapping(trackState, voice.noteNumber, voice.voiceId);
            this.addVoiceMapping(trackState, noteNumber, voice.voiceId);
            voice.noteNumber = noteNumber;
            voice.velocity = velocityV;

            this.setupGlide(voice, targetCv, trackState);

            if (voice.state !== VOICE_ACTIVE) {
                voice.gate = gateV;
                voice.state = VOICE_ACTIVE;
            }
            return;
        }

        // Poly mode: FIFO voice allocation
        const targetVoice = this.claimVoice(trackState);
        const voiceId = targetVoice.voiceId;

        // Remove from whichever order list it's currently in
        trackState.voiceFreeOrder = trackState.voiceFreeOrder.filter(id => id !== voiceId);
        trackState.voiceAllocationOrder = trackState.voiceAllocationOrder.filter(id => id !== voiceId);

        this.clearVoice(trackState, targetVoice);
        targetVoice.state = VOICE_ACTIVE;
        targetVoice.noteNumber = noteNumber;
        targetVoice.velocity = velocityV;
        targetVoice.gate = gateV;
        targetVoice.cv = targetCv;
        this.addVoiceMapping(trackState, noteNumber, voiceId);

        // Track as newest active voice
        trackState.voiceAllocationOrder.push(voiceId);
    }

    releaseVoice(trackId, noteNumber) {
        const trackState = this.getTrackState(trackId);
        if (!trackState) return;

        // Mono mode: pop from stack, return to previous held key if any
        if (trackState.voices.length === 1) {
            const voice = trackState.voices[0];
            trackState.noteStack = trackState.noteStack.filter(n => n !== noteNumber);
            this.removeVoiceMapping(trackState, noteNumber, voice.voiceId);

            if (trackState.noteStack.length > 0) {
                const prevNote = trackState.noteStack[trackState.noteStack.length - 1];
                this.addVoiceMapping(trackState, prevNote, voice.voiceId);
                voice.noteNumber = prevNote;
                this.setupGlide(voice, (prevNote - 69) / 12, trackState);
            } else {
                trackState.lastMonoCv = this.getGlidedCv(voice);
                voice.gate = 0;
                voice.state = VOICE_FREE;
            }
            return;
        }

        // Poly mode: key-up frees the voice immediately for reallocation
        const voiceIds = trackState.noteToVoiceMap.get(noteNumber);
        const voiceId = voiceIds?.[voiceIds.length - 1];
        if (!voiceId) return;

        const voice = trackState.voices.find((candidate) => candidate.voiceId === voiceId);
        if (!voice || voice.state === VOICE_FREE) {
            this.removeVoiceMapping(trackState, noteNumber, voiceId);
            return;
        }

        this.removeVoiceMapping(trackState, noteNumber, voiceId);
        voice.gate = 0;
        voice.state = VOICE_FREE;
        trackState.voiceAllocationOrder = trackState.voiceAllocationOrder.filter(id => id !== voiceId);
        trackState.voiceFreeOrder.push(voiceId);
    }

    getActiveVoices(trackState) {
        return trackState.voices.filter((voice) => voice.state === VOICE_ACTIVE);
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
            case 'keyboard-velocity':
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
                isVoiceDependent = ['input-a', 'input-b']
                    .some((inputName) => this.isInputVoiceDependent(moduleId, inputName, visited));
                break;
            case 'vca':
                isVoiceDependent = ['audio-input', 'gain-input']
                    .some((inputName) => this.isInputVoiceDependent(moduleId, inputName, visited));
                break;
            case 'mfx':
                isVoiceDependent = ['audio-input', 'time-input', 'feedback-input']
                    .some((inputName) => this.isInputVoiceDependent(moduleId, inputName, visited));
                break;
            case 'multi':
                isVoiceDependent = this.isInputVoiceDependent(moduleId, 'signal-input', visited);
                break;
            case 'scope':
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
        const params = this.moduleParams.get(moduleId) ?? module.params ?? {};
        switch (module.type) {
            case 'oscillator':
                return this.createOscillatorFactory(moduleId, params, activeStack);
            case 'filter':
                return this.createFilterFactory(moduleId, params, activeStack);
            case 'envelope':
                return this.createEnvelopeFactory(moduleId, params, activeStack);
            case 'random':
                return this.createRandomFactory(moduleId, params, activeStack);
            case 'mixer':
                return this.createMixerFactory(moduleId, params, activeStack);
            case 'vca':
                return this.createVCAFactory(moduleId, params, activeStack);
            case 'mfx':
                return this.createMFXFactory(moduleId, params, activeStack);
            case 'multi': {
                const signalRead = this.createInputReader(moduleId, 'signal-input', activeStack);
                return (timeMs, laneContext) => (signalRead ? signalRead(timeMs, laneContext) : 0);
            }
            case 'scope': {
                const signalRead = this.createInputReader(moduleId, 'signal-input', activeStack);
                if (!this.moduleScopeBuffers.has(moduleId)) {
                    this.moduleScopeBuffers.set(moduleId, {
                        buffer: new Float32Array(4096),
                        writeIndex: 0,
                        sampleCounter: 0,
                        frameAccum: 0,
                        lastFrameTimeMs: -1,
                    });
                }
                const scopeState = this.moduleScopeBuffers.get(moduleId);
                return (timeMs, laneContext) => {
                    const value = signalRead ? signalRead(timeMs, laneContext) : 0;

                    // New audio frame — commit previous frame's summed sample to buffer
                    if (timeMs !== scopeState.lastFrameTimeMs) {
                        if (scopeState.lastFrameTimeMs >= 0) {
                            scopeState.buffer[scopeState.writeIndex] = scopeState.frameAccum;
                            scopeState.writeIndex = (scopeState.writeIndex + 1) % scopeState.buffer.length;
                            scopeState.sampleCounter += 1;
                            if (scopeState.sampleCounter >= 2048) {
                                this.publishModuleScopeSnapshot(moduleId, scopeState);
                                scopeState.sampleCounter = 0;
                            }
                        }
                        scopeState.frameAccum = 0;
                        scopeState.lastFrameTimeMs = timeMs;
                    }

                    // Sum all voices for this frame — produces the combined waveform
                    scopeState.frameAccum += value;

                    // Pass through unchanged per voice per route
                    return value;
                };
            }
            case 'keyboard-cv':
                return (timeMs, laneContext) => {
                    if (!laneContext) return 0;
                    const { cv, cvStart, cvGlideStartMs, portamentoTime } = laneContext;
                    if (!portamentoTime || cvGlideStartMs === null) return cv ?? 0;
                    const elapsed = Math.max(0, (timeMs - cvGlideStartMs) / 1000);
                    if (elapsed >= portamentoTime) return cv ?? 0;
                    return (cvStart ?? cv ?? 0) + ((cv ?? 0) - (cvStart ?? cv ?? 0)) * (elapsed / portamentoTime);
                };
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
                // Slider sets max amplitude; input signal (0–5V full scale) scales up to that max
                finalAmp = amplitude * Math.max(0, Math.min(1, modVoltage / GATE_HIGH_VOLTAGE));
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
                    releaseStartValue: 0,
                    attackStartValue: 0
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
                envState.attackStartValue = envState.value; // start from current level, not 0
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
                    const start = envState.attackStartValue ?? 0;
                    envState.value = start + (1 - start) * progress;
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
                finalRate = Math.max(0.1, Math.min(8000, finalRate));
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

        return (timeMs, laneContext) => {
            const signalA = inputARead ? inputARead(timeMs, laneContext) : 0;
            const signalB = inputBRead ? inputBRead(timeMs, laneContext) : 0;
            return signalA * 0.5 + signalB * 0.5;
        };
    }

    createVCAFactory(moduleId, params, activeStack) {
        const audioRead = this.createInputReader(moduleId, 'audio-input', activeStack);
        const gainRead = this.createInputReader(moduleId, 'gain-input', activeStack);

        return (timeMs, laneContext) => {
            const input = audioRead ? audioRead(timeMs, laneContext) : 0;
            let finalGain = params.gain ?? 1;
            if (gainRead) {
                finalGain = Math.max(0, Math.min(2, finalGain + gainRead(timeMs, laneContext) / 5));
            }
            const polarity = params.invert ? -1 : 1;
            return input * finalGain * polarity;
        };
    }

    createMFXFactory(moduleId, params, activeStack) {
        const audioRead    = this.createInputReader(moduleId, 'audio-input',    activeStack);
        const timeRead     = this.createInputReader(moduleId, 'time-input',     activeStack);
        const feedbackRead = this.createInputReader(moduleId, 'feedback-input', activeStack);

        // ── Delay state ──────────────────────────────────────────────────────
        const maxDelaySamples = Math.ceil(sampleRate * 2);
        const delayStateMap = new Map();

        // ── Reverb state (Freeverb-style: 4 comb + 2 all-pass per voice) ────
        // Comb filter delay lengths (samples at 44100; scaled to actual sampleRate)
        const COMB_DELAYS   = [1557, 1617, 1491, 1422].map(d => Math.round(d * sampleRate / 44100));
        const ALLPASS_DELAYS = [225, 556].map(d => Math.round(d * sampleRate / 44100));
        const reverbStateMap = new Map();

        const makeReverbState = () => ({
            combs: COMB_DELAYS.map(len => ({
                buf: new Float32Array(len), idx: 0, filter: 0
            })),
            allpasses: ALLPASS_DELAYS.map(len => ({
                buf: new Float32Array(len), idx: 0
            }))
        });

        return (timeMs, laneContext) => {
            const voiceId = laneContext?.voiceId ?? 'global';
            const input = audioRead ? audioRead(timeMs, laneContext) : 0;
            const mix = params.mix ?? 0.5;
            const fxType = params.fxType ?? 'delay';

            if (fxType === 'delay') {
                // ── DELAY ──────────────────────────────────────────────────
                let state = delayStateMap.get(voiceId);
                if (!state) {
                    state = { buffer: new Float32Array(maxDelaySamples), writeIndex: 0 };
                    delayStateMap.set(voiceId, state);
                }

                let delayMs = params.time ?? 250;
                if (timeRead) {
                    delayMs = Math.max(1, Math.min(2000, delayMs + timeRead(timeMs, laneContext) * 200));
                }
                const delaySamples = Math.max(1, Math.min(maxDelaySamples - 1, Math.round(delayMs / 1000 * sampleRate)));

                let feedback = params.feedback ?? 0.4;
                if (feedbackRead) {
                    feedback = Math.max(0, Math.min(0.8, feedback + feedbackRead(timeMs, laneContext) / 5));
                }

                const readIndex = (state.writeIndex - delaySamples + maxDelaySamples) % maxDelaySamples;
                const delayed = state.buffer[readIndex];
                state.buffer[state.writeIndex] = input + delayed * feedback;
                state.writeIndex = (state.writeIndex + 1) % maxDelaySamples;

                return input * (1 - mix) + delayed * mix;

            } else {
                // ── REVERB (Freeverb-style) ────────────────────────────────
                let rv = reverbStateMap.get(voiceId);
                if (!rv) { rv = makeReverbState(); reverbStateMap.set(voiceId, rv); }

                const roomSize     = Math.max(0, Math.min(1, params.time ?? 0.5));
                const combFeedback = 0.7 + roomSize * 0.2;                         // 0.7–0.9
                const rawFeedback  = Math.max(0, Math.min(0.8, params.feedback ?? 0.4));
                const damping      = 1 - rawFeedback * 0.9;                        // 0.28–1.0

                // 4 comb filters in parallel
                let reverbOut = 0;
                for (const comb of rv.combs) {
                    const out = comb.buf[comb.idx];
                    comb.filter = out * (1 - damping) + comb.filter * damping; // low-pass
                    comb.buf[comb.idx] = input + comb.filter * combFeedback;
                    comb.idx = (comb.idx + 1) % comb.buf.length;
                    reverbOut += out;
                }
                reverbOut *= 0.25; // normalise comb sum

                // 2 all-pass filters in series
                for (const ap of rv.allpasses) {
                    const bufOut = ap.buf[ap.idx];
                    ap.buf[ap.idx] = reverbOut + bufOut * 0.5;
                    reverbOut = bufOut - reverbOut;
                    ap.idx = (ap.idx + 1) % ap.buf.length;
                }

                return input * (1 - mix) + reverbOut * mix;
            }
        };
    }

    buildScopeSnapshot(buffer, writeIndex, scale = 1) {
        const snapshotLength = 360;
        const bufferSize = buffer.length;
        let triggerIndex = -1;

        for (let searchOffset = snapshotLength; searchOffset < Math.min(1000, bufferSize - 3); searchOffset++) {
            const index = (writeIndex - searchOffset + bufferSize) % bufferSize;
            const prev3 = (index - 3 + bufferSize) % bufferSize;
            const prev2 = (index - 2 + bufferSize) % bufferSize;
            const prev1 = (index - 1 + bufferSize) % bufferSize;
            const next1 = (index + 1) % bufferSize;
            const next2 = (index + 2) % bufferSize;

            const prev3Below = buffer[prev3] <= 0 && buffer[prev2] <= 0 && buffer[prev1] <= 0;
            const next3Above = buffer[index] >= 0 && buffer[next1] >= 0 && buffer[next2] >= 0;

            if (prev3Below && next3Above) {
                triggerIndex = index;
                break;
            }
        }

        if (triggerIndex === -1) {
            triggerIndex = (writeIndex - snapshotLength + bufferSize) % bufferSize;
        }

        const snapshot = new Float32Array(snapshotLength);
        for (let i = 0; i < snapshotLength; i++) {
            const v = buffer[(triggerIndex + i) % bufferSize];
            snapshot[i] = Number.isFinite(v) ? v * scale : 0;
        }
        return snapshot;
    }

    publishScopeSnapshot() {
        try {
            const snapshot = this.buildScopeSnapshot(this.scopeBuffer, this.scopeWriteIndex, 2);
            this.port.postMessage({ type: 'scope-data', samples: snapshot }, [snapshot.buffer]);
        } catch (error) {
            this.reportRuntimeIssueOnce('scope-publish', 'Failed to publish scope snapshot.', {
                phase: 'publish-scope-snapshot',
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }

    publishModuleScopeSnapshot(moduleId, scopeState) {
        try {
            const snapshot = this.buildScopeSnapshot(scopeState.buffer, scopeState.writeIndex);
            this.port.postMessage({ type: 'module-scope-data', moduleId, samples: snapshot }, [snapshot.buffer]);
        } catch (error) {
            this.reportRuntimeIssueOnce(`module-scope-publish:${moduleId}`, `Failed to publish module scope snapshot for ${moduleId}.`, {
                phase: 'publish-module-scope-snapshot',
                moduleId,
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }

    process(_inputs, outputs) {
        try {
            const outputChannelL = outputs[0][0];
            const outputChannelR = outputs[0][1];
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

            for (let sampleIndex = 0; sampleIndex < outputChannelL.length; sampleIndex++) {
                this.frameCache.clear();
                const sampleTimeMs = this.currentTimeMs;
                let mixedL = 0;
                let mixedR = 0;
                let scopedSample = 0;
                const topTrackIds = [null, null, null, null];
                const topModuleIds = [null, null, null, null];
                const topSamples = [0, 0, 0, 0];

                for (const plan of trackRenderPlans) {
                    const { trackId, trackState, outputSourceId, outputRead, requiresPerVoiceMix, volume, isScopeTrack } = plan;
                    let trackSample = 0;

                    if (requiresPerVoiceMix) {
                        for (const voice of trackState.voices) {
                            const voiceSignal = outputRead(sampleTimeMs, voice);
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

                            trackSample += voiceSignal / 10;
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

                    // Apply 3-band shelving EQ (high/mid/low in dB) using simple 1-pole IIR shelves
                    const { high, mid, low } = trackState;
                    if (high !== 0 || mid !== 0 || low !== 0) {
                        if (!trackState.eqState) {
                            trackState.eqState = { lp1: 0, lp2: 0, hp1: 0 };
                        }
                        const eq = trackState.eqState;
                        const sr = sampleRate;
                        // Low shelf: 1-pole LP at 250Hz
                        const lowAlpha = 1 - Math.exp(-2 * Math.PI * 250 / sr);
                        eq.lp1 += lowAlpha * (trackSample - eq.lp1);
                        const lowBand = eq.lp1;
                        // High shelf: HP = signal - LP at 4000Hz
                        const highAlpha = 1 - Math.exp(-2 * Math.PI * 4000 / sr);
                        eq.hp1 += highAlpha * (trackSample - eq.hp1);
                        const highBand = trackSample - eq.hp1;
                        // Mid = signal - low - high
                        const midBand = trackSample - lowBand - highBand;
                        const lowGain = Math.pow(10, low / 20);
                        const midGain = Math.pow(10, mid / 20);
                        const highGain = Math.pow(10, high / 20);
                        trackSample = lowBand * lowGain + midBand * midGain + highBand * highGain;
                    }

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

                    // Constant-power pan law: pan in [-1, 1]
                    const panAngle = ((trackState.pan ?? 0) + 1) * 0.25 * Math.PI; // 0..π/2
                    const panL = Math.cos(panAngle);
                    const panR = Math.sin(panAngle);
                    mixedL += trackSample * panL;
                    mixedR += trackSample * panR;

                    if (isScopeTrack) {
                        scopedSample = trackSample;
                    }
                }

                if (activeTrackCount > 1) {
                    const norm = 1 / Math.sqrt(activeTrackCount);
                    mixedL *= norm;
                    mixedR *= norm;
                }

                const mixedSample = (mixedL + mixedR) * 0.5; // mono sum for clipping/diagnostic check
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

                mixedL = this.sanitizeSample(mixedL, 'mixed-sample', {
                    phase: 'mixed-sample',
                    timeMs: sampleTimeMs,
                    activeTrackCount,
                    trackCount: this.trackStates.size,
                    trackContributions
                });
                mixedR = this.sanitizeSample(mixedR, 'mixed-sample', {
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

                outputChannelL[sampleIndex] = mixedL;
                outputChannelR[sampleIndex] = mixedR;
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