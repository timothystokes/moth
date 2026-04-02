import React, { useEffect } from 'react';
import { registerModule } from '../audio/audioEngine.js';
import InputPort from './InputPort.jsx';
import OutputPort from './OutputPort.jsx';
import ModuleShell from './ModuleShell.jsx';

function Multi({ module, onDragStart, onOutputClick, isConnecting, onRemove }) {
    useEffect(() => {
        registerModule(module.id, { type: 'multi', params: {} });
    }, [module.id]);

    return (
        <ModuleShell title={`MUL${module.instanceNum ? ` - ${module.instanceNum}` : ''}`} module={module} onDragStart={onDragStart} onRemove={onRemove}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <InputPort moduleId={module.id} portId="signal-input" label="IN"
                        onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                    <div>
                        <OutputPort moduleId={module.id} portId="output-a" label="OUT A"
                            onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: '6px' }} />
                        <OutputPort moduleId={module.id} portId="output-b" label="OUT B"
                            onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                    </div>
                </div>
        </ModuleShell>
    );
}

export default Multi;