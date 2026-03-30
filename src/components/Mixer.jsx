import React, { useEffect, useState } from 'react';
import { getModuleState, registerModule } from '../audio/audioEngine.js';

function Mixer({ module, onDragStart, onOutputClick, isConnecting, connections, onRemove }) {
    const savedParams = getModuleState(module.id)?.params ?? {};
    const [levelA, setLevelA] = useState(savedParams.levelA ?? 0.5);
    const [levelB, setLevelB] = useState(savedParams.levelB ?? 0.5);

    useEffect(() => {
        registerModule(module.id, {
            type: 'mixer',
            params: {
                levelA,
                levelB
            }
        });
    }, [module.id, levelA, levelB]);

    return (
        <div
            style={{
                position: 'relative',
                width: '180px',
                minHeight: '220px',
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
                }}
            >
                <span>MIXER</span>
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
                <ChannelRow
                    label={connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'level-a-input') ? 'LEVEL A' : `LEVEL A: ${levelA.toFixed(2)}`}
                    moduleId={module.id}
                    signalPortId="input-a"
                    levelPortId="level-a-input"
                    sliderValue={levelA}
                    onSliderChange={setLevelA}
                    onOutputClick={onOutputClick}
                    isConnecting={isConnecting}
                />

                <ChannelRow
                    label={connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'level-b-input') ? 'LEVEL B' : `LEVEL B: ${levelB.toFixed(2)}`}
                    moduleId={module.id}
                    signalPortId="input-b"
                    levelPortId="level-b-input"
                    sliderValue={levelB}
                    onSliderChange={setLevelB}
                    onOutputClick={onOutputClick}
                    isConnecting={isConnecting}
                />

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

function ChannelRow({
    label,
    moduleId,
    signalPortId,
    levelPortId,
    sliderValue,
    onSliderChange,
    onOutputClick,
    isConnecting
}) {
    return (
        <div style={{ marginBottom: '18px' }}>
            <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                {label}
            </label>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', position: 'relative', minHeight: '16px' }}>
                <span style={{ fontSize: '9px', color: '#aaa', marginLeft: '20px' }}>IN</span>
                <Port
                    type="input"
                    moduleId={moduleId}
                    portId={signalPortId}
                    onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        onOutputClick(moduleId, signalPortId, {
                            x: rect.left + rect.width / 2,
                            y: rect.top + rect.height / 2
                        });
                    }}
                    isConnecting={isConnecting}
                />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                <Port
                    type="input"
                    moduleId={moduleId}
                    portId={levelPortId}
                    onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        onOutputClick(moduleId, levelPortId, {
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
                    value={sliderValue}
                    onChange={(e) => onSliderChange(parseFloat(e.target.value))}
                    style={{
                        width: '100%',
                        cursor: 'pointer',
                        marginLeft: '20px'
                    }}
                />
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

export default Mixer;