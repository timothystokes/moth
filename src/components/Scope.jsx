import React, { useEffect, useRef } from 'react';
import { registerModule, subscribeToModuleScopeData } from '../audio/audioEngine.js';
import ModuleShell from './ModuleShell.jsx';
import InputPort from './InputPort.jsx';
import OutputPort from './OutputPort.jsx';
import { COLOR_SCREEN } from '../theme.js';

const PEAK_HISTORY_SIZE = 5;
const SCALE_LERP = 0.05;
const MIN_SCALE = 1;

function Scope({ module, onDragStart, isAudioReady, onOutputClick, isConnecting, onRemove }) {
    const scopeCanvasRef = useRef(null);
    const scopeSnapshotRef = useRef(new Float32Array(360));
    const peakHistoryRef = useRef([]);
    const displayScaleRef = useRef(MIN_SCALE);

    useEffect(() => {
        registerModule(module.id, { type: 'scope', params: {} });
    }, [module.id]);

    useEffect(() => {
        const unsubscribe = subscribeToModuleScopeData(module.id, (samples) => {
            scopeSnapshotRef.current = samples;

            // Track peak absolute value of this snapshot
            let peak = MIN_SCALE;
            for (let i = 0; i < samples.length; i++) {
                const abs = Math.abs(samples[i]);
                if (abs > peak) peak = abs;
            }
            const history = peakHistoryRef.current;
            history.push(peak);
            if (history.length > PEAK_HISTORY_SIZE) history.shift();
        });
        return () => unsubscribe();
    }, [module.id]);

    useEffect(() => {
        if (!isAudioReady || !scopeCanvasRef.current) return;

        const canvas = scopeCanvasRef.current;
        const ctx = canvas.getContext('2d');
        let animationId;

        const draw = () => {
            const width = canvas.width;
            const height = canvas.height;

            // Lerp display scale towards running avg of last 5 peak values
            const history = peakHistoryRef.current;
            if (history.length > 0) {
                const maxPeak = Math.max(...history);
                const targetScale = Math.max(MIN_SCALE, maxPeak * 1.2);
                displayScaleRef.current += (targetScale - displayScaleRef.current) * SCALE_LERP;
            }
            const scale = displayScaleRef.current;

            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(0, 0, width, height);

            ctx.strokeStyle = '#2a2a2a';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, height / 2);
            ctx.lineTo(width, height / 2);
            ctx.stroke();

            const snapshot = scopeSnapshotRef.current;
            ctx.strokeStyle = COLOR_SCREEN;
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i < snapshot.length; i++) {
                const x = (i / snapshot.length) * width;
                const y = height / 2 - (snapshot[i] / scale) * (height / 2);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            animationId = requestAnimationFrame(draw);
        };

        draw();
        return () => { if (animationId) cancelAnimationFrame(animationId); };
    }, [isAudioReady]);

    return (
        <ModuleShell title={`SCO${module.instanceNum ? ` - ${module.instanceNum}` : ''}`} module={module} onDragStart={onDragStart} onRemove={onRemove} width="200px">
            <canvas
                ref={scopeCanvasRef}
                width={360}
                height={160}
                style={{
                    width: '100%',
                    height: '140px',
                    border: '1px solid #444',
                    background: '#1a1a1a',
                    borderRadius: '2px',
                    display: 'block',
                    marginBottom: 10,
                }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <InputPort moduleId={module.id} portId="signal-input" label="IN"
                    onOutputClick={onOutputClick} isConnecting={isConnecting} />
                <OutputPort moduleId={module.id} portId="signal-output" label="OUT"
                    onOutputClick={onOutputClick} isConnecting={isConnecting} />
            </div>
        </ModuleShell>
    );
}

export default Scope;
