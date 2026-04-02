import React, { useEffect, useState } from 'react';
import { getModuleState, registerModule } from '../audio/audioEngine.js';
import InputSlider from './InputSlider.jsx';
import InputPort from './InputPort.jsx';
import OutputPort from './OutputPort.jsx';
import ModuleShell from './ModuleShell.jsx';
import { COLOR_SCREEN, COLOR_SCREEN_DIM } from '../theme.js';

const TIME_MIN = 0.001;
const TIME_MAX = 10;
const TIME_RANGE = TIME_MAX / TIME_MIN;

const timeToSlider = (timeSeconds) => Math.log(timeSeconds / TIME_MIN) / Math.log(TIME_RANGE);
const sliderToTime = (sliderValue) => TIME_MIN * Math.pow(TIME_RANGE, sliderValue);

const formatTime = (timeSeconds) => {
    if (timeSeconds < 0.01) {
        return `${(timeSeconds * 1000).toFixed(1)}ms`;
    }
    if (timeSeconds < 1) {
        return `${(timeSeconds * 1000).toFixed(0)}ms`;
    }
    return `${timeSeconds.toFixed(2)}s`;
};

function buildEnvelopePreviewPoints(attack, decay, sustain, release, width, height) {
    const totalTime = Math.max(attack + decay + release, TIME_MIN);
    const attackPortion = attack / totalTime;
    const decayPortion = decay / totalTime;
    const releasePortion = release / totalTime;

    const leftPadding = 8;
    const rightPadding = 8;
    const topPadding = 8;
    const bottomPadding = 8;
    const innerWidth = width - leftPadding - rightPadding;
    const innerHeight = height - topPadding - bottomPadding;

    const points = [
        [leftPadding, height - bottomPadding],
        [leftPadding + innerWidth * attackPortion, topPadding],
        [leftPadding + innerWidth * (attackPortion + decayPortion), topPadding + innerHeight * (1 - sustain)],
        [leftPadding + innerWidth, height - bottomPadding]
    ];

    return points.map(([x, y]) => `${x},${y}`).join(' ');
}

function Envelope({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting, audioContext, connections, onRemove }) {
    const savedParams = getModuleState(module.id)?.params ?? {};
    const [attack, setAttack] = useState(savedParams.attack ?? 0.01);
    const [decay, setDecay] = useState(savedParams.decay ?? 0.2);
    const [sustain, setSustain] = useState(savedParams.sustain ?? 0.7);
    const [release, setRelease] = useState(savedParams.release ?? 0.4);
    const previewWidth = 156;
    const previewHeight = 84;
    const previewPoints = buildEnvelopePreviewPoints(attack, decay, sustain, release, previewWidth, previewHeight);
    const sustainGuideY = 8 + (previewHeight - 16) * (1 - sustain);

    useEffect(() => {
        registerModule(module.id, {
            type: 'envelope',
            params: {
                attack,
                decay,
                sustain,
                release
            }
        });
    }, [module.id, attack, decay, sustain, release]);

    return (
        <ModuleShell title={`ENV${module.instanceNum ? ` - ${module.instanceNum}` : ''}`} module={module} onDragStart={onDragStart} onRemove={onRemove} minHeight="245px">
                <div style={{ marginBottom: '15px' }}>
                    <div style={{
                        border: '1px solid #444',
                        background: '#1a1a1a',
                        borderRadius: '2px',
                        overflow: 'hidden'
                    }}>
                        <svg width="100%" height={previewHeight} viewBox={`0 0 ${previewWidth} ${previewHeight}`} preserveAspectRatio="none">
                            <line x1="0" y1={previewHeight - 1} x2={previewWidth} y2={previewHeight - 1} stroke="#2a2a2a" strokeWidth="1" />
                            <line x1="0" y1={previewHeight / 2} x2={previewWidth} y2={previewHeight / 2} stroke="#2a2a2a" strokeWidth="1" />
                            <line x1="0" y1="1" x2={previewWidth} y2="1" stroke="#2a2a2a" strokeWidth="1" />
                            <line
                                x1="0"
                                y1={sustainGuideY}
                                x2={previewWidth}
                                y2={sustainGuideY}
                                stroke={COLOR_SCREEN_DIM}
                                strokeWidth="1"
                                strokeDasharray="4 4"
                            />
                            <polyline
                                points={previewPoints}
                                fill="none"
                                stroke={COLOR_SCREEN}
                                strokeWidth="2"
                                strokeLinejoin="round"
                                strokeLinecap="round"
                            />
                        </svg>
                    </div>
                </div>

                <InputSlider
                    moduleId={module.id} portId="attack-input"
                    label={`ATTACK: ${formatTime(attack)}`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="1" step="0.001"
                    value={timeToSlider(attack)}
                    onChange={(e) => setAttack(sliderToTime(parseFloat(e.target.value)))}
                    labelLeft="1ms" labelRight="10s"
                />

                <InputSlider
                    moduleId={module.id} portId="decay-input"
                    label={`DECAY: ${formatTime(decay)}`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="1" step="0.001"
                    value={timeToSlider(decay)}
                    onChange={(e) => setDecay(sliderToTime(parseFloat(e.target.value)))}
                    labelLeft="1ms" labelRight="10s"
                />

                <InputSlider
                    moduleId={module.id} portId="sustain-input"
                    label={`SUSTAIN: ${sustain.toFixed(2)}`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="1" step="0.01"
                    value={sustain}
                    onChange={(e) => setSustain(parseFloat(e.target.value))}
                    labelLeft="0" labelMid="0.5" labelRight="1"
                />

                <InputSlider
                    moduleId={module.id} portId="release-input"
                    label={`RELEASE: ${formatTime(release)}`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="1" step="0.001"
                    value={timeToSlider(release)}
                    onChange={(e) => setRelease(sliderToTime(parseFloat(e.target.value)))}
                    labelLeft="1ms" labelRight="10s"
                />

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <InputPort moduleId={module.id} portId="gate-input" label="GATE"
                        onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                    <OutputPort moduleId={module.id} portId="output" label="OUT"
                        onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                </div>
        </ModuleShell>
    );
}

export default Envelope;