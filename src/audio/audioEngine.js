const moduleStates = new Map();
const inputConnections = new Map();
const moduleScopeListeners = new Map();
const trackStates = new Map();
const audioErrorListeners = new Set();
const audioDiagnosticListeners = new Set();
const voiceStatusListeners = new Set();

let audioContextRef = null;
let workletNodeRef = null;
let workletInitializationPromise = null;
let scopeTrackId = null;

function resetWorkletNode() {
    if (workletNodeRef) {
        try {
            workletNodeRef.port.onmessage = null;
            workletNodeRef.port.onmessageerror = null;
            workletNodeRef.onprocessorerror = null;
            workletNodeRef.disconnect();
        } catch (error) {
            console.error('Failed to reset worklet node cleanly:', error);
        }
    }

    workletNodeRef = null;
    workletInitializationPromise = null;
}

function emitAudioEngineError(error) {
    audioErrorListeners.forEach((listener) => listener(error));
}

function emitAudioEngineDiagnostic(diagnostic) {
    audioDiagnosticListeners.forEach((listener) => listener(diagnostic));
}

function emitVoiceStatus(voiceStatus) {
    voiceStatusListeners.forEach((listener) => listener(voiceStatus));
}

function postToWorklet(message, transfer) {
    if (workletNodeRef) {
        if (transfer) {
            workletNodeRef.port.postMessage(message, transfer);
        } else {
            workletNodeRef.port.postMessage(message);
        }
    }
}

function serializeModules() {
    return Array.from(moduleStates.entries()).map(([moduleId, module]) => ({ moduleId, module }));
}

function serializeConnections() {
    return Array.from(inputConnections.entries()).flatMap(([toModuleId, inputs]) =>
        Object.entries(inputs).map(([inputName, fromModuleId]) => ({ fromModuleId, toModuleId, inputName }))
    );
}

function serializeTracks() {
    return Array.from(trackStates.entries()).map(([trackId, track]) => ({ trackId, track }));
}

function handleWorkletMessage(event) {
    const message = event.data;
    if (message.type === 'module-scope-data') {
        const listeners = moduleScopeListeners.get(message.moduleId);
        if (listeners) listeners.forEach((listener) => listener(message.samples));
        return;
    }

    if (message.type === 'worklet-error') {
        console.error('Moth synth worklet error:', message.error);
        emitAudioEngineError(message.error);
        return;
    }

    if (message.type === 'worklet-diagnostic') {
        console.warn('Moth synth worklet diagnostic:', message.diagnostic);
        emitAudioEngineDiagnostic(message.diagnostic);
        return;
    }

    if (message.type === 'voice-status') {
        emitVoiceStatus(message.voiceStatus);
    }
}

function syncStateToWorklet() {
    postToWorklet({
        type: 'sync-state',
        modules: serializeModules(),
        connections: serializeConnections(),
        tracks: serializeTracks(),
        scopeTrackId
    });
}

export async function initializeAudioEngine(audioContext) {
    if (workletNodeRef && audioContextRef === audioContext) {
        return workletNodeRef;
    }

    if (workletInitializationPromise && audioContextRef === audioContext) {
        return workletInitializationPromise;
    }

    audioContextRef = audioContext;
    workletInitializationPromise = (async () => {
        try {
            const workletUrl = new URL('./moth-synth-worklet.js', import.meta.url);
            await audioContext.audioWorklet.addModule(workletUrl);

            const node = new AudioWorkletNode(audioContext, 'moth-synth-processor', {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [2]
            });
            node.port.onmessage = handleWorkletMessage;
            node.port.onmessageerror = (event) => {
                console.error('Moth synth worklet port message error:', event);
                emitAudioEngineError({
                    name: 'WorkletPortMessageError',
                    message: 'Worklet port message error.',
                    context: { phase: 'port-message-error' }
                });
            };
            node.onprocessorerror = (event) => {
                console.error('Moth synth worklet processor crashed:', event);
                emitAudioEngineError({
                    name: 'WorkletProcessorCrash',
                    message: 'Audio worklet processor crashed.',
                    context: { phase: 'processor-crash' }
                });
                resetWorkletNode();
            };
            node.connect(audioContext.destination);
            workletNodeRef = node;
            syncStateToWorklet();

            return node;
        } catch (error) {
            const normalizedError = error instanceof Error
                ? {
                    name: error.name,
                    message: error.message,
                    stack: error.stack ?? null,
                    context: { phase: 'initialize-audio-engine' }
                }
                : {
                    name: 'AudioEngineInitializationError',
                    message: String(error),
                    stack: null,
                    context: { phase: 'initialize-audio-engine' }
                };

            console.error('Failed to initialize audio engine:', normalizedError);
            emitAudioEngineError(normalizedError);
            resetWorkletNode();
            throw error;
        }
    })();

    return workletInitializationPromise;
}

