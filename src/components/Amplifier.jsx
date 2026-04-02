import React, { useRef, useCallback } from 'react';
import InputPort from './InputPort.jsx';
import ModuleShell from './ModuleShell.jsx';
import ControlBlock from './ControlBlock.jsx';
import { COLOR_SLIDER } from '../theme.js';

function Knob({ value, min, max, onChange, defaultValue }) {
    const startRef = useRef(null);

    const norm = (v) => (v - min) / (max - min);
    const angle = -135 + norm(value) * 270;

    const handleMouseDown = useCallback((e) => {
        e.preventDefault();
        startRef.current = { y: e.clientY, value };
        const move = (mv) => {
            const delta = (startRef.current.y - mv.clientY) / 100;
            onChange(Math.max(min, Math.min(max, startRef.current.value + delta * (max - min))));
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }, [value, min, max, onChange]);

    const handleDoubleClick = useCallback(() => {
        if (defaultValue !== undefined) onChange(defaultValue);
    }, [defaultValue, onChange]);

    const cx = 22, cy = 22, r = 17;
    const rad = (a) => (a - 90) * (Math.PI / 180);
    const tx = cx + r * Math.cos(rad(angle));
    const ty = cy + r * Math.sin(rad(angle));

    return (
        <svg
            width={44} height={44}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
            style={{ cursor: 'ns-resize', display: 'block' }}
            title={`${value.toFixed(2)} (double-click to reset)`}
        >
            <circle cx={cx} cy={cy} r={r} fill="white" />
            <line x1={cx} y1={cy} x2={tx} y2={ty} stroke={COLOR_SLIDER} strokeWidth={10} strokeLinecap="round" />
        </svg>
    );
}

function Amplifier({ onOutputClick, isConnecting, isFixed, selectedTrack, onUpdateMix }) {
    const mix = selectedTrack?.mix ?? {};
    const trackId = selectedTrack?.id;
    const update = (patch) => { if (trackId) onUpdateMix(trackId, patch); };

    const volume = mix.volume ?? 0.8;
    const solo   = mix.solo   ?? false;
    const high   = mix.high   ?? 0;
    const mid    = mix.mid    ?? 0;
    const low    = mix.low    ?? 0;
    const pan    = mix.pan    ?? 0;

    const disabled = !trackId;
    const fmtEq = (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + 'dB';
    const fmtPan = (v) => v === 0 ? 'C' : (v > 0 ? 'R' : 'L') + Math.abs(v).toFixed(1);
    const faderHeight = 90;

    return (
        <ModuleShell isFixed={isFixed}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>

                <InputPort moduleId="track-output-singleton" portId="audio-input" label="IN"
                    onOutputClick={onOutputClick} isConnecting={isConnecting} />

                <div style={{ height: '1px', background: '#2a2a2a', margin: '8px 0' }} />

                <ControlBlock label="HIGH" value={fmtEq(high)}>
                    <Knob value={high} min={-12} max={12} defaultValue={0} onChange={(v) => update({ high: v })} />
                </ControlBlock>

                <ControlBlock label="MID" value={fmtEq(mid)}>
                    <Knob value={mid} min={-12} max={12} defaultValue={0} onChange={(v) => update({ mid: v })} />
                </ControlBlock>

                <ControlBlock label="LOW" value={fmtEq(low)}>
                    <Knob value={low} min={-12} max={12} defaultValue={0} onChange={(v) => update({ low: v })} />
                </ControlBlock>

                <ControlBlock label="PAN" value={fmtPan(pan)}>
                    <Knob value={pan} min={-1} max={1} defaultValue={0} onChange={(v) => update({ pan: v })} />
                </ControlBlock>

                <div style={{ height: '1px', background: '#2a2a2a', margin: '8px 0' }} />

                <ControlBlock label="VOL" value={(volume * 100).toFixed(0)}>
                    <div style={{ height: faderHeight, width: 20, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <input
                            type="range"
                            min="0" max="1" step="0.01"
                            value={volume}
                            disabled={disabled}
                            onChange={(e) => update({ volume: parseFloat(e.target.value) })}
                            style={{
                                width: faderHeight,
                                transform: 'rotate(-90deg)',
                                transformOrigin: 'center center',
                                position: 'absolute',
                                cursor: disabled ? 'default' : 'pointer',
                                accentColor: COLOR_SLIDER,
                                opacity: disabled ? 0.4 : 1,
                            }}
                        />
                    </div>
                </ControlBlock>

                <div style={{ height: '1px', background: '#2a2a2a', margin: '4px 0 8px' }} />

                <button
                    onClick={() => update({ solo: !solo })}
                    disabled={disabled}
                    style={{
                        padding: '4px 0',
                        width: '100%',
                        fontSize: '10px',
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        borderRadius: '5px',
                        background: solo ? '#2288FF' : '#fff',
                        color: solo ? '#fff' : '#000',
                        cursor: disabled ? 'default' : 'pointer',
                        opacity: disabled ? 0.4 : 1,
                        border: 0
                    }}
                    title={solo ? 'Unsolo' : 'Solo (silences other tracks)'}
                >
                    SOLO
                </button>
            </div>
        </ModuleShell>
    );
}

export default Amplifier;
