import React, { useEffect } from 'react';
import { registerModule } from '../audio/audioEngine.js';
import InputPort from './InputPort.jsx';
import OutputPort from './OutputPort.jsx';

function Multi({ module, onDragStart, onOutputClick, isConnecting, onRemove }) {
    useEffect(() => {
        registerModule(module.id, { type: 'multi', params: {} });
    }, [module.id]);

    return (
        <div
            style={{
                position: 'relative',
                width: '150px',
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
                }}
            >
                <span>MULTI</span>
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                    <InputPort moduleId={module.id} portId="signal-input" label="IN"
                        onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                    <div>
                        <OutputPort moduleId={module.id} portId="output-a" label="OUT A"
                            onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: '6px' }} />
                        <OutputPort moduleId={module.id} portId="output-b" label="OUT B"
                            onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                    </div>
                </div>
            </div>
        </div>
    );
}

export default Multi;