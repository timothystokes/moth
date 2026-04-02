import React, { useState, useEffect } from 'react';
import { getModuleState, registerModule } from '../audio/audioEngine.js';
import InputSlider from './InputSlider.jsx';
import OutputPort from './OutputPort.jsx';
import ModuleShell from './ModuleShell.jsx';

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
        <ModuleShell title={`RND${module.instanceNum ? ` - ${module.instanceNum}` : ''}`} module={module} onDragStart={onDragStart} onRemove={onRemove} minHeight="120px">
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
        </ModuleShell>
    );
}

export default RandomVoltageGenerator;
