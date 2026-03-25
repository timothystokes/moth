import React, { useEffect, useState } from 'react';
import { getModuleState, registerModule } from '../audio/audioEngine.js';

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

function Envelope({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting, audioContext, connections }) {
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
        <div
            style={{
                position: 'absolute',
                left: module.x,
                top: module.y,
                width: '180px',
                minHeight: '245px',
                background: '#333',
                border: '2px solid #555',
                borderRadius: '4px',
                padding: 0,
                zIndex: 10,
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
                    borderRadius: '2px 2px 0 0'
                }}
            >
                <span>ENVELOPE</span>
            </div>

            <div style={{ padding: '10px' }}>
                <div style={{ marginBottom: '15px' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        SHAPE
                    </label>
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
                                stroke="#7cff7c66"
                                strokeWidth="1"
                                strokeDasharray="4 4"
                            />
                            <polyline
                                points={previewPoints}
                                fill="none"
                                stroke="#0f0"
                                strokeWidth="2"
                                strokeLinejoin="round"
                                strokeLinecap="round"
                            />
                        </svg>
                    </div>
                </div>

                <ParameterRow
                    label={connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'attack-input') ? 'ATTACK' : `ATTACK: ${formatTime(attack)}`}
                    moduleId={module.id}
                    portId="attack-input"
                    isConnecting={isConnecting}
                    onOutputClick={onOutputClick}
                >
                    <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.001"
                        value={timeToSlider(attack)}
                        onChange={(e) => setAttack(sliderToTime(parseFloat(e.target.value)))}
                        style={{ width: '100%', cursor: 'pointer', marginLeft: '20px' }}
                    />
                </ParameterRow>

                <ParameterRow
                    label={connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'decay-input') ? 'DECAY' : `DECAY: ${formatTime(decay)}`}
                    moduleId={module.id}
                    portId="decay-input"
                    isConnecting={isConnecting}
                    onOutputClick={onOutputClick}
                >
                    <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.001"
                        value={timeToSlider(decay)}
                        onChange={(e) => setDecay(sliderToTime(parseFloat(e.target.value)))}
                        style={{ width: '100%', cursor: 'pointer', marginLeft: '20px' }}
                    />
                </ParameterRow>

                <ParameterRow
                    label={connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'sustain-input') ? 'SUSTAIN' : `SUSTAIN: ${sustain.toFixed(2)}`}
                    moduleId={module.id}
                    portId="sustain-input"
                    isConnecting={isConnecting}
                    onOutputClick={onOutputClick}
                >
                    <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={sustain}
                        onChange={(e) => setSustain(parseFloat(e.target.value))}
                        style={{ width: '100%', cursor: 'pointer', marginLeft: '20px' }}
                    />
                </ParameterRow>

                <ParameterRow
                    label={connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'release-input') ? 'RELEASE' : `RELEASE: ${formatTime(release)}`}
                    moduleId={module.id}
                    portId="release-input"
                    isConnecting={isConnecting}
                    onOutputClick={onOutputClick}
                >
                    <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.001"
                        value={timeToSlider(release)}
                        onChange={(e) => setRelease(sliderToTime(parseFloat(e.target.value)))}
                        style={{ width: '100%', cursor: 'pointer', marginLeft: '20px' }}
                    />
                </ParameterRow>

                <div style={{ position: 'relative', marginTop: '12px', minHeight: '20px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative' }}>
                        <div style={{ position: 'relative', minWidth: '52px', minHeight: '16px' }}>
                            <span style={{ fontSize: '9px', color: '#aaa', marginLeft: '2px' }}>GATE IN</span>
                            <Port
                                type="input"
                                moduleId={module.id}
                                portId="gate-input"
                                onClick={(e) => {
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    onOutputClick(module.id, 'gate-input', {
                                        x: rect.left + rect.width / 2,
                                        y: rect.top + rect.height / 2
                                    });
                                }}
                                isConnecting={isConnecting}
                            />
                        </div>

                        <div style={{ position: 'relative', minWidth: '40px', minHeight: '16px', textAlign: 'right' }}>
                            <span style={{ fontSize: '9px', color: '#aaa', marginRight: '16px' }}>OUT</span>
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
        </div>
    );
}

function ParameterRow({ label, moduleId, portId, isConnecting, onOutputClick, children }) {
    return (
        <div style={{ marginBottom: '15px', position: 'relative' }}>
            <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                {label}
            </label>
            <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                <Port
                    type="input"
                    moduleId={moduleId}
                    portId={portId}
                    onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        onOutputClick(moduleId, portId, {
                            x: rect.left + rect.width / 2,
                            y: rect.top + rect.height / 2
                        });
                    }}
                    isConnecting={isConnecting}
                />
                {children}
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

export default Envelope;