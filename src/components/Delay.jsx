import React, { useState, useEffect } from 'react';
import { getModuleState, registerModule } from '../audio/audioEngine.js';
import InputSlider from './InputSlider.jsx';
import InputPort from './InputPort.jsx';
import OutputPort from './OutputPort.jsx';
import ModuleShell from './ModuleShell.jsx';

function Delay({ module, onDragStart, onOutputClick, isConnecting, onRemove }) {
    const saved = getModuleState(module.id)?.params ?? {};
    const [time,     setTime]     = useState(saved.time     ?? 250);   // ms
    const [feedback, setFeedback] = useState(saved.feedback ?? 0.4);   // 0–1
    const [mix,      setMix]      = useState(saved.mix      ?? 0.5);   // 0–1 dry/wet

    // Log scale helpers for time slider (1–2000 ms)
    const TIME_MIN = 1, TIME_MAX = 2000;
    const timeToPos = (ms) => Math.log(ms / TIME_MIN) / Math.log(TIME_MAX / TIME_MIN);
    const posToTime = (pos) => Math.round(TIME_MIN * Math.pow(TIME_MAX / TIME_MIN, pos));
    const formatTime = (ms) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;

    useEffect(() => {
        registerModule(module.id, { type: 'delay', params: { time, feedback, mix } });
    }, [module.id, time, feedback, mix]);

    return (
        <ModuleShell title="DLY" module={module} onDragStart={onDragStart} onRemove={onRemove}>
            <InputSlider
                moduleId={module.id} portId="time-input"
                label={`TIME: ${formatTime(time)}`}
                onOutputClick={onOutputClick} isConnecting={isConnecting}
                min="0" max="1" step="0.001"
                value={timeToPos(time)}
                onChange={(e) => setTime(posToTime(parseFloat(e.target.value)))}
                labelLeft="1ms" labelMid="~140ms" labelRight="2s"
            />
            <InputSlider
                moduleId={module.id} portId="feedback-input"
                label={`FEEDBACK: ${Math.round(feedback * 100)}%`}
                onOutputClick={onOutputClick} isConnecting={isConnecting}
                min="0" max="0.95" step="0.01"
                value={feedback}
                onChange={(e) => setFeedback(parseFloat(e.target.value))}
                labelLeft="0%" labelMid="50%" labelRight="95%"
            />
            <InputSlider
                moduleId={module.id} portId={null}
                label={`MIX: ${Math.round(mix * 100)}%`}
                onOutputClick={onOutputClick} isConnecting={isConnecting}
                min="0" max="1" step="0.01"
                value={mix}
                onChange={(e) => setMix(parseFloat(e.target.value))}
                labelLeft="DRY" labelMid="50%" labelRight="WET"
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

export default Delay;
