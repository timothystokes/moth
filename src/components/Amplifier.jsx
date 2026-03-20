import React, { useState, useEffect, useRef } from 'react';
import { getModuleOutputFunction } from '../audio/audioEngine.js';
import { getActiveVoices, updateVoiceOutput, setGateMonitoring } from '../audio/voiceAllocator.js';

function Amplifier({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting, audioContext, setAudioContext, connections, hasEnvelopeConnection, isFixed, isPoweredOn }) {
    const [amplitude, setAmplitude] = useState(0.5); // 0 to 1
    const startTimeRef = useRef(null);
    const scopeCanvasRef = useRef(null);
    const scopeBufferRef = useRef(new Float32Array(4096)); // Large circular buffer for continuous samples
    const scopeWriteIndexRef = useRef(0);
    
    // Initialize Web Audio API when powered on
    useEffect(() => {
        if (isPoweredOn && !audioContext) {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            setAudioContext(ctx);
            startTimeRef.current = Date.now();
        }
    }, [isPoweredOn, audioContext, setAudioContext]);
    
    // Draw oscilloscope with zero-crossing trigger
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
            
            const currentWriteIndex = scopeWriteIndexRef.current;
            const bufferSize = scopeBufferRef.current.length;
            const buffer = scopeBufferRef.current;
            
            // Search backwards through buffer to find zero-crossing trigger point
            let triggerIndex = -1;
            
            // Look through last 1000 samples for a zero crossing
            for (let searchOffset = 360; searchOffset < Math.min(1000, bufferSize - 3); searchOffset++) {
                const i = (currentWriteIndex - searchOffset + bufferSize) % bufferSize;
                
                const prev3 = (i - 3 + bufferSize) % bufferSize;
                const prev2 = (i - 2 + bufferSize) % bufferSize;
                const prev1 = (i - 1 + bufferSize) % bufferSize;
                const next1 = (i + 1) % bufferSize;
                const next2 = (i + 2) % bufferSize;
                
                const prev3Below = buffer[prev3] <= 0 && buffer[prev2] <= 0 && buffer[prev1] <= 0;
                const next3Above = buffer[i] >= 0 && buffer[next1] >= 0 && buffer[next2] >= 0;
                
                if (prev3Below && next3Above) {
                    triggerIndex = i;
                    break;
                }
            }
            
            // If no trigger found, just use most recent samples
            if (triggerIndex === -1) {
                triggerIndex = (currentWriteIndex - 360 + bufferSize) % bufferSize;
            }
            
            // Detect cycle length by finding next zero crossings from trigger point
            let cycleLength = 0;
            let cyclesFound = 0;
            
            for (let searchOffset = 10; searchOffset < bufferSize - 3 && cyclesFound < 2; searchOffset++) {
                const i = (triggerIndex + searchOffset) % bufferSize;
                const prev3 = (i - 3 + bufferSize) % bufferSize;
                const prev2 = (i - 2 + bufferSize) % bufferSize;
                const prev1 = (i - 1 + bufferSize) % bufferSize;
                const next1 = (i + 1) % bufferSize;
                const next2 = (i + 2) % bufferSize;
                
                const prev3Below = buffer[prev3] <= 0 && buffer[prev2] <= 0 && buffer[prev1] <= 0;
                const next3Above = buffer[i] >= 0 && buffer[next1] >= 0 && buffer[next2] >= 0;
                
                if (prev3Below && next3Above) {
                    if (cyclesFound === 0) {
                        cycleLength = searchOffset;
                    }
                    cyclesFound++;
                }
            }
            
            // Always collect exactly 360 samples (no auto-scaling for now)
            const snapshot = new Float32Array(360);
            for (let i = 0; i < 360; i++) {
                const bufferIndex = (triggerIndex + i) % bufferSize;
                snapshot[i] = buffer[bufferIndex];
            }
            
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
    
    // Audio processing loop using ScriptProcessorNode
    useEffect(() => {
        if (!audioContext || !isPoweredOn) return;
        
        const bufferSize = 4096;
        const scriptProcessor = audioContext.createScriptProcessor(bufferSize, 0, 1);
        
        // Find connected source modules
        const audioInputConnection = connections.find(
            c => c.to.moduleId === module.id && c.to.outputId === 'audio-input'
        );
        const ampModConnection = connections.find(
            c => c.to.moduleId === module.id && c.to.outputId === 'amp-input'
        );
        
        // Keep released voices alive only while envelope outputs are actually in use.
        setGateMonitoring(hasEnvelopeConnection);
        
        const sampleRate = audioContext.sampleRate;
        
        scriptProcessor.onaudioprocess = (e) => {
            const output = e.outputBuffer.getChannelData(0);
            // Use e.playbackTime - exact time when this buffer will be played
            const currentTime = e.playbackTime * 1000; // Convert to milliseconds
            const audioSourceFn = audioInputConnection
                ? getModuleOutputFunction(audioInputConnection.from.moduleId)
                : null;
            const ampModSourceFn = ampModConnection
                ? getModuleOutputFunction(ampModConnection.from.moduleId)
                : null;
            
            for (let i = 0; i < bufferSize; i++) {
                // Calculate time for this sample in milliseconds
                const sampleTime = currentTime + (i / sampleRate) * 1000;
                
                // Get all active and releasing voices from voice allocator
                const activeVoices = getActiveVoices();
                
                let mixedSample = 0;
                
                if (activeVoices.length > 0) {
                    // Process each voice and mix them together
                    for (const voice of activeVoices) {
                        // Create voice context from voice data
                        const voiceContext = {
                            cv: voice.cv,
                            gate: voice.gate,
                            velocity: voice.velocity,
                            voiceId: voice.voiceId
                        };
                        
                        // Get input signal for this voice
                        let voiceSignal = 0;
                        if (audioSourceFn) {
                            voiceSignal = audioSourceFn(sampleTime, voiceContext);
                        }

                        let voiceAmplitude = amplitude;
                        if (ampModSourceFn) {
                            const modVoltage = ampModSourceFn(sampleTime, voiceContext);
                            if (modVoltage >= 0 && modVoltage <= 1) {
                                voiceAmplitude = amplitude * modVoltage;
                            } else {
                                voiceAmplitude = Math.max(0, Math.min(1, amplitude + modVoltage / 20));
                            }
                        }

                        const voiceSample = (voiceSignal / 10) * voiceAmplitude;
                        
                        mixedSample += voiceSample;
                        
                        // Update voice output level (for silence detection)
                        updateVoiceOutput(voice.voiceId, voiceSignal * voiceAmplitude);
                    }
                    
                    // Average the voices to prevent clipping
                    mixedSample /= Math.sqrt(activeVoices.length); // Use sqrt for better scaling
                } else {
                    // No active notes - try to process without voice context for modules
                    // that don't need it (like LFOs, random generators, etc.)
                    if (audioSourceFn) {
                        let finalAmplitude = amplitude;
                        const mixedSignal = audioSourceFn(sampleTime, null);
                        if (ampModSourceFn) {
                            const modVoltage = ampModSourceFn(sampleTime, null);
                            if (modVoltage >= 0 && modVoltage <= 1) {
                                finalAmplitude = amplitude * modVoltage;
                            } else {
                                finalAmplitude = Math.max(0, Math.min(1, amplitude + modVoltage / 20));
                            }
                        }
                        mixedSample = (mixedSignal / 10) * finalAmplitude;
                    }
                }

                output[i] = mixedSample;
                
                // Store every sample in circular buffer
                scopeBufferRef.current[scopeWriteIndexRef.current] = mixedSample;
                scopeWriteIndexRef.current = (scopeWriteIndexRef.current + 1) % scopeBufferRef.current.length;
            }
        };
        
        scriptProcessor.connect(audioContext.destination);
        
        return () => {
            scriptProcessor.disconnect();
        };
    }, [audioContext, isPoweredOn, amplitude, connections, module.id, hasEnvelopeConnection]);
    
    const togglePower = () => {
        setIsPoweredOn(!isPoweredOn);
    };
    
    return (
        <div
            style={{
                position: isFixed ? 'relative' : 'absolute',
                left: isFixed ? 'auto' : module?.x,
                top: isFixed ? 'auto' : module?.y,
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
                draggable={!isFixed}
                onDragStart={isFixed ? undefined : (e) => {
                    e.preventDefault = () => {};
                    onDragStart && onDragStart(e, module.id);
                }}
                onDrag={isFixed ? undefined : onDrag}
                onDragEnd={isFixed ? undefined : onDragEnd}
                style={{ 
                    fontSize: '12px', 
                    fontWeight: 'bold', 
                    padding: '10px',
                    marginBottom: '10px', 
                    color: '#888',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    cursor: isFixed ? 'default' : 'move',
                    background: '#2a2a2a',
                    borderBottom: '1px solid #555',
                    borderRadius: '2px 2px 0 0'
            }}>
                <span>AMPLIFIER</span>
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
                
                {/* Amplitude Control with Port */}
                <div style={{ marginBottom: '15px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        {connections?.some(c => c.to.moduleId === module?.id && c.to.outputId === 'amp-input') 
                            ? 'AMP' 
                            : `AMP: ${(amplitude * 10).toFixed(1)}V`}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port 
                            type="input" 
                            moduleId={module?.id}
                            portId="amp-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module?.id, 'amp-input', { 
                                    x: rect.left + rect.width / 2, 
                                    y: rect.top + rect.height / 2 
                                });
                            }} 
                            isConnecting={isConnecting} 
                        />
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            value={amplitude}
                            onChange={(e) => setAmplitude(parseFloat(e.target.value))}
                            style={{
                                width: '100%',
                                cursor: 'pointer',
                                marginLeft: '20px'
                            }}
                        />
                    </div>
                </div>
                
                {/* Audio Input Port */}
                <div style={{ position: 'relative', marginTop: '10px' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        IN
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port 
                            type="input" 
                            moduleId={module?.id}
                            portId="audio-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module?.id, 'audio-input', { 
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

export default Amplifier;
