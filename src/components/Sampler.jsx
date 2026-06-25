import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getModuleState, loadSamplerSample, registerModule, triggerSampler, updateModuleParams } from '../audio/audioEngine.js';
import InputSlider from './InputSlider.jsx';
import InputPort from './InputPort.jsx';
import OutputPort from './OutputPort.jsx';
import ModuleShell from './ModuleShell.jsx';
import ToolbarButton from './ToolbarButton.jsx';

const SAMPLE_RATE = 12000;
const SAMPLE_SECONDS = 5;
const SAMPLE_LENGTH = SAMPLE_RATE * SAMPLE_SECONDS;
const FREQ_MIN = 0.1;
const FREQ_MAX = 8000;
const FREQ_RANGE = FREQ_MAX / FREQ_MIN;

const frequencyToSlider = (frequency) => Math.log(frequency / FREQ_MIN) / Math.log(FREQ_RANGE);
const sliderToFrequency = (sliderValue) => FREQ_MIN * Math.pow(FREQ_RANGE, sliderValue);

function formatFrequency(frequency) {
    if (frequency < 10) return frequency.toFixed(2);
    if (frequency < 100) return frequency.toFixed(1);
    return frequency.toFixed(0);
}

function downsampleMono(input, sourceRate) {
    const output = new Float32Array(SAMPLE_LENGTH);
    const ratio = sourceRate / SAMPLE_RATE;

    for (let index = 0; index < output.length; index += 1) {
        const sourcePosition = index * ratio;
        const leftIndex = Math.floor(sourcePosition);
        const rightIndex = Math.min(input.length - 1, leftIndex + 1);
        const fraction = sourcePosition - leftIndex;
        output[index] = (input[leftIndex] ?? 0) * (1 - fraction) + (input[rightIndex] ?? 0) * fraction;
    }

    return output;
}

function Sampler({ module, onDragStart, onOutputClick, isConnecting, connections, onRemove }) {
    const savedParams = getModuleState(module.id)?.params ?? {};
    const [frequency, setFrequency] = useState(savedParams.frequency ?? 440);
    const [sampleLoaded, setSampleLoaded] = useState(false);
    const [recording, setRecording] = useState(false);
    const [status, setStatus] = useState('NO SAMPLE');
    const recordingRef = useRef(null);

    const gateConnected = useMemo(() => (
        Array.isArray(connections) && connections.some((connection) => (
            connection.to?.moduleId === module.id && connection.to?.outputId === 'gate-input'
        ))
    ), [connections, module.id]);

    useEffect(() => {
        registerModule(module.id, { type: 'sampler', params: { frequency } });
    }, [module.id]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        updateModuleParams(module.id, { frequency });
    }, [module.id, frequency]);

    useEffect(() => () => {
        const active = recordingRef.current;
        if (!active) return;
        active.stream.getTracks().forEach((track) => track.stop());
        active.context.close().catch((error) => console.error('Failed to close sampler recording context:', error));
    }, []);

    const handleRecord = async () => {
        if (recording) return;

        const recordedFrequency = frequency;
        setRecording(true);
        setSampleLoaded(false);
        setStatus('RECORDING');

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
            const RecordingAudioContext = window.AudioContext || window.webkitAudioContext;
            const context = new RecordingAudioContext();
            const source = context.createMediaStreamSource(stream);
            const processor = context.createScriptProcessor(4096, 1, 1);
            const chunks = [];
            let capturedLength = 0;
            const requiredLength = Math.ceil(context.sampleRate * SAMPLE_SECONDS);

            recordingRef.current = { context, stream, processor };

            await new Promise((resolve, reject) => {
                processor.onaudioprocess = (event) => {
                    const input = event.inputBuffer.getChannelData(0);
                    const remaining = requiredLength - capturedLength;
                    const take = Math.min(remaining, input.length);
                    chunks.push(input.slice(0, take));
                    capturedLength += take;

                    if (capturedLength >= requiredLength) {
                        resolve();
                    }
                };

                source.connect(processor);
                processor.connect(context.destination);

                setTimeout(() => {
                    if (capturedLength < requiredLength) {
                        reject(new Error('Microphone recording timed out.'));
                    }
                }, (SAMPLE_SECONDS + 1) * 1000);
            });

            const captured = new Float32Array(capturedLength);
            let offset = 0;
            chunks.forEach((chunk) => {
                captured.set(chunk, offset);
                offset += chunk.length;
            });

            const sample = downsampleMono(captured, context.sampleRate);
            loadSamplerSample(module.id, sample, SAMPLE_RATE, recordedFrequency);
            setSampleLoaded(true);
            setStatus('LOADED');

            source.disconnect();
            processor.disconnect();
            stream.getTracks().forEach((track) => track.stop());
            await context.close();
            recordingRef.current = null;
        } catch (error) {
            const active = recordingRef.current;
            let cleanupError = null;
            if (active) {
                active.stream.getTracks().forEach((track) => track.stop());
                active.processor.disconnect();
                try {
                    await active.context.close();
                } catch (closeError) {
                    cleanupError = closeError;
                    console.error('Failed to close sampler recording context:', closeError);
                }
            }
            recordingRef.current = null;
            setSampleLoaded(false);
            const message = error instanceof Error ? error.message : String(error);
            const cleanupMessage = cleanupError instanceof Error ? `; cleanup: ${cleanupError.message}` : '';
            setStatus(`REC ERROR: ${message}${cleanupMessage}`);
        } finally {
            setRecording(false);
        }
    };

    const handleTrigger = () => {
        if (!sampleLoaded || gateConnected) return;
        triggerSampler(module.id);
    };

    return (
        <ModuleShell title={`SAM${module.instanceNum ? ` - ${module.instanceNum}` : ''}`} module={module} onDragStart={onDragStart} onRemove={onRemove} minHeight="198px">
            <InputSlider
                moduleId={module.id} portId="freq-input"
                label={`FREQUENCY: ${formatFrequency(frequency)}Hz`}
                onOutputClick={onOutputClick} isConnecting={isConnecting}
                min="0" max="1" step="0.001"
                value={frequencyToSlider(frequency)}
                onChange={(event) => setFrequency(sliderToFrequency(parseFloat(event.target.value)))}
                labelLeft="0.1Hz" labelRight="8kHz"
            />

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8 }}>
                <InputPort moduleId={module.id} portId="gate-input" label="GATE"
                    onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
                <ToolbarButton
                    onClick={handleTrigger}
                    disabled={!sampleLoaded || gateConnected}
                    style={{ height: 28, minWidth: 76, fontSize: 12, padding: '0 10px' }}
                >TRIGGER</ToolbarButton>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8 }}>
                <ToolbarButton
                    onClick={handleRecord}
                    disabled={recording}
                    variant="active"
                    active={recording}
                    style={{ height: 28, minWidth: 76, fontSize: 12, padding: '0 10px' }}
                >RECORD</ToolbarButton>
                <span style={{ color: sampleLoaded ? '#8adb8a' : '#bbb', fontSize: 10, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={status}>
                    {status}
                </span>
            </div>

            <OutputPort moduleId={module.id} portId="output" label="OUT"
                onOutputClick={onOutputClick} isConnecting={isConnecting} style={{ marginBottom: 0 }} />
        </ModuleShell>
    );
}

export default Sampler;