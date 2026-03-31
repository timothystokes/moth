import React, { useState, useEffect } from 'react';
import { getModuleState, registerModule } from '../audio/audioEngine.js';
import InputSlider from './InputSlider.jsx';
import Port from './Port.jsx';

/**
 * VCA (Voltage Controlled Amplifier) module
 *
 *   GAIN   — 0–2× slider. CV input adds offset: +5V → +1× gain.
 *   POLARITY — toggle switch: − (left) or + (right, default)
 *   IN/OUT — audio input and output inline at the bottom
 *
 * Output = input × finalGain × polarity
 * finalGain = clamp(gain + gainCV/5, 0, 2)
 */
function VCA({ module, onDragStart, onOutputClick, isConnecting, connections, onRemove }) {
    const saved = getModuleState(module.id)?.params ?? {};
    const [gain, setGain] = useState(saved.gain ?? 1.0);
    const [invert, setInvert] = useState(saved.invert ?? false);

    useEffect(() => {
        registerModule(module.id, { type: 'vca', params: { gain, invert } });
    }, [module.id, gain, invert]);

    return (
        <div style={{
            position: 'relative', width: '180px',
            background: '#333', border: '2px solid #555',
            borderRadius: '4px', padding: 0, zIndex: 200,
            boxShadow: '0 4px 8px rgba(0,0,0,0.3)'
        }}>
            {/* Header */}
            <div
                onMouseDown={(e) => onDragStart(e, module.id)}
                style={{
                    fontSize: '12px', fontWeight: 'bold', padding: '10px',
                    marginBottom: '10px', color: '#888',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    cursor: 'move', background: '#2a2a2a',
                    borderBottom: '1px solid #555', borderRadius: '2px 2px 0 0'
                }}
            >
                <span>AMPLIFIER</span>
                {onRemove && (
                    <button
                        style={{
                            background: '#444', color: '#fff', border: 'none',
                            borderRadius: '50%', width: 22, height: 22,
                            fontWeight: 'bold', fontSize: 14, cursor: 'pointer',
                            lineHeight: '22px', padding: 0
                        }}
                        title="Remove module"
                        onClick={(e) => { e.stopPropagation(); onRemove(); }}
                    >×</button>
                )}
            </div>

            <div style={{ padding: '10px' }}>
                <InputSlider
                    moduleId={module.id} portId="gain-input"
                    label={`GAIN: ${gain.toFixed(2)}×`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="2" step="0.01"
                    value={gain}
                    onChange={(e) => setGain(parseFloat(e.target.value))}
                    labelLeft="−∞" labelMid="0dB" labelRight="+6dB"
                />

                {/* Polarity toggle switch */}
                <div style={{ marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '10px', color: '#aaa' }}>POLARITY</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '4px' }}>
                        <span style={{ fontSize: '11px', fontWeight: 'bold', color: invert ? '#d66' : '#555' }}>−</span>
                        <div
                            onClick={() => setInvert(v => !v)}
                            style={{
                                width: '34px', height: '18px', borderRadius: '9px',
                                background: invert ? '#a33' : '#3a6',
                                position: 'relative', cursor: 'pointer',
                                transition: 'background 0.15s'
                            }}
                        >
                            <div style={{
                                position: 'absolute', top: '2px',
                                left: invert ? '2px' : '16px',
                                width: '14px', height: '14px',
                                borderRadius: '50%', background: '#fff',
                                transition: 'left 0.15s'
                            }} />
                        </div>
                        <span style={{ fontSize: '11px', fontWeight: 'bold', color: invert ? '#555' : '#6d6' }}>+</span>
                    </div>
                </div>

                {/* IN (left) and OUT (right) inline at the bottom */}
                <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                        <Port type="input" moduleId={module.id} portId="audio-input"
                            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onOutputClick(module.id, 'audio-input', { x: r.left + r.width / 2, y: r.top + r.height / 2 }); }}
                            isConnecting={isConnecting} />
                        <span style={{ fontSize: '9px', color: '#aaa', marginLeft: '6px' }}>IN</span>
                    </div>
                    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                        <span style={{ fontSize: '9px', color: '#aaa', marginRight: '6px' }}>OUT</span>
                        <Port type="output" moduleId={module.id} portId="output"
                            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onOutputClick(module.id, 'output', { x: r.left + r.width / 2, y: r.top + r.height / 2 }); }}
                            isConnecting={isConnecting} />
                    </div>
                </div>
            </div>
        </div>
    );
}

export default VCA;
