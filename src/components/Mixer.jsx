import React, { useEffect } from 'react';
import { registerModule } from '../audio/audioEngine.js';
import InputPort from './InputPort.jsx';
import OutputPort from './OutputPort.jsx';

function Mixer({ module, onDragStart, onOutputClick, isConnecting, onRemove }) {
    useEffect(() => {
        registerModule(module.id, {
            type: 'mixer',
            params: { levelA: 0.5, levelB: 0.5 }
        });
    }, [module.id]);

    return (
        <div style={{
            position: 'relative', width: '180px',
            background: '#333', border: '2px solid #555',
            borderRadius: '4px', padding: 0, zIndex: 200,
            boxShadow: '0 4px 8px rgba(0,0,0,0.3)'
        }}>
            <div
                onMouseDown={(e) => onDragStart(e, module.id)}
                style={{
                    fontSize: '12px', fontWeight: 'bold', padding: '10px',
                    marginBottom: '10px', color: '#888',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    cursor: 'move', background: '#2a2a2a',
                    borderBottom: '1px solid #555', borderRadius: '2px 2px 0 0', position: 'relative'
                }}
            >
                <span>MIXER</span>
                {onRemove && (
                    <button
                        style={{
                            position: 'absolute', top: 4, right: 4, zIndex: 300,
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                    <div>
                        <InputPort moduleId={module.id} portId="input-a" label="IN A"
                            onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: '6px' }} />
                        <InputPort moduleId={module.id} portId="input-b" label="IN B"
                            onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                    </div>
                    <OutputPort moduleId={module.id} portId="output" label="OUT"
                        onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                </div>
            </div>
        </div>
    );
}

export default Mixer;
