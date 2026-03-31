import React, { useEffect } from 'react';
import { registerModule } from '../audio/audioEngine.js';
import Port from './Port.jsx';

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
                {['A', 'B'].map((ch) => (
                    <div key={ch} style={{ marginBottom: '14px', position: 'relative', minHeight: '16px' }}>
                        <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '4px', marginLeft: '20px' }}>
                            IN {ch}
                        </label>
                        <Port
                            type="input" moduleId={module.id}
                            portId={ch === 'A' ? 'input-a' : 'input-b'}
                            onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, ch === 'A' ? 'input-a' : 'input-b', { x: r.left + r.width / 2, y: r.top + r.height / 2 });
                            }}
                            isConnecting={isConnecting}
                        />
                    </div>
                ))}

                <div style={{ position: 'relative', marginTop: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
                        <span style={{ fontSize: '9px', color: '#aaa', marginRight: '4px' }}>OUT</span>
                        <Port
                            type="output" moduleId={module.id} portId="output"
                            onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'output', { x: r.left + r.width / 2, y: r.top + r.height / 2 });
                            }}
                            isConnecting={isConnecting}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

export default Mixer;
