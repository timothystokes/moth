// Pure functional audio engine
// Direct function reference architecture: modules hold direct references to input functions

// Store output functions for each module
const moduleOutputFunctions = new Map();
// Store input function references: moduleId -> { inputName: inputFunction }
const moduleInputFunctions = new Map();
// Cache outputs per time frame to avoid recalculation
let currentTime = null;
const frameCache = new Map();

// Register a module's processing function
// processorFn signature: (time, inputFns) => outputValue
// inputFns is an object like { 'audio-input': fn, 'amp-input': fn }
// where each fn is called as fn(time) to get the input value
export function registerModule(moduleId, processorFn) {
    // Create output function for this module
    const outputFn = (time) => {
        // Clear cache when time advances
        if (time !== currentTime) {
            currentTime = time;
            frameCache.clear();
        }
        
        // Return cached value if available
        if (frameCache.has(moduleId)) {
            return frameCache.get(moduleId);
        }
        
        // Get input functions
        const inputFns = moduleInputFunctions.get(moduleId) || {};
        
        // Process this module - it calls input functions which cascade backward
        const output = processorFn(time, inputFns);
        
        // Cache the result
        frameCache.set(moduleId, output);
        
        return output;
    };
    
    moduleOutputFunctions.set(moduleId, outputFn);
}

// Unregister a module
export function unregisterModule(moduleId) {
    moduleOutputFunctions.delete(moduleId);
    moduleInputFunctions.delete(moduleId);
}

// Connect source module's output directly to destination module's input
// This creates a wrapper function that always looks up the current output function
export function connectModules(fromModuleId, toModuleId, inputName) {
    if (!moduleInputFunctions.has(toModuleId)) {
        moduleInputFunctions.set(toModuleId, {});
    }
    
    // Store a wrapper function that looks up the current output function
    // This allows modules to re-register with updated parameters
    const wrapperFn = (time) => {
        const sourceFn = moduleOutputFunctions.get(fromModuleId);
        return sourceFn ? sourceFn(time) : 0;
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

// Get a module's input function (for the Amplifier to call)
export function getInputFunction(moduleId, inputName) {
    const inputs = moduleInputFunctions.get(moduleId);
    return inputs ? inputs[inputName] : null;
}

// Clear all modules (for cleanup)
export function clearAllModules() {
    moduleProcessors.clear();
    moduleOutputs.clear();
}
