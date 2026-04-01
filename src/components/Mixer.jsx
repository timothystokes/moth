import React, { useEffect } from 'react';
import { registerModule } from '../audio/audioEngine.js';
import InputPort from './InputPort.jsx';
import OutputPort from './OutputPort.jsx';
import ModuleShell from './ModuleShell.jsx';

function Mixer({ module, onDragStart, onOutputClick, isConnecting, onRemove }) {
    useEffect(() => {
        registerModule(module.id, {
            type: 'mixer',
            params: { levelA: 0.5, levelB: 0.5 }
        });
    }, [module.id]);

    return (
        <ModuleShell title="MIX" module={module} onDragStart={onDragStart} onRemove={onRemove}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                    <div>
                        <InputPort moduleId={module.id} portId="input-a" label="IN A"
                            onOutputClick={onOutputClick} isConnecting={isConnecting} />
                        <InputPort moduleId={module.id} portId="input-b" label="IN B"
                            onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                    </div>
                    <OutputPort moduleId={module.id} portId="output" label="OUT"
                        onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                </div>
        </ModuleShell>
    );
}

export default Mixer;
