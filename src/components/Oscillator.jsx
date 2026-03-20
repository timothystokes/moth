import React, { useState, useEffect, useRef } from 'react';
import { registerModule, unregisterModule } from '../audio/audioEngine.js';

/**
 * Oscillator module
 *
 * Controls:
 *   FREQ  — logarithmic 0.1 Hz–2000 Hz slider (good for LFO through audio range)
 *           Input socket: 1V/octave relative offset on top of the slider value.
 *           Keyboard pitch only affects the oscillator when patched into this
 *           socket. 0V maps to A4 = 440Hz, so the slider stays the base tuning
 *           and incoming CV applies a relative offset around that reference.
 *   AMP   — output level 0–1 (maps to ±10V peak output)
 *           Input socket: gate (0–1) acts as VCA; CV (±10V) adds an offset.
 *   SHAPE — morphs SQR ← SIN → TRI
 *           Left half:  sine progressively adopts square-style pulse width and
 *                       blends into a softly-edged square target.
 *           Right half: linear crossfade from sine to triangle.
 *           Input socket: ±10V adds ±0.5 offset to the slider position.
 *   DUTY  — controls rise/fall time ratio: time spent rising (trough→peak) vs
 *           falling (peak→trough). On the SQR←SIN side, square-style pulse width
 *           is introduced gradually as shape moves toward square.
 *           CONSTRAINT: duty MUST always split the cycle at the peak and trough.
 *           It must never be applied at zero crossings or amplitude extremes
 *           (i.e. it must not stretch the "top" or "bottom" of the wave).
 *           Applied at full depth for all wave shapes.
 *           Clamped to [2%–98%] so neither half ever disappears completely.
 *           Input socket: ±10V adds ±0.5 offset to the slider position.
 *
 * Output: ±10V audio/CV signal
 *
 * Phase is accumulated per-voice (Δphase = 2π × freq × Δt) so FM modulation
 * depth is controlled purely by the modulator's amplitude — no time-drift artefacts.
 */
