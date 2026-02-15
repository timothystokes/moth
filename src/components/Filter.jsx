import React, { useState, useEffect, useRef } from 'react';
import { registerModule, unregisterModule } from '../audio/audioEngine.js';

function Filter({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting, audioContext, connections }) {
    const [cutoffSlider, setCutoffSlider] = useState(0.5); // 0 to 1 slider position
    const [resonance, setResonance] = useState(0.5); // 0 to 1
    const [filterType, setFilterType] = useState('lowpass'); // 'lowpass' or 'highpass'
    
    // Convert slider position to exponential frequency (20Hz to 20kHz) - reversed direction
    const cutoff = 20 * Math.pow(1000, (1 - cutoffSlider)); // Exponential scaling, inverted
    
    // Use refs to maintain filter state per voice (state variable filter with two integrators)
    const filterStatesRef = useRef(new Map()); // Map<voiceId, { lowpass, bandpass }>
    
    // Get or create filter state for a voice
    const getFilterState = (voiceId) => {
        if (!filterStatesRef.current.has(voiceId)) {
            filterStatesRef.current.set(voiceId, { lowpass: 0, bandpass: 0 });
        }
        return filterStatesRef.current.get(voiceId);
    };
    
    // Register this module's processing function
    useEffect(() => {
        const filterProcessor = (time, voiceContext, inputFns) => {
            // Get audio input
            const audioInputFn = inputFns?.['audio-input'];
            const inputSignal = audioInputFn ? audioInputFn(time, voiceContext) : 0;
            
            // Get modulation inputs if connected
            const cutoffModFn = inputFns?.['cutoff-input'];
            const resonanceModFn = inputFns?.['resonance-input'];
            
            // Calculate final parameters with modulation
            let finalCutoff = cutoff;
            if (cutoffModFn) {
                const modVoltage = cutoffModFn(time, voiceContext); // 1V/octave or ±10V
                finalCutoff = cutoff * Math.pow(2, modVoltage / 5); // Exponential scaling
                finalCutoff = Math.max(20, Math.min(20000, finalCutoff)); // Clamp 20Hz-20kHz
            }
            
            let finalResonance = resonance;
            if (resonanceModFn) {
                const modVoltage = resonanceModFn(time, voiceContext); // ±10V
                finalResonance = resonance + (modVoltage / 20); // Add ±0.5 adjustment
                finalResonance = Math.max(0, Math.min(0.99, finalResonance)); // Clamp 0-0.99
            }
            
            // Get filter state for this voice
            const voiceId = voiceContext?.voiceId || 'global';
            const filterState = getFilterState(voiceId);
            
            // State variable filter implementation (provides true resonance)
            const sampleRate = 44100;
            const nyquist = sampleRate / 2;
            
            // Clamp cutoff to prevent instability (max 80% of Nyquist)
            const safeCutoff = Math.min(finalCutoff, nyquist * 0.8);
            
            const f = 2 * Math.sin(Math.PI * safeCutoff / sampleRate); // Frequency coefficient
            const fClamped = Math.min(f, 1.9); // Ensure stability (must be < 2)
            const q = 1 - finalResonance; // Q factor (inverted - higher resonance = lower q)
            const qNormalized = Math.max(0.01, q); // Prevent divide by zero
            
            // State variable filter equations
            const lowpass = filterState.lowpass + fClamped * filterState.bandpass;
            const highpass = inputSignal - lowpass - qNormalized * filterState.bandpass;
            const bandpass = fClamped * highpass + filterState.bandpass;
            
            // Check for NaN/Infinity and reset if needed (safety check)
            if (!isFinite(lowpass) || !isFinite(bandpass)) {
                filterState.lowpass = 0;
                filterState.bandpass = 0;
                return 0;
            }
            
            // Update state
            filterState.lowpass = lowpass;
            filterState.bandpass = bandpass;
            
            // Return appropriate output based on filter type
            const output = filterType === 'lowpass' ? lowpass : highpass;
            
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
                onMouseDown={(e) => {
                    onDragStart(e, module.id);
                }}
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
                            min="0"
                            max="1"
                            step="0.001"
                            value={cutoffSlider}
                            onChange={(e) => setCutoffSlider(parseFloat(e.target.value))}
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