export function registerModule(moduleId, module) {
    moduleStates.set(moduleId, module);
    postToWorklet({ type: 'upsert-module', moduleId, module });
}

export function updateModuleParams(moduleId, params) {
    const existing = moduleStates.get(moduleId);
    if (existing) moduleStates.set(moduleId, { ...existing, params: { ...existing.params, ...params } });
    postToWorklet({ type: 'update-params', moduleId, params });
}

export function loadSamplerSample(moduleId, sample, sampleRate, recordedFrequency) {
    const sampleBuffer = sample instanceof Float32Array ? sample : new Float32Array(sample ?? []);
    postToWorklet({
        type: 'sampler-sample',
        moduleId,
        sample: sampleBuffer,
        sampleRate,
        recordedFrequency
    }, [sampleBuffer.buffer]);
}

export function triggerSampler(moduleId) {
    postToWorklet({ type: 'sampler-trigger', moduleId });
}

export function getModuleState(moduleId) {
    return moduleStates.get(moduleId) ?? null;
}

export function connectModules(fromModuleId, toModuleId, inputName) {
    if (!inputConnections.has(toModuleId)) {
        inputConnections.set(toModuleId, {});
    }

    inputConnections.get(toModuleId)[inputName] = fromModuleId;
    postToWorklet({ type: 'connect', fromModuleId, toModuleId, inputName });
}

export function disconnectInput(toModuleId, inputName) {
    const inputs = inputConnections.get(toModuleId);
    if (inputs) {
        delete inputs[inputName];
        if (Object.keys(inputs).length === 0) {
            inputConnections.delete(toModuleId);
        }
    }

    postToWorklet({ type: 'disconnect', toModuleId, inputName });
}

export function upsertTrack(trackId, track) {
    trackStates.set(trackId, track);
    postToWorklet({ type: 'upsert-track', trackId, track });
}

export function removeTrack(trackId) {
    const trackPrefix = `${trackId}:`;
    trackStates.delete(trackId);

    Array.from(moduleStates.keys())
        .filter((moduleId) => moduleId.startsWith(trackPrefix))
        .forEach((moduleId) => {
            moduleStates.delete(moduleId);
        });

    inputConnections.forEach((inputs, toModuleId) => {
        if (toModuleId.startsWith(trackPrefix)) {
            inputConnections.delete(toModuleId);
            return;
        }

        const nextInputs = Object.fromEntries(
            Object.entries(inputs).filter(([, fromModuleId]) => !fromModuleId.startsWith(trackPrefix))
        );

        if (Object.keys(nextInputs).length > 0) {
            inputConnections.set(toModuleId, nextInputs);
        } else {
            inputConnections.delete(toModuleId);
        }
    });

    if (scopeTrackId === trackId) {
        scopeTrackId = null;
    }

    postToWorklet({ type: 'remove-track', trackId });
}

export function setScopeTrack(trackId) {
    scopeTrackId = trackId ?? null;
    postToWorklet({ type: 'set-scope-track', trackId: scopeTrackId });
}

export function noteOn(trackId, noteNumber, velocity) {
    if (!trackId) {
        return;
    }

    postToWorklet({ type: 'note-on', trackId, noteNumber, velocity });
}

export function noteOff(trackId, noteNumber) {
    if (trackId === null && noteNumber === -1) {
        postToWorklet({ type: 'all-notes-off' });
        return;
    }

    if (!trackId) {
        return;
    }

    postToWorklet({ type: 'note-off', trackId, noteNumber });
}

export function subscribeToModuleScopeData(moduleId, listener) {
    if (!moduleScopeListeners.has(moduleId)) {
        moduleScopeListeners.set(moduleId, new Set());
    }
    moduleScopeListeners.get(moduleId).add(listener);
    return () => {
        const set = moduleScopeListeners.get(moduleId);
        if (set) {
            set.delete(listener);
            if (set.size === 0) moduleScopeListeners.delete(moduleId);
        }
    };
}

export function subscribeToAudioEngineErrors(listener) {
    audioErrorListeners.add(listener);
    return () => {
        audioErrorListeners.delete(listener);
    };
}

export function subscribeToAudioEngineDiagnostics(listener) {
    audioDiagnosticListeners.add(listener);
    return () => {
        audioDiagnosticListeners.delete(listener);
    };
}

export function subscribeToVoiceStatus(listener) {
    voiceStatusListeners.add(listener);
    return () => {
        voiceStatusListeners.delete(listener);
    };
}

export function clearAllModules() {
    moduleStates.clear();
    inputConnections.clear();
    trackStates.clear();
    scopeTrackId = null;
    postToWorklet({ type: 'clear-state' });
}
