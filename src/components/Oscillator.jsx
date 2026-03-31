import React, { useState, useEffect } from 'react';
import { getModuleState, registerModule } from '../audio/audioEngine.js';
import Port from './Port.jsx';

/**
 * Oscillator module
 *
 * Controls:
 *   FREQ  — logarithmic 0.1 Hz–8000 Hz slider (good for LFO through audio range)
 *           Input socket: 1V/octave relative offset on top of the slider value.
 *           Keyboard pitch only affects the oscillator when patched into this
 *           socket. 0V maps to A4 = 440Hz, so the slider stays the base tuning
 *           and incoming CV applies a relative offset around that reference.
 *   AMP   — output level 0–1 (maps to ±10V peak output)
 *           Input socket: gate / envelope signals in 0–5V act as VCA control;
 *           wider CV (±10V style) adds an offset.
 *   SHAPE — morphs SQR ← SIN → TRI
 *           Left half:  sine progressively adopts square-style pulse width and
 *                       blends into a softly-edged square target.
 *           Right half: linear crossfade from sine to triangle.
 *           Input socket: ±10V adds ±0.5 offset to the slider position.
 *   DUTY  — controls rise/fall time ratio: time spent rising (trough→peak) vs
 *           falling (peak→trough). On the SQR←SIN side, square-style pulse width
 *           is introduced gradually as shape moves toward square.
 *           CONSTRAINT: duty MUST always split the cycle at the peak and trough.
 *           It must never be applied at zero crossings or amplitude extremes
 *           (i.e. it must not stretch the "top" or "bottom" of the wave).
 *           Applied at full depth for all wave shapes.
 *           Clamped to [2%–98%] so neither half ever disappears completely.
 *           Input socket: ±10V adds ±0.5 offset to the slider position.
 *
 * Output: ±10V audio/CV signal
 *
 * Phase is accumulated per-voice (Δphase = 2π × freq × Δt) so FM modulation
 * depth is controlled purely by the modulator's amplitude — no time-drift artefacts.
 */
function Oscillator({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting, audioContext, connections, onRemove }) {
    const savedParams = getModuleState(module.id)?.params ?? {};
    const [frequency, setFrequency] = useState(savedParams.frequency ?? 440); // Hz — default A4
    const [amplitude, setAmplitude] = useState(savedParams.amplitude ?? 0.5); // 0–1 (maps to 0–±10V peak)
    const [shape, setShape] = useState(savedParams.shape ?? 0.5);         // 0=square, 0.5=sine, 1=triangle
    const [dutyCycle, setDutyCycle] = useState(savedParams.dutyCycle ?? 0.5);  // 0–1; 0.5=equal halves, 0/1=full asymmetry

    useEffect(() => {
        registerModule(module.id, {
            type: 'oscillator',
            params: {
                frequency,
                amplitude,
                shape,
                dutyCycle
            }
        });
    }, [module.id, frequency, amplitude, shape, dutyCycle]);

    return (
        <div
            style={{
                position: 'relative',
                width: '180px',
                minHeight: '180px',
                background: '#333',
                border: '2px solid #555',
                borderRadius: '4px',
                padding: 0,
                zIndex: 200,
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
                    borderRadius: '2px 2px 0 0',
                    position: 'relative'
            }}>
                <span>OSCILLATOR</span>
                {onRemove && (
                    <button
                        style={{
                            top: 4,
                            right: 4,
                            zIndex: 300,
                            background: '#444', // more subtle than red
                            color: '#fff',
                            border: 'none',
                            borderRadius: '50%',
                            width: 22,
                            height: 22,
                            fontWeight: 'bold',
                            fontSize: 14,
                            cursor: 'pointer',
                            boxShadow: '0 1px 4px #000a',
                            lineHeight: '22px',
                            padding: 0
                        }}
                        title="Remove module"
                        onClick={(e) => {
                            e.stopPropagation();
                            onRemove();
                        }}
                    >
                        ×
                    </button>
                )}
            </div>
            
            <div style={{ padding: '10px' }}>
                {/* Frequency Control with Port */}
                <div style={{ marginBottom: '15px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        {connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'freq-input') 
                            ? 'FREQ' 
                            : `FREQ: ${frequency < 10 ? frequency.toFixed(2) : frequency < 100 ? frequency.toFixed(1) : frequency.toFixed(0)}Hz`}
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
                            min="0"
                            max="1"
                            step="0.001"
                            value={Math.log(frequency / 0.1) / Math.log(8000 / 0.1)}
                            onChange={(e) => setFrequency(0.1 * Math.pow(8000 / 0.1, parseFloat(e.target.value)))}
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
                            : `SHAPE: ${shape < 0.25 ? 'SQR' : shape < 0.75 ? 'SIN' : 'TRI'}`}
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
                        <div style={{ flex: 1, marginLeft: '20px' }}>
                            <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                value={shape}
                                onChange={(e) => setShape(parseFloat(e.target.value))}
                                style={{ width: '100%', cursor: 'pointer' }}
                            />
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1px' }}>
                                <span style={{ fontSize: '8px', color: '#555' }}>SQR</span>
                                <span style={{ fontSize: '8px', color: '#555' }}>SIN</span>
                                <span style={{ fontSize: '8px', color: '#555' }}>TRI</span>
                            </div>
                        </div>
                    </div>
                </div>
                
                {/* Duty Cycle Control with Port */}
                <div style={{ marginBottom: '15px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        {connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'duty-input')
                            ? 'DUTY'
                            : `DUTY: ${(dutyCycle * 100).toFixed(0)}%`}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port
                            type="input"
                            moduleId={module.id}
                            portId="duty-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'duty-input', {
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
                            value={dutyCycle}
                            onChange={(e) => setDutyCycle(parseFloat(e.target.value))}
                            style={{ width: '100%', cursor: 'pointer', marginLeft: '20px' }}
                        />
                    </div>
                </div>

                {/* Output Port */}
                <div style={{ position: 'relative', marginTop: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', position: 'relative' }}>
                        <span style={{ fontSize: '9px', color: '#aaa', marginRight: '4px' }}>OUT</span>
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

export default Oscillator;
