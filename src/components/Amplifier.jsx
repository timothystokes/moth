import React, { useEffect, useRef } from 'react';
import {
    initializeAudioEngine,
    subscribeToScopeData
} from '../audio/audioEngine.js';
import Port from './Port.jsx';

function Amplifier({ onOutputClick, isConnecting, audioContext, setAudioContext, isFixed, isPoweredOn, selectedTrackLabel }) {
    const startTimeRef = useRef(null);
    const scopeCanvasRef = useRef(null);
    const scopeSnapshotRef = useRef(new Float32Array(360));
    
    // Initialize Web Audio API when powered on
    useEffect(() => {
        if (isPoweredOn && !audioContext) {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            setAudioContext(ctx);
            startTimeRef.current = Date.now();
        }
    }, [isPoweredOn, audioContext, setAudioContext]);

    useEffect(() => {
        if (!audioContext) {
            return;
        }

        if (isPoweredOn) {
            initializeAudioEngine(audioContext).catch((error) => {
                console.error('Audio engine failed to initialize:', error);
            });
            audioContext.resume();
        } else {
            audioContext.suspend();
        }
    }, [audioContext, isPoweredOn]);

    useEffect(() => {
        const unsubscribe = subscribeToScopeData((samples) => {
            scopeSnapshotRef.current = samples;
        });

        return () => {
            unsubscribe();
        };
    }, []);

    useEffect(() => {
        if (!isPoweredOn || !scopeCanvasRef.current) return;
        
        const canvas = scopeCanvasRef.current;
        const ctx = canvas.getContext('2d');
        let animationId;
        
        const draw = () => {
            const width = canvas.width;
            const height = canvas.height;
            
            // Clear canvas
            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(0, 0, width, height);
            
            // Draw grid
            ctx.strokeStyle = '#2a2a2a';
            ctx.lineWidth = 1;
            
            // Horizontal center line
            ctx.beginPath();
            ctx.moveTo(0, height / 2);
            ctx.lineTo(width, height / 2);
            ctx.stroke();
            
            const snapshot = scopeSnapshotRef.current;
            
            // Draw waveform directly without any additional shifting
            ctx.strokeStyle = '#0f0';
            ctx.lineWidth = 2;
            ctx.beginPath();
            
            for (let i = 0; i < snapshot.length; i++) {
                const x = (i / snapshot.length) * width;
                const y = height / 2 - (snapshot[i] * height / 2);
                
                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }
            
            ctx.stroke();
            
            animationId = requestAnimationFrame(draw);
        };
        
        draw();
        
        return () => {
            if (animationId) {
                cancelAnimationFrame(animationId);
            }
        };
    }, [isPoweredOn]);
    
    return (
        <div
            style={{
                position: isFixed ? 'relative' : 'absolute',
                width: isFixed ? '100%' : '180px',
                minHeight: '160px',
                height: isFixed ? '100%' : 'auto',
                background: '#333',
                border: '2px solid #555',
                borderRadius: isFixed ? 0 : '4px',
                padding: 0,
                zIndex: 10,
                transition: 'none',
                boxShadow: isFixed ? 'none' : '0 4px 8px rgba(0,0,0,0.3)'
            }}
        >
            <div 
                style={{ 
                    fontSize: '12px', 
                    fontWeight: 'bold', 
                    padding: '10px',
                    marginBottom: '10px', 
                    color: '#888',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    cursor: 'default',
                    background: '#2a2a2a',
                    borderBottom: '1px solid #555',
                    borderRadius: '2px 2px 0 0'
            }}>
                <span>TRACK OUT</span>
            </div>
            
            <div style={{ padding: '10px' }}>
                {/* Oscilloscope */}
                <div style={{ marginBottom: '15px' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        SCOPE
                    </label>
                    <canvas
                        ref={scopeCanvasRef}
                        width={isFixed ? 360 : 320}
                        height={160}
                        style={{
                            width: '100%',
                            height: '160px',
                            border: '1px solid #444',
                            background: '#1a1a1a',
                            borderRadius: '2px'
                        }}
                    />
                </div>
                
                <div style={{ position: 'relative', marginTop: '10px' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        TO MIXER
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port 
                            type="input" 
                            moduleId="track-output-singleton"
                            portId="audio-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick('track-output-singleton', 'audio-input', { 
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

export default Amplifier;
