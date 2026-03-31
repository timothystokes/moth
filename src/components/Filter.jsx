import React, { useState, useEffect } from 'react';
import { getModuleState, registerModule } from '../audio/audioEngine.js';
import InputSlider from './InputSlider.jsx';
import InputPort from './InputPort.jsx';
import OutputPort from './OutputPort.jsx';

function Filter({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting, audioContext, connections, onRemove }) {
    const savedParams = getModuleState(module.id)?.params ?? {};
    const [cutoffSlider, setCutoffSlider] = useState(savedParams.cutoffSlider ?? 0.5); // 0 to 1 slider position
    const [resonance, setResonance] = useState(savedParams.resonance ?? 0.5); // 0 to 1
    const [filterType, setFilterType] = useState(savedParams.filterType ?? 'lowpass'); // 'lowpass' or 'highpass'
    
    // Convert slider position to exponential frequency (20Hz to 20kHz) - reversed direction
    const cutoff = 20 * Math.pow(1000, (1 - cutoffSlider)); // Exponential scaling, inverted
    
    useEffect(() => {
        registerModule(module.id, {
            type: 'filter',
            params: {
                cutoffSlider,
                resonance,
                filterType
            }
        });
    }, [module.id, cutoff, resonance, filterType]);
    
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
                    borderTopLeftRadius: '4px',
                    borderTopRightRadius: '4px',
                    userSelect: 'none',
                    position: 'relative'
                }}
            >
                FILTER
                {onRemove && (
                    <button
                        style={{
                            position: 'absolute',
                            top: 4,
                            right: 4,
                            zIndex: 300,
                            background: '#444',
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

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <InputPort moduleId={module.id} portId="audio-input" label="IN"
                        onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                    <OutputPort moduleId={module.id} portId="output" label="OUT"
                        onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                </div>
            </div>
        </div>
    );
}

export default Filter;
