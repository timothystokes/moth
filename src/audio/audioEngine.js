const moduleStates = new Map();
const inputConnections = new Map();
const scopeListeners = new Set();

let audioContextRef = null;
let workletNodeRef = null;
let workletInitializationPromise = null;
let gateMonitoringEnabled = false;
let keyboardLatchModeEnabled = false;

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
        gateMonitoringEnabled,
        keyboardLatchModeEnabled
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
    postToWorklet({ type: 'remove-module', moduleId });
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
    }

    postToWorklet({ type: 'disconnect', toModuleId, inputName });
}

export function noteOn(noteNumber, velocity) {
    postToWorklet({ type: 'note-on', noteNumber, velocity });
}

export function noteOff(noteNumber) {
    postToWorklet({ type: 'note-off', noteNumber });
}

export function setGateMonitoring(enabled) {
    gateMonitoringEnabled = enabled;
    postToWorklet({ type: 'set-gate-monitoring', enabled });
}

export function setKeyboardLatchMode(enabled) {
    keyboardLatchModeEnabled = enabled;
    postToWorklet({ type: 'set-keyboard-latch-mode', enabled });
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
    postToWorklet({ type: 'clear-state' });
}
