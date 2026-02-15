// Pure functional audio engine with polyphonic voice support
// Direct function reference architecture: modules hold direct references to input functions
// Now supports per-voice processing with cv/gate cascading

// Store output functions for each module
const moduleOutputFunctions = new Map();
// Store input function references: moduleId -> { inputName: inputFunction }
const moduleInputFunctions = new Map();
// Cache outputs per time frame AND per voice to avoid recalculation
let currentTime = null;
const frameCache = new Map(); // Map<`${time}-${voiceId}-${moduleId}`, value>

// Register a module's processing function
// processorFn signature: (time, voiceContext, inputFns) => outputValue
// voiceContext = { cv, gate, velocity, voiceId }
// inputFns is an object like { 'audio-input': fn, 'amp-input': fn }
// where each fn is called as fn(time, voiceContext) to get the input value
export function registerModule(moduleId, processorFn) {
    // Create output function for this module
    const outputFn = (time, voiceContext) => {
        // Create cache key that includes voice information
        const cacheKey = `${time}-${voiceContext?.voiceId || 'global'}-${moduleId}`;
        
        // Clear cache when time advances
        if (time !== currentTime) {
            currentTime = time;
            frameCache.clear();
        }
        
        // Return cached value if available
        if (frameCache.has(cacheKey)) {
            return frameCache.get(cacheKey);
        }
        
        // Get input functions
        const inputFns = moduleInputFunctions.get(moduleId) || {};
        
        // Wrap input functions to pass voiceContext
        const wrappedInputFns = {};
        for (const [inputName, inputFn] of Object.entries(inputFns)) {
            wrappedInputFns[inputName] = (t, vc) => inputFn(t, vc || voiceContext);
        }
        
        // Process this module - it calls input functions which cascade backward
        const output = processorFn(time, voiceContext, wrappedInputFns);
        
        // Cache the result
        frameCache.set(cacheKey, output);
        
        return output;
    };
    
    moduleOutputFunctions.set(moduleId, outputFn);
}

// Unregister a module
export function unregisterModule(moduleId) {
    moduleOutputFunctions.delete(moduleId);
    // Note: we don't delete moduleInputFunctions here because connections should persist
    // across module re-registrations (e.g., when parameters change)
}

// Connect source module's output directly to destination module's input
// This creates a wrapper function that always looks up the current output function
export function connectModules(fromModuleId, toModuleId, inputName) {
    if (!moduleInputFunctions.has(toModuleId)) {
        moduleInputFunctions.set(toModuleId, {});
    }
    
    // Store a wrapper function that looks up the current output function
    // This allows modules to re-register with updated parameters
    const wrapperFn = (time, voiceContext) => {
        const sourceFn = moduleOutputFunctions.get(fromModuleId);
        return sourceFn ? sourceFn(time, voiceContext) : 0;
    };
    
    moduleInputFunctions.get(toModuleId)[inputName] = wrapperFn;
}

// Disconnect a specific input on a module
export function disconnectInput(toModuleId, inputName) {
    const inputs = moduleInputFunctions.get(toModuleId);
    if (inputs) {
        delete inputs[inputName];
    }
}

// Get a module's output function for voice processing
export function getModuleOutputFunction(moduleId) {
    return moduleOutputFunctions.get(moduleId);
}

// Clear all modules (for cleanup)
export function clearAllModules() {
    moduleProcessors.clear();
    moduleOutputs.clear();
}
