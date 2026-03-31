import React, { useState, useEffect } from 'react';
import { getModuleState, registerModule } from '../audio/audioEngine.js';

/**
 * VCA (Voltage Controlled Amplifier) module
 *
 *   IN     — audio/CV input socket
 *   GAIN   — 0–2× slider. CV input adds offset: +5V → +1× gain, −5V → −1×.
 *   INVERT — polarity switch: + (normal) or − (multiply output by −1)
 *   OUT    — amplified output
 *
 * Output = input × finalGain × polarity
 * where finalGain = clamp(gain + gainCV/5, 0, 2)
 */
function VCA({ module, onDragStart, onOutputClick, isConnecting, connections, onRemove }) {
    const saved = getModuleState(module.id)?.params ?? {};
    const [gain, setGain] = useState(saved.gain ?? 1.0);
    const [invert, setInvert] = useState(saved.invert ?? false);

    useEffect(() => {
        registerModule(module.id, {
            type: 'vca',
            params: { gain, invert }
        });
    }, [module.id, gain, invert]);

    const hasGainCV = connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'gain-input');

    return (
        <div style={{
            position: 'relative',
            width: '180px',
            background: '#333',
            border: '2px solid #555',
            borderRadius: '4px',
            padding: 0,
            zIndex: 200,
            boxShadow: '0 4px 8px rgba(0,0,0,0.3)'
        }}>
            {/* Header / drag handle */}
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
                {/* Audio input */}
                <div style={{ marginBottom: '12px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '4px' }}>IN</label>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                        <Port type="input" moduleId={module.id} portId="audio-input"
                            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onOutputClick(module.id, 'audio-input', { x: r.left + r.width / 2, y: r.top + r.height / 2 }); }}
                            isConnecting={isConnecting} />
                    </div>
                </div>

                {/* Gain slider + CV input */}
                <div style={{ marginBottom: '12px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '4px' }}>
                        {hasGainCV ? 'GAIN' : `GAIN: ${gain.toFixed(2)}×`}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port type="input" moduleId={module.id} portId="gain-input"
                            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onOutputClick(module.id, 'gain-input', { x: r.left + r.width / 2, y: r.top + r.height / 2 }); }}
                            isConnecting={isConnecting} />
                        <input
                            type="range" min="0" max="2" step="0.01"
                            value={gain}
                            onChange={(e) => setGain(parseFloat(e.target.value))}
                            style={{ width: '100%', cursor: 'pointer', marginLeft: '20px' }}
                        />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1px', marginLeft: '20px' }}>
                        <span style={{ fontSize: '8px', color: '#555' }}>0</span>
                        <span style={{ fontSize: '8px', color: '#555' }}>1×</span>
                        <span style={{ fontSize: '8px', color: '#555' }}>2×</span>
                    </div>
                </div>

                {/* Polarity switch */}
                <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label style={{ fontSize: '10px', color: '#aaa' }}>POLARITY</label>
                    <button
                        onClick={() => setInvert(v => !v)}
                        style={{
                            background: invert ? '#a33' : '#3a6',
                            color: '#fff', border: 'none', borderRadius: '3px',
                            padding: '2px 10px', fontSize: '13px', fontWeight: 'bold',
                            cursor: 'pointer', minWidth: '34px'
                        }}
                    >{invert ? '−' : '+'}</button>
                </div>

                {/* Output */}
                <div style={{ marginTop: '10px', position: 'relative' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
                        <span style={{ fontSize: '9px', color: '#aaa', marginRight: '16px' }}>OUT</span>
                        <Port type="output" moduleId={module.id} portId="output"
                            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onOutputClick(module.id, 'output', { x: r.left + r.width / 2, y: r.top + r.height / 2 }); }}
                            isConnecting={isConnecting} />
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
                width: '16px', height: '16px', background: '#222',
                border: '2px solid ' + (isConnecting ? '#0f0' : (isInput ? '#f00' : '#00f')),
                cursor: onClick ? 'pointer' : 'default',
                position: 'absolute',
                left: isInput ? '-18px' : 'auto',
                right: !isInput ? '-18px' : 'auto'
            }}
        />
    );
}

export default VCA;
