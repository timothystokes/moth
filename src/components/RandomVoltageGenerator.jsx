import React, { useState, useEffect } from 'react';
import { getModuleState, registerModule } from '../audio/audioEngine.js';
import InputSlider from './InputSlider.jsx';
import OutputPort from './OutputPort.jsx';

function RandomVoltageGenerator({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting, audioContext, connections, onRemove }) {
    const savedParams = getModuleState(module.id)?.params ?? {};
    const [rate, setRate] = useState(savedParams.rate ?? 5); // Hz - random value changes per second

    useEffect(() => {
        registerModule(module.id, {
            type: 'random',
            params: { rate }
        });
    }, [module.id, rate]);

    return (
        <div
            style={{
                position: 'relative',
                width: '180px',
                minHeight: '120px',
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
                <span>RANDOM</span>
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
                <InputSlider
                    moduleId={module.id} portId="rate-input"
                    label={`RATE: ${rate < 10 ? rate.toFixed(2) : rate < 100 ? rate.toFixed(1) : rate.toFixed(0)}Hz`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="1" step="0.001"
                    value={Math.log(rate / 0.1) / Math.log(8000 / 0.1)}
                    onChange={(e) => setRate(0.1 * Math.pow(8000 / 0.1, parseFloat(e.target.value)))}
                    labelLeft="0.1Hz" labelRight="8kHz"
                />

                <OutputPort moduleId={module.id} portId="output" label="OUT"
                    onOutputClick={onOutputClick} isConnecting={isConnecting} />
            </div>
        </div>
    );
}

export default RandomVoltageGenerator;
