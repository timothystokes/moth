import React, { useEffect, useRef, useState } from 'react';
import { registerModule, unregisterModule } from '../audio/audioEngine.js';

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

function Envelope({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting, audioContext, connections }) {
    const [attack, setAttack] = useState(0.01);
    const [decay, setDecay] = useState(0.2);
    const [sustain, setSustain] = useState(0.7);
    const [release, setRelease] = useState(0.4);

    const stateMapRef = useRef(new Map());

    const getVoiceState = (voiceId) => {
        if (!stateMapRef.current.has(voiceId)) {
            stateMapRef.current.set(voiceId, {
                stage: 'idle',
                value: 0,
                lastTime: null,
                lastGate: 0,
                stageElapsed: 0,
                releaseStartValue: 0
            });
        }
        return stateMapRef.current.get(voiceId);
    };

    useEffect(() => {
        const envelopeProcessor = (time, voiceContext, inputFns) => {
            const gateModFn = inputFns?.['gate-input'];
            const attackModFn = inputFns?.['attack-input'];
            const decayModFn = inputFns?.['decay-input'];
            const sustainModFn = inputFns?.['sustain-input'];
            const releaseModFn = inputFns?.['release-input'];

            const finalAttack = Math.max(TIME_MIN, Math.min(TIME_MAX, attack * Math.pow(2, (attackModFn ? attackModFn(time, voiceContext) : 0) / 10)));
            const finalDecay = Math.max(TIME_MIN, Math.min(TIME_MAX, decay * Math.pow(2, (decayModFn ? decayModFn(time, voiceContext) : 0) / 10)));
            const finalSustain = Math.max(0, Math.min(1, sustain + (sustainModFn ? sustainModFn(time, voiceContext) : 0) / 20));
            const finalRelease = Math.max(TIME_MIN, Math.min(TIME_MAX, release * Math.pow(2, (releaseModFn ? releaseModFn(time, voiceContext) : 0) / 10)));

            const voiceId = voiceContext?.voiceId ?? 'default';
            const voiceState = getVoiceState(voiceId);
            const gate = gateModFn ? gateModFn(time, voiceContext) : 0;
            const gateOn = gate > 0;
            const gateWasOn = voiceState.lastGate > 0;

            if (gateOn && !gateWasOn) {
                voiceState.stage = 'attack';
                voiceState.value = 0;
                voiceState.stageElapsed = 0;
                voiceState.releaseStartValue = 0;
            } else if (!gateOn && gateWasOn) {
                voiceState.stage = 'release';
                voiceState.stageElapsed = 0;
                voiceState.releaseStartValue = voiceState.value;
            }

            const dt = voiceState.lastTime !== null && voiceState.lastTime !== time
                ? Math.max(0, (time - voiceState.lastTime) / 1000)
                : 0;
            voiceState.stageElapsed += dt;

            switch (voiceState.stage) {
                case 'attack': {
                    const progress = finalAttack <= TIME_MIN ? 1 : Math.min(1, voiceState.stageElapsed / finalAttack);
                    voiceState.value = progress;
                    if (progress >= 1) {
                        voiceState.stage = 'decay';
                        voiceState.stageElapsed = 0;
                        voiceState.value = 1;
                    }
                    break;
                }
                case 'decay': {
                    const progress = finalDecay <= TIME_MIN ? 1 : Math.min(1, voiceState.stageElapsed / finalDecay);
                    voiceState.value = 1 + (finalSustain - 1) * progress;
                    if (progress >= 1) {
                        voiceState.stage = gateOn ? 'sustain' : 'release';
                        voiceState.stageElapsed = 0;
                        voiceState.value = finalSustain;
                        if (!gateOn) {
                            voiceState.releaseStartValue = voiceState.value;
                        }
                    }
                    break;
                }
                case 'sustain':
                    voiceState.value = finalSustain;
                    break;
                case 'release': {
                    const progress = finalRelease <= TIME_MIN ? 1 : Math.min(1, voiceState.stageElapsed / finalRelease);
                    voiceState.value = voiceState.releaseStartValue * (1 - progress);
                    if (progress >= 1 || voiceState.value <= 0.00001) {
                        voiceState.stage = 'idle';
                        voiceState.stageElapsed = 0;
                        voiceState.value = 0;
                        voiceState.releaseStartValue = 0;
                    }
                    break;
                }
                default:
                    voiceState.stage = gateOn ? 'attack' : 'idle';
                    voiceState.value = gateOn ? voiceState.value : 0;
                    break;
            }

            voiceState.lastGate = gate;
            voiceState.lastTime = time;

            return Math.max(0, Math.min(1, voiceState.value));
        };

        registerModule(module.id, envelopeProcessor);

        return () => {
            unregisterModule(module.id);
        };
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
                <div style={{ marginBottom: '15px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        GATE IN
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative', minHeight: '16px' }}>
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

                <div style={{ position: 'relative', marginTop: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', position: 'relative' }}>
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