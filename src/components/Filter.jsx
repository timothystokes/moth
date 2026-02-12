import React, { useState, useEffect, useRef } from 'react';
import { registerModule, unregisterModule } from '../audio/audioEngine.js';

function Filter({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting, audioContext, connections }) {
    const [cutoff, setCutoff] = useState(1000); // Hz - 20Hz to 20000Hz
    const [resonance, setResonance] = useState(0.5); // 0 to 1
    const [filterType, setFilterType] = useState('lowpass'); // 'lowpass' or 'highpass'
    
    // Use refs to maintain filter state across parameter changes
    const filterStateRef = useRef({
        prevInput: 0,
        prevOutput: 0
    });
    
    // Register this module's processing function
    useEffect(() => {
        const filterProcessor = (time, inputFns) => {
            // Get audio input
            const audioInputFn = inputFns?.['audio-input'];
            const inputSignal = audioInputFn ? audioInputFn(time) : 0;
            
            // Get modulation inputs if connected
            const cutoffModFn = inputFns?.['cutoff-input'];
            const resonanceModFn = inputFns?.['resonance-input'];
            
            // Calculate final parameters with modulation
            let finalCutoff = cutoff;
            if (cutoffModFn) {
                const modVoltage = cutoffModFn(time); // 1V/octave or ±10V
                finalCutoff = cutoff * Math.pow(2, modVoltage / 5); // Exponential scaling
                finalCutoff = Math.max(20, Math.min(20000, finalCutoff)); // Clamp 20Hz-20kHz
            }
            
            let finalResonance = resonance;
            if (resonanceModFn) {
                const modVoltage = resonanceModFn(time); // ±10V
                finalResonance = resonance + (modVoltage / 20); // Add ±0.5 adjustment
                finalResonance = Math.max(0, Math.min(0.99, finalResonance)); // Clamp 0-0.99
            }
            
            // Calculate filter coefficient based on cutoff frequency
            const sampleRate = 44100; // Assume standard sample rate
            const dt = 1 / sampleRate;
            const rc = 1 / (2 * Math.PI * finalCutoff);
            const alpha = dt / (rc + dt);
            
            // Apply resonance as feedback
            const feedbackAmount = finalResonance * 0.95;
            const inputWithFeedback = inputSignal + (filterStateRef.current.prevOutput * feedbackAmount);
            
            let output;
            
            if (filterType === 'lowpass') {
                // Low-pass filter: smooth out high frequencies
                output = filterStateRef.current.prevOutput + alpha * (inputWithFeedback - filterStateRef.current.prevOutput);
            } else {
                // High-pass filter: let high frequencies through, block low frequencies
                // High-pass = input - low-pass
                const lowpass = filterStateRef.current.prevOutput + alpha * (inputWithFeedback - filterStateRef.current.prevOutput);
                output = inputWithFeedback - lowpass;
            }
            
            // Update state in ref
            filterStateRef.current.prevInput = inputSignal;
            filterStateRef.current.prevOutput = output;
            
            // Return filtered signal (already in ±10V range)
            return output;
        };
        
        registerModule(module.id, filterProcessor);
    }, [module.id, cutoff, resonance, filterType]);
    
    // Separate cleanup effect that only runs on unmount
    useEffect(() => {
        return () => {
            unregisterModule(module.id);
        };
    }, [module.id]);
    
    return (
        <div
            style={{
                position: 'absolute',
                left: module.x,
                top: module.y,
                width: '180px',
                minHeight: '180px',
                background: '#333',
                border: '2px solid #555',
                borderRadius: '4px',
                padding: 0,
                zIndex: 10,
                transition: 'none',
                boxShadow: '0 4px 8px rgba(0,0,0,0.3)'
            }}
        >
            <div 
                draggable
                onDragStart={(e) => {
                    e.preventDefault = () => {};
                    onDragStart(e, module.id);
                }}
                onDrag={onDrag}
                onDragEnd={onDragEnd}
                style={{ 
                    fontSize: '12px', 
                    fontWeight: 'bold', 
                    padding: '10px',
                    marginBottom: '10px', 
                    color: '#888',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    cursor: 'move',
                    background: '#2a2a2a',
                    borderTopLeftRadius: '4px',
                    borderTopRightRadius: '4px',
                    userSelect: 'none'
                }}
            >
                FILTER
            </div>
            
            <div style={{ padding: '10px' }}>
                {/* Filter Type Switch */}
                <div style={{ marginBottom: '15px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                    <button
                        onClick={() => setFilterType(filterType === 'lowpass' ? 'highpass' : 'lowpass')}
                        style={{
                            padding: '5px 10px',
                            background: filterType === 'lowpass' ? '#4a4' : '#a44',
                            border: 'none',
                            borderRadius: '3px',
                            color: '#fff',
                            fontSize: '10px',
                            fontWeight: 'bold',
                            cursor: 'pointer',
                            width: '100%'
                        }}
                    >
                        {filterType === 'lowpass' ? 'LOW-PASS' : 'HIGH-PASS'}
                    </button>
                </div>
                
                {/* Cutoff Control with Port */}
                <div style={{ marginBottom: '15px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        {connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'cutoff-input') 
                            ? 'CUTOFF' 
                            : `CUTOFF: ${cutoff.toFixed(0)}Hz`}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port 
                            type="input" 
                            moduleId={module.id}
                            portId="cutoff-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'cutoff-input', { 
                                    x: rect.left + rect.width / 2, 
                                    y: rect.top + rect.height / 2 
                                });
                            }}
                            isConnecting={isConnecting}
                        />
                        <input
                            type="range"
                            min="20"
                            max="20000"
                            step="10"
                            value={cutoff}
                            onChange={(e) => setCutoff(parseFloat(e.target.value))}
                            style={{
                                width: '100%',
                                cursor: 'pointer',
                                marginLeft: '20px'
                            }}
                        />
                    </div>
                </div>
                
                {/* Resonance Control with Port */}
                <div style={{ marginBottom: '15px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        {connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'resonance-input') 
                            ? 'RESONANCE' 
                            : `RESONANCE: ${resonance.toFixed(2)}`}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port 
                            type="input" 
                            moduleId={module.id}
                            portId="resonance-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'resonance-input', { 
                                    x: rect.left + rect.width / 2, 
                                    y: rect.top + rect.height / 2 
                                });
                            }}
                            isConnecting={isConnecting}
                        />
                        <input
                            type="range"
                            min="0"
                            max="0.99"
                            step="0.01"
                            value={resonance}
                            onChange={(e) => setResonance(parseFloat(e.target.value))}
                            style={{
                                width: '100%',
                                cursor: 'pointer',
                                marginLeft: '20px'
                            }}
                        />
                    </div>
                </div>
                
                {/* Audio Input Port */}
                <div style={{ position: 'relative', marginBottom: '15px' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        IN
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port 
                            type="input" 
                            moduleId={module.id}
                            portId="audio-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'audio-input', { 
                                    x: rect.left + rect.width / 2, 
                                    y: rect.top + rect.height / 2 
                                });
                            }}
                            isConnecting={isConnecting}
                        />
                    </div>
                </div>
                
                {/* Output Port */}
                <div style={{ position: 'relative', marginTop: '10px' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px', textAlign: 'right' }}>
                        OUT
                    </label>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', position: 'relative' }}>
                        <Port 
                            type="output" 
                            moduleId={module.id}
                            portId="output"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'output', { 
                                    x: rect.left + rect.width / 2, 
                                    y: rect.top + rect.height / 2 
                                });
                            }}
                            isConnecting={isConnecting}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

function Port({ type, onClick, isConnecting, moduleId, portId }) {
    const isInput = type === 'input';
    
    return (
        <div 
            onClick={onClick}
            data-module-id={moduleId}
            data-port-id={portId}
            data-port-type={type}
            style={{
                width: '16px',
                height: '16px',
                background: '#222',
                border: '2px solid ' + (isConnecting ? '#0f0' : (isInput ? '#f00' : '#00f')),
                cursor: onClick ? 'pointer' : 'default',
                position: 'absolute',
                left: isInput ? '-18px' : 'auto',
                right: !isInput ? '-18px' : 'auto'
            }}
        />
    );
}

export default Filter;