function Oscillator({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting, audioContext, connections }) {
    const [frequency, setFrequency] = useState(440); // Hz — default A4
    const [amplitude, setAmplitude] = useState(0.5); // 0–1 (maps to 0–±10V peak)
    const [shape, setShape] = useState(0.5);         // 0=square, 0.5=sine, 1=triangle
    const [dutyCycle, setDutyCycle] = useState(0.5);  // 0–1; 0.5=equal halves, 0/1=full asymmetry

    // Per-voice phase accumulator — keyed by voiceId (or 'default' for standalone use).
    // Stores { phase: radians 0..2π, lastTime: ms } so phase integrates Δt × freq
    // rather than being derived from absolute time (which causes FM to drift over time).
    const phaseMapRef = useRef(new Map());
    
    // Register this module's processing function
    useEffect(() => {
        const oscillatorProcessor = (time, voiceContext, inputFns) => {
            // voiceContext = { cv, gate, velocity, voiceId }
            //   cv:       available voice pitch CV (not applied unless patched to FREQ)
            //   gate:     0–1 velocity when note is on, absent when off
            //   velocity: 0–1 normalised note velocity
            //   voiceId:  unique id per polyphonic voice
            
            // Get modulation inputs if connected
            const freqModFn = inputFns?.['freq-input'];
            const ampModFn = inputFns?.['amp-input'];
            const shapeModFn = inputFns?.['shape-input'];
            const dutyModFn  = inputFns?.['duty-input'];
            
            // Calculate final parameters with modulation
            let finalFreq = frequency;
            
            // ── Frequency ────────────────────────────────────────────────────────
            // Freq socket is a 1V/octave relative nudge on top of the slider.
            // Keyboard CV patched here already provides 1V/octave directly, so the
            // incoming voltage is used as the relative octave offset.
            const freqNudgeOctaves = freqModFn ? freqModFn(time, voiceContext) : 0;

            // Frequency changes only through the wired FREQ input.
            // 0V at the input corresponds to no change, so a keyboard patched here
            // naturally aligns A4 (0V) with the default 440Hz slider position.
            finalFreq = frequency * Math.pow(2, freqNudgeOctaves);
            
            // ── Amplitude ────────────────────────────────────────────────────────
            let finalAmp = amplitude;

            if (ampModFn) {
                const modVoltage = ampModFn(time, voiceContext);
                if (modVoltage >= 0 && modVoltage <= 1) {
                    // 0–1 range → treat as gate/velocity: multiply (VCA behaviour)
                    finalAmp = amplitude * modVoltage;
                } else {
                    // Outside 0–1 → treat as bipolar CV: add offset (±10V = ±0.5)
                    finalAmp = Math.max(0, Math.min(1, amplitude + modVoltage / 20));
                }
            }
            
            // ── Shape modulation ─────────────────────────────────────────────────
            // ±10V maps to ±0.5 offset on the 0–1 slider range.
            let finalShape = shape;
            if (shapeModFn) {
                finalShape = Math.max(0, Math.min(1, shape + shapeModFn(time, voiceContext) / 20));
            }

            // ── Duty cycle modulation ────────────────────────────────────────────
            // ±10V maps to ±0.5 offset. Clamped to [0.02, 0.98] so neither
            // half of the cycle ever vanishes completely.
            let finalDuty = Math.max(0.02, Math.min(0.98, dutyCycle));
            if (dutyModFn) {
                finalDuty = Math.max(0.02, Math.min(0.98, dutyCycle + dutyModFn(time, voiceContext) / 20));
            }

            // ── Phase accumulation ───────────────────────────────────────────────
            // Integrate Δphase = 2π × finalFreq × Δt each frame so that FM
            // modulation is proportional only to the modulation voltage, never
            // to the absolute elapsed time.
            const voiceId = voiceContext?.voiceId ?? 'default';
            const voiceState = phaseMapRef.current.get(voiceId) ?? { phase: 0, lastTime: null };
            let accPhase;
            if (voiceState.lastTime !== null && voiceState.lastTime !== time) {
                const dt = (time - voiceState.lastTime) / 1000; // seconds
                accPhase = (voiceState.phase + 2 * Math.PI * finalFreq * dt) % (2 * Math.PI);
            } else {
                accPhase = voiceState.phase;
            }
            phaseMapRef.current.set(voiceId, { phase: accPhase, lastTime: time });

            const p = accPhase / (2 * Math.PI); // normalised real-time phase 0–1

            // ── Duty-cycle time dilation ─────────────────────────────────────────
            // CONSTRAINT: duty MUST split the cycle at the trough→peak and
            // peak→trough transitions — never at zero crossings or amplitude
            // extremes. This is enforced by the waveform alignment below.
            //
            // Two-slope linear ramp (no conditionals):
            //   rising  half [0→d]   maps to pw [0→0.5]
            //   falling half [d→1]   maps to pw [0.5→1]
            const d = finalDuty;
            const ps = (p + 0.25) % 1;
            const pw = Math.min(ps / (2 * d), 0.5) + Math.max((ps - d) / (2 * (1 - d)), 0);

            // ── Waveforms (all computed on pw; trough at pw=0, peak at pw=0.5) ───
            // CONSTRAINT: both functions must equal -1 at pw=0 (trough) and +1 at
            // pw=0.5 (peak). This guarantees duty always splits at peak/trough, not
            // at zero crossings or the top/bottom of the wave.
            const sineWave = -Math.cos(pw * 2 * Math.PI);
            const triangleWave = pw < 0.5 ? pw * 4 - 1 : 3 - pw * 4;

            const squareness = finalShape <= 0.5 ? (0.5 - finalShape) * 2 : 0;

            // Square-side pulse width: as squareness increases, move from no
            // top/bottom split (50/50) toward the full duty setting while keeping
            // the square plateaus aligned to the same duty-adjusted phase basis.
            const pulseWidthAmount = squareness;
            const squareDuty = 0.5 + (d - 0.5) * pulseWidthAmount;
            const squareWindowPhase = (pw - (0.5 - squareDuty / 2) + 1) % 1;
            const squarePhase = Math.min(squareWindowPhase / (2 * squareDuty), 0.5) + Math.max((squareWindowPhase - squareDuty) / (2 * (1 - squareDuty)), 0);
            const squareCarrier = Math.sin(squarePhase * 2 * Math.PI);
            // On the left half, the sine first adopts the same pulse-width timing,
            // then blends toward the square target as squareness increases.
            const leftHalfSine = sineWave * (1 - pulseWidthAmount) + squareCarrier * pulseWidthAmount;
            const squareEdgeSmoothingAmount = 0.5;
            const squareEdgeExponent = 0.001 + (1 - squareness) * squareEdgeSmoothingAmount;
            const squareTargetWave = Math.sign(squareCarrier) * Math.pow(Math.abs(squareCarrier), squareEdgeExponent);
            const leftHalfWave = leftHalfSine * (1 - squareness) + squareTargetWave * squareness;

            // ── Blend: shape 0=square → 0.5=sine → 1=triangle ───────────────────
            let wave;
            if (finalShape <= 0.5) {
                wave = leftHalfWave;
            } else {
                const sineToTriangle = (finalShape - 0.5) * 2;
                wave = sineWave * (1 - sineToTriangle) + triangleWave * sineToTriangle;
            }
            
            // Scale to ±10V
            return wave * finalAmp * 10;
        };
        
        registerModule(module.id, oscillatorProcessor);
        
        return () => {
            unregisterModule(module.id);
        };
    }, [module.id, frequency, amplitude, shape, dutyCycle]);
    
    return (
        <div
            style={{
                position: 'absolute',
                left: module.x,
                top: module.y,
                width: '180px',
                minHeight: '180px',
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
            }}>
                <span>OSCILLATOR</span>
            </div>
            
            <div style={{ padding: '10px' }}>
                {/* Frequency Control with Port */}
                <div style={{ marginBottom: '15px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        {connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'freq-input') 
                            ? 'FREQ' 
                            : `FREQ: ${frequency < 10 ? frequency.toFixed(2) : frequency < 100 ? frequency.toFixed(1) : frequency.toFixed(0)}Hz`}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port 
                            type="input" 
                            moduleId={module.id}
                            portId="freq-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'freq-input', { 
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
                            step="0.001"
                            value={Math.log(frequency / 0.1) / Math.log(2000 / 0.1)}
                            onChange={(e) => setFrequency(0.1 * Math.pow(2000 / 0.1, parseFloat(e.target.value)))}
                            style={{
                                width: '100%',
                                cursor: 'pointer',
                                marginLeft: '20px'
                            }}
                        />
                    </div>
                </div>
                
                {/* Amplitude Control with Port */}
                <div style={{ marginBottom: '15px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        {connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'amp-input') 
                            ? 'AMP' 
                            : `AMP: ${amplitude.toFixed(2)}`}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port 
                            type="input" 
                            moduleId={module.id}
                            portId="amp-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'amp-input', { 
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
                
                {/* Shape Control with Port */}
                <div style={{ marginBottom: '15px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        {connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'shape-input') 
                            ? 'SHAPE' 
                            : `SHAPE: ${shape < 0.25 ? 'SQR' : shape < 0.75 ? 'SIN' : 'TRI'}`}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port 
                            type="input" 
                            moduleId={module.id}
                            portId="shape-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'shape-input', { 
                                    x: rect.left + rect.width / 2, 
                                    y: rect.top + rect.height / 2 
                                });
                            }}
                            isConnecting={isConnecting}
                        />
                        <div style={{ flex: 1, marginLeft: '20px' }}>
                            <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                value={shape}
                                onChange={(e) => setShape(parseFloat(e.target.value))}
                                style={{ width: '100%', cursor: 'pointer' }}
                            />
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1px' }}>
                                <span style={{ fontSize: '8px', color: '#555' }}>SQR</span>
                                <span style={{ fontSize: '8px', color: '#555' }}>SIN</span>
                                <span style={{ fontSize: '8px', color: '#555' }}>TRI</span>
                            </div>
                        </div>
                    </div>
                </div>
                
                {/* Duty Cycle Control with Port */}
                <div style={{ marginBottom: '15px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        {connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'duty-input')
                            ? 'DUTY'
                            : `DUTY: ${(dutyCycle * 100).toFixed(0)}%`}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port
                            type="input"
                            moduleId={module.id}
                            portId="duty-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'duty-input', {
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
                            value={dutyCycle}
                            onChange={(e) => setDutyCycle(parseFloat(e.target.value))}
                            style={{ width: '100%', cursor: 'pointer', marginLeft: '20px' }}
                        />
                    </div>
                </div>

                {/* Output Port */}
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

export default Oscillator;
