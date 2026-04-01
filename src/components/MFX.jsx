import React, { useState, useEffect } from 'react';
import { getModuleState, registerModule } from '../audio/audioEngine.js';
import InputSlider from './InputSlider.jsx';
import InputPort from './InputPort.jsx';
import OutputPort from './OutputPort.jsx';
import ModuleShell from './ModuleShell.jsx';
import ToggleSwitch from './ToggleSwitch.jsx';

function MFX({ module, onDragStart, onOutputClick, isConnecting, onRemove }) {
    const saved = getModuleState(module.id)?.params ?? {};
    const [fxType,   setFxType]   = useState(saved.fxType   ?? 'delay');
    // timePos is the raw slider position (0–1) shared between both modes.
    // Delay reads it as 0–2000ms, reverb reads it as 0–1 room size.
    const [timePos,  setTimePos]  = useState(saved.timePos  ?? (saved.time != null ? Math.min(1, saved.time / 2000) : 0.25));
    const [feedback, setFeedback] = useState(saved.feedback ?? 0.4);
    const [mix,      setMix]      = useState(saved.mix      ?? 0.5);

    const isDelay = fxType === 'delay';

    // Switching modes keeps the slider position unchanged
    const handleFxTypeChange = (toDelay) => setFxType(toDelay ? 'delay' : 'reverb');

    // Derived values for display and worklet
    const delayMs  = Math.round(timePos * 2000);          // 0–2000ms
    const roomSize = timePos;                              // 0–1

    const formatTime = (ms) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
    const formatSize = (v) => {
        if (v < 0.25) return '~10m²';
        if (v < 0.5)  return '~30m²';
        if (v < 0.75) return '~80m²';
        return '~200m²';
    };

    useEffect(() => {
        // Pass the actual derived value to the worklet for each mode
        const time = isDelay ? delayMs : roomSize;
        registerModule(module.id, { type: 'mfx', params: { fxType, time, feedback, mix } });
    }, [module.id, fxType, timePos, feedback, mix]);

    return (
        <ModuleShell title="MFX" module={module} onDragStart={onDragStart} onRemove={onRemove}>
            <ToggleSwitch
                label="TYPE"
                value={isDelay}
                onChange={handleFxTypeChange}
                labelOn="DELAY" labelOff="REVERB"
            />

            {isDelay ? (
                <InputSlider
                    moduleId={module.id} portId="time-input"
                    label={`TIME: ${formatTime(delayMs)}`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="1" step="0.001"
                    value={timePos}
                    onChange={(e) => setTimePos(parseFloat(e.target.value))}
                    labelLeft="0ms" labelMid="1s" labelRight="2s"
                />
            ) : (
                <InputSlider
                    moduleId={module.id} portId="time-input"
                    label={`SIZE: ${formatSize(roomSize)}`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="1" step="0.001"
                    value={timePos}
                    onChange={(e) => setTimePos(parseFloat(e.target.value))}
                    labelLeft="ROOM" labelMid="HALL" labelRight="ARENA"
                />
            )}

            <InputSlider
                moduleId={module.id} portId="feedback-input"
                label={`FEEDBACK: ${Math.round(feedback * 100)}%`}
                onOutputClick={onOutputClick} isConnecting={isConnecting}
                min="0" max="0.8" step="0.01"
                value={feedback}
                onChange={(e) => setFeedback(parseFloat(e.target.value))}
                labelLeft="0%" labelMid="40%" labelRight="80%"
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

export default MFX;
