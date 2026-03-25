const moduleStates = new Map();
const inputConnections = new Map();
const scopeListeners = new Set();
const trackStates = new Map();

let audioContextRef = null;
let workletNodeRef = null;
let workletInitializationPromise = null;
let scopeTrackId = null;

function postToWorklet(message) {
    if (workletNodeRef) {
        workletNodeRef.port.postMessage(message);
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
    if (message.type === 'scope-data') {
        scopeListeners.forEach((listener) => listener(message.samples));
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
        const workletUrl = new URL('./moth-synth-worklet.js', import.meta.url);
        await audioContext.audioWorklet.addModule(workletUrl);

        workletNodeRef = new AudioWorkletNode(audioContext, 'moth-synth-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1]
        });
        workletNodeRef.port.onmessage = handleWorkletMessage;
        workletNodeRef.connect(audioContext.destination);
        syncStateToWorklet();

        return workletNodeRef;
    })();

    return workletInitializationPromise;
}

export function registerModule(moduleId, module) {
    moduleStates.set(moduleId, module);
    postToWorklet({ type: 'upsert-module', moduleId, module });
}

export function unregisterModule(moduleId) {
    moduleStates.delete(moduleId);
    const affectedDestinations = [];

    inputConnections.forEach((inputs, toModuleId) => {
        const nextInputs = Object.fromEntries(
            Object.entries(inputs).filter(([, fromModuleId]) => fromModuleId !== moduleId)
        );

        if (Object.keys(nextInputs).length !== Object.keys(inputs).length) {
            affectedDestinations.push({ toModuleId, inputNames: Object.keys(inputs) });
            if (Object.keys(nextInputs).length > 0) {
                inputConnections.set(toModuleId, nextInputs);
            } else {
                inputConnections.delete(toModuleId);
            }
        }
    });

    affectedDestinations.forEach(({ toModuleId, inputNames }) => {
        inputNames.forEach((inputName) => {
            postToWorklet({ type: 'disconnect', toModuleId, inputName });
        });
    });

    postToWorklet({ type: 'remove-module', moduleId });
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

export function setGateMonitoring() {
}

export function setKeyboardLatchMode() {
}

export function subscribeToScopeData(listener) {
    scopeListeners.add(listener);
    return () => {
        scopeListeners.delete(listener);
    };
}

export function clearAllModules() {
    moduleStates.clear();
    inputConnections.clear();
    trackStates.clear();
    scopeTrackId = null;
    postToWorklet({ type: 'clear-state' });
}
