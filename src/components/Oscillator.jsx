import React, { useState, useEffect } from 'react';
import { getModuleState, registerModule } from '../audio/audioEngine.js';
import InputSlider from './InputSlider.jsx';
import OutputPort from './OutputPort.jsx';
import ModuleShell from './ModuleShell.jsx';

/**
 * Oscillator module
 *
 * Controls:
 *   FREQ  — logarithmic 0.1 Hz–8000 Hz slider (good for LFO through audio range)
 *           Input socket: 1V/octave relative offset on top of the slider value.
 *           Keyboard pitch only affects the oscillator when patched into this
 *           socket. 0V maps to A4 = 440Hz, so the slider stays the base tuning
 *           and incoming CV applies a relative offset around that reference.
 *   AMP   — output level in linear gain (1.0 = 0dB, 2.0 = +6dB)
 *           Slider: log scale, 0dB at midpoint, +6dB at max
 *           Input socket: gate / envelope signals in 0–5V act as VCA control;
 *           wider CV (±10V style) adds an offset.
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
function Oscillator({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting, audioContext, connections, onRemove }) {
    const savedParams = getModuleState(module.id)?.params ?? {};
    const [frequency, setFrequency] = useState(savedParams.frequency ?? 440); // Hz — default A4
    const [amplitude, setAmplitude] = useState(savedParams.amplitude ?? 1.0); // linear gain (1.0 = 0dB)
    const [shape, setShape] = useState(savedParams.shape ?? 0.5);         // 0=square, 0.5=sine, 1=triangle
    const [dutyCycle, setDutyCycle] = useState(savedParams.dutyCycle ?? 0.5);  // 0–1; 0.5=equal halves, 0/1=full asymmetry

    useEffect(() => {
        registerModule(module.id, {
            type: 'oscillator',
            params: {
                frequency,
                amplitude,
                shape,
                dutyCycle
            }
        });
    }, [module.id, frequency, amplitude, shape, dutyCycle]);

    // Two-segment log scale: pos 0–0.5 → −60dB to 0dB, pos 0.5–1 → 0dB to +6dB
    const ampToPos = (amp) => {
        if (amp <= 0) return 0;
        const dB = 20 * Math.log10(amp);
        if (dB <= 0) return Math.max(0, (dB + 60) / 120);
        return Math.min(1, dB / 12 + 0.5);
    };
    const posToAmp = (pos) => {
        if (pos <= 0) return 0;
        const dB = pos <= 0.5 ? -60 + pos * 120 : (pos - 0.5) * 12;
        return Math.pow(10, dB / 20);
    };
    const ampTodBLabel = (amp) => amp <= 0 ? '∞' : `${(20 * Math.log10(amp)).toFixed(1)}dB`;

    return (
        <ModuleShell title={`VCO${module.instanceNum ? ` - ${module.instanceNum}` : ''}`} module={module} onDragStart={onDragStart} onRemove={onRemove} minHeight="180px">
                <InputSlider
                    moduleId={module.id} portId="freq-input"
                    label={`FREQUENCY: ${frequency < 10 ? frequency.toFixed(2) : frequency < 100 ? frequency.toFixed(1) : frequency.toFixed(0)}Hz`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="1" step="0.001"
                    value={Math.log(frequency / 0.1) / Math.log(8000 / 0.1)}
                    onChange={(e) => setFrequency(0.1 * Math.pow(8000 / 0.1, parseFloat(e.target.value)))}
                    labelLeft="0.1Hz" labelRight="8kHz"
                />

                <InputSlider
                    moduleId={module.id} portId="amp-input"
                    label={`AMPLITUDE: ${ampTodBLabel(amplitude)}`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="1" step="0.001"
                    value={ampToPos(amplitude)}
                    onChange={(e) => setAmplitude(posToAmp(parseFloat(e.target.value)))}
                    labelLeft="∞" labelMid="0dB" labelRight="+6dB"
                />

                <InputSlider
                    moduleId={module.id} portId="shape-input"
                    label={`SHAPE: ${shape < 0.25 ? 'SQUARE' : shape < 0.75 ? 'SINE' : 'TRIANGLE'}`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="1" step="0.01"
                    value={shape}
                    onChange={(e) => setShape(parseFloat(e.target.value))}
                    labelLeft="SQR" labelMid="SIN" labelRight="TRI"
                />

                <InputSlider
                    moduleId={module.id} portId="duty-input"
                    label={`DUTY: ${(dutyCycle * 100).toFixed(0)}%`}
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    min="0" max="1" step="0.01"
                    value={dutyCycle}
                    onChange={(e) => setDutyCycle(parseFloat(e.target.value))}
                    labelLeft="0%" labelMid="50%" labelRight="100%"
                />

                <OutputPort moduleId={module.id} portId="output" label="OUT"
                    onOutputClick={onOutputClick} isConnecting={isConnecting} />
        </ModuleShell>
    );
}

export default Oscillator;
