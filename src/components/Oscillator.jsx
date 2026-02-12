import React, { useState, useEffect } from 'react';
import { registerModule, unregisterModule } from '../audio/audioEngine.js';

function Oscillator({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting, audioContext, connections }) {
    const [frequency, setFrequency] = useState(220); // Hz - A3 for musical use
    const [amplitude, setAmplitude] = useState(0.5); // 0 to 1
    const [shape, setShape] = useState(0.5); // 0 = sawtooth, 0.5 = square, 1 = sine
    
    // Register this module's processing function
    useEffect(() => {
        const oscillatorProcessor = (time, inputFns) => {
            // Get modulation inputs if connected
            const freqModFn = inputFns?.['freq-input'];
            const ampModFn = inputFns?.['amp-input'];
            const shapeModFn = inputFns?.['shape-input'];
            
            // Calculate final parameters with modulation
            let finalFreq = frequency;
            if (freqModFn) {
                const modVoltage = freqModFn(time); // 1V/octave CV
                // When CV is connected, use standard 1V/octave where 0V = C2 = 65.41Hz
                // This ensures keyboard CV values produce correct musical pitches
                const referenceFreq = 65.41; // C2 (MIDI note 36)
                const sliderOffset = Math.log2(frequency / referenceFreq); // Slider acts as transpose in octaves
                finalFreq = referenceFreq * Math.pow(2, modVoltage + sliderOffset);
            }
            
            let finalAmp = amplitude;
            if (ampModFn) {
                const modVoltage = ampModFn(time); // ±10V
                finalAmp = amplitude + (modVoltage / 20); // Add ±0.5 adjustment
                finalAmp = Math.max(0, Math.min(1, finalAmp)); // Clamp 0-1
            }
            
            let finalShape = shape;
            if (shapeModFn) {
                const modVoltage = shapeModFn(time); // ±10V
                finalShape = shape + (modVoltage / 20); // Add ±0.5 adjustment
                finalShape = Math.max(0, Math.min(1, finalShape)); // Clamp 0-1
            }
            
            // Calculate phase (0 to 2π)
            const phase = (2 * Math.PI * finalFreq * (time / 1000)) % (2 * Math.PI);
            const normalizedPhase = phase / (2 * Math.PI); // 0 to 1
            
            let wave;
            
            // Generate base waveforms
            const sawtoothPhase = (normalizedPhase + 0.5) % 1; // Offset by 180 degrees
            const sawtooth = 2 * sawtoothPhase - 1; // -1 to 1 sawtooth (rising ramp)
            const square = normalizedPhase < 0.5 ? 1 : -1; // -1 to 1 square
            const sine = Math.sin(phase); // -1 to 1 sine
            
            // Blend between waveforms based on shape parameter
            if (finalShape < 0.5) {
                // Blend from sawtooth (0) to square (0.5)
                const blend = finalShape * 2; // 0 to 1
                wave = sawtooth * (1 - blend) + square * blend;
            } else {
                // Blend from square (0.5) to sine (1)
                const blend = (finalShape - 0.5) * 2; // 0 to 1
                wave = square * (1 - blend) + sine * blend;
            }
            
            // Scale to ±10V
            return wave * finalAmp * 10;
        };
        
        registerModule(module.id, oscillatorProcessor);
        
        return () => {
            unregisterModule(module.id);
        };
    }, [module.id, frequency, amplitude, shape]);
    
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
                    borderBottom: '1px solid #555',
                    borderRadius: '2px 2px 0 0'
            }}>
                <span>OSCILLATOR</span>
            </div>
            
            <div style={{ padding: '10px' }}>
                {/* Frequency Control with Port */}
                <div style={{ marginBottom: '15px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        {connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'freq-input') 
                            ? 'FREQ' 
                            : `FREQ: ${frequency.toFixed(1)}Hz`}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port 
                            type="input" 
                            moduleId={module.id}
                            portId="freq-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'freq-input', { 
                                    x: rect.left + rect.width / 2, 
                                    y: rect.top + rect.height / 2 
                                });
                            }}
                            isConnecting={isConnecting}
                        />
                        <input
                            type="range"
                            min="0.1"
                            max="2000"
                            step="0.1"
                            value={frequency}
                            onChange={(e) => setFrequency(parseFloat(e.target.value))}
                            style={{
                                width: '100%',
                                cursor: 'pointer',
                                marginLeft: '20px'
                            }}
                        />
                    </div>
                </div>
                
                {/* Amplitude Control with Port */}
                <div style={{ marginBottom: '15px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        {connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'amp-input') 
                            ? 'AMP' 
                            : `AMP: ${amplitude.toFixed(2)}`}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port 
                            type="input" 
                            moduleId={module.id}
                            portId="amp-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'amp-input', { 
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
                            step="0.01"
                            value={amplitude}
                            onChange={(e) => setAmplitude(parseFloat(e.target.value))}
                            style={{
                                width: '100%',
                                cursor: 'pointer',
                                marginLeft: '20px'
                            }}
                        />
                    </div>
                </div>
                
                {/* Shape Control with Port */}
                <div style={{ marginBottom: '15px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        {connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'shape-input') 
                            ? 'SHAPE' 
                            : `SHAPE: ${shape < 0.33 ? 'SAW' : shape < 0.66 ? 'SQR' : 'SIN'}`}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port 
                            type="input" 
                            moduleId={module.id}
                            portId="shape-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'shape-input', { 
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
                            step="0.01"
                            value={shape}
                            onChange={(e) => setShape(parseFloat(e.target.value))}
                            style={{
                                width: '100%',
                                cursor: 'pointer',
                                marginLeft: '20px'
                            }}
                        />
                    </div>
                </div>
                
                {/* Output Port */}
                <div style={{ position: 'relative', marginTop: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', position: 'relative' }}>
                        <span style={{ fontSize: '9px', color: '#aaa', marginRight: '16px' }}>OUT</span>
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

export default Oscillator;
