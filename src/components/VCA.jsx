import React, { useState, useEffect } from 'react';
import { getModuleState, registerModule } from '../audio/audioEngine.js';
import InputSlider from './InputSlider.jsx';
import Port from './Port.jsx';
import ModuleShell from './ModuleShell.jsx';
import ToggleSwitch from './ToggleSwitch.jsx';

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

    // Two-segment log scale: pos 0–0.5 → −60dB to 0dB, pos 0.5–1 → 0dB to +6dB
    const gainToPos = (g) => {
        if (g <= 0) return 0;
        const dB = 20 * Math.log10(g);
        if (dB <= 0) return Math.max(0, (dB + 60) / 120);
        return Math.min(1, dB / 12 + 0.5);
    };
    const posToGain = (pos) => {
        const dB = pos <= 0.5 ? -60 + pos * 120 : (pos - 0.5) * 12;
        return Math.pow(10, dB / 20);
    };
    const gainTodBLabel = (g) => g <= 0 ? '∞' : `${(20 * Math.log10(g)).toFixed(1)}dB`;

    useEffect(() => {
        registerModule(module.id, { type: 'vca', params: { gain, invert } });
    }, [module.id, gain, invert]);

    return (
        <ModuleShell title="VCA" module={module} onDragStart={onDragStart} onRemove={onRemove}>
                            <ToggleSwitch
                    label="POLARITY"
                    value={!invert}
                    onChange={(v) => setInvert(!v)}
                    labelOn="NORMAL" labelOff="REVERSE"
                />
                
                <InputSlider
                    moduleId={module.id} portId="gain-input"
                    label={`AMPLITUDE: ${gainTodBLabel(gain)}`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="1" step="0.001"
                    value={gainToPos(gain)}
                    onChange={(e) => setGain(posToGain(parseFloat(e.target.value)))}
                    labelLeft="∞" labelMid="0dB" labelRight="+6dB"
                />

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
        </ModuleShell>
    );
}

export default VCA;
