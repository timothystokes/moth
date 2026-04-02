import React, { useState, useEffect } from 'react';
import { getModuleState, registerModule, updateModuleParams } from '../audio/audioEngine.js';
import InputSlider from './InputSlider.jsx';
import InputPort from './InputPort.jsx';
import OutputPort from './OutputPort.jsx';
import ModuleShell from './ModuleShell.jsx';
import ToggleSwitch from './ToggleSwitch.jsx';

function Filter({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting, audioContext, connections, onRemove }) {
    const savedParams = getModuleState(module.id)?.params ?? {};
    const [cutoffSlider, setCutoffSlider] = useState(savedParams.cutoffSlider ?? 0.5); // 0 to 1 slider position
    const [resonance, setResonance] = useState(savedParams.resonance ?? 0.5); // 0 to 1
    const [filterType, setFilterType] = useState(savedParams.filterType ?? 'lowpass'); // 'lowpass' or 'highpass'
    
    // Convert slider position to exponential frequency (20Hz to 20kHz) - reversed direction
    const cutoff = 20 * Math.pow(1000, (1 - cutoffSlider)); // Exponential scaling, inverted
    
    useEffect(() => {
        registerModule(module.id, { type: 'filter', params: { cutoffSlider, resonance, filterType } });
    }, [module.id]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        updateModuleParams(module.id, { cutoffSlider, resonance, filterType });
    }, [module.id, cutoffSlider, resonance, filterType]);
    
    return (
        <ModuleShell title={`VCF${module.instanceNum ? ` - ${module.instanceNum}` : ''}`} module={module} onDragStart={onDragStart} onRemove={onRemove} minHeight="180px">
                <ToggleSwitch
                    label="TYPE"
                    value={filterType === 'lowpass'}
                    onChange={(v) => setFilterType(v ? 'lowpass' : 'highpass')}
                    labelOn="LOW PASS" labelOff="HIGH PASS"
                />
                
                <InputSlider
                    moduleId={module.id} portId="cutoff-input"
                    label={`CUTOFF: ${cutoff.toFixed(0)}Hz`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="1" step="0.001"
                    value={cutoffSlider}
                    onChange={(e) => setCutoffSlider(parseFloat(e.target.value))}
                    labelLeft="20kHz" labelRight="20Hz"
                />

                <InputSlider
                    moduleId={module.id} portId="resonance-input"
                    label={`RESONANCE: ${resonance.toFixed(2)}`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="0.99" step="0.01"
                    value={resonance}
                    onChange={(e) => setResonance(parseFloat(e.target.value))}
                    labelLeft="FLAT" labelRight="MAX"
                />

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <InputPort moduleId={module.id} portId="audio-input" label="IN"
                        onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                    <OutputPort moduleId={module.id} portId="output" label="OUT"
                        onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                </div>
        </ModuleShell>
    );
}

export default Filter;
