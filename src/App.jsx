import React, { useState, useRef, useEffect } from 'react';
import Amplifier from './components/Amplifier.jsx';
import Oscillator from './components/Oscillator.jsx';
import Filter from './components/Filter.jsx';
import Keyboard from './components/Keyboard.jsx';
import RandomVoltageGenerator from './components/RandomVoltageGenerator.jsx';
import Envelope from './components/Envelope.jsx';
import Mixer from './components/Mixer.jsx';
import Multi from './components/Multi.jsx';
import Transport from './components/Transport.jsx';
import { connectModules, disconnectInput } from './audio/audioEngine.js';
import {
    loadMIDIFile,
    playLoadedSequence,
    rewindLoadedSequence,
    selectLoadedSequenceChannel,
    stopLoadedSequence,
    subscribeToSequenceTransport
} from './audio/midiManager.js';

const toolbarHeight = 50;
const transportHeight = 78;

const initialTransportState = {
    hasSequence: false,
    fileName: null,
    channel: null,
    channelDisplay: null,
    availableChannels: [],
    durationMs: 0,
    eventCount: 0,
    isPlaying: false,
    playbackPositionMs: 0
};

function getDestinationModuleIds(moduleId, inputPort) {
    return [moduleId];
}

function App() {
    const [modules, setModules] = useState([
        {
            id: 'amplifier-singleton',
            type: 'amplifier',
            x: 100,
            y: 100
        },
        {
            id: 'keyboard-singleton',
            type: 'keyboard',
            x: 100,
            y: 100
        }
    ]);
    const [connections, setConnections] = useState([]);
    const [draggedModule, setDraggedModule] = useState(null);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [connectingFrom, setConnectingFrom] = useState(null);
    const [tempConnection, setTempConnection] = useState(null);
    const [audioContext, setAudioContext] = useState(null);
    const [isPoweredOn, setIsPoweredOn] = useState(false);
    const [transportState, setTransportState] = useState(initialTransportState);
    const [pendingTransportPlay, setPendingTransportPlay] = useState(false);
    
    const canvasRef = useRef(null);
    const contentRef = useRef(null);

    const handleModuleDragStart = (e, moduleId) => {
        e.preventDefault();
        const module = modules.find(m => m.id === moduleId);
        const rect = e.target.getBoundingClientRect();
        const canvasRect = canvasRef.current?.getBoundingClientRect();
        
        setDraggedModule(moduleId);
        setDragOffset({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        });
    };

    const handleModuleDrag = (e) => {
        if (!draggedModule) return;
        
        // Get canvas position to calculate relative coordinates
        const canvasRect = canvasRef.current?.getBoundingClientRect();
        if (!canvasRect) return;
        
        setModules(prev => prev.map(m => 
            m.id === draggedModule 
                ? { 
                    ...m, 
                    x: e.clientX - canvasRect.left - dragOffset.x, 
                    y: e.clientY - canvasRect.top - dragOffset.y 
                }
                : m
        ));
    };

    const handleModuleDragEnd = () => {
        setDraggedModule(null);
    };
    
    // Add global mouse listeners
    useEffect(() => {
        const handleGlobalMouseMove = (e) => {
            if (draggedModule) {
                handleModuleDrag(e);
            }
        };
        
        const handleGlobalMouseUp = () => {
            if (draggedModule) {
                handleModuleDragEnd();
            }
        };
        
        window.addEventListener('mousemove', handleGlobalMouseMove);
        window.addEventListener('mouseup', handleGlobalMouseUp);
        
        return () => {
            window.removeEventListener('mousemove', handleGlobalMouseMove);
            window.removeEventListener('mouseup', handleGlobalMouseUp);
        };
    }, [draggedModule, dragOffset]);

    useEffect(() => {
        const unsubscribe = subscribeToSequenceTransport(setTransportState);

        return () => {
            unsubscribe();
        };
    }, []);

    useEffect(() => {
        if (isPoweredOn) {
            return;
        }

        setPendingTransportPlay(false);
        stopLoadedSequence();
    }, [isPoweredOn]);

    useEffect(() => {
        if (!pendingTransportPlay || !audioContext || !isPoweredOn) {
            return;
        }

        let isCancelled = false;

        const startPlayback = async () => {
            try {
                await audioContext.resume();
                await playLoadedSequence();
            } catch (error) {
                console.error('Failed to start MIDI playback:', error);
            } finally {
                if (!isCancelled) {
                    setPendingTransportPlay(false);
                }
            }
        };

        startPlayback();

        return () => {
            isCancelled = true;
        };
    }, [pendingTransportPlay, audioContext, isPoweredOn]);

    const handleOutputClick = (moduleId, outputId, position) => {
        if (connectingFrom) {
            // Already connecting, this is the destination
            // Determine which port is output and which is input based on port type
            const fromPort = document.querySelector(`[data-module-id="${connectingFrom.moduleId}"][data-port-id="${connectingFrom.outputId}"]`);
            const toPort = document.querySelector(`[data-module-id="${moduleId}"][data-port-id="${outputId}"]`);
            
            if (!fromPort || !toPort) {
                setConnectingFrom(null);
                setTempConnection(null);
                return;
            }
            
            // Get port types from the DOM elements (stored when Port is rendered)
            const fromPortType = fromPort.getAttribute('data-port-type'); // 'input' or 'output'
            const toPortType = toPort.getAttribute('data-port-type');
            
            // Determine which is the output and which is the input
            let outputModule, outputPort, inputModule, inputPort;
            
            if (fromPortType === 'output' && toPortType === 'input') {
                // Normal: output to input
                outputModule = connectingFrom.moduleId;
                outputPort = connectingFrom.outputId;
                inputModule = moduleId;
                inputPort = outputId;
            } else if (fromPortType === 'input' && toPortType === 'output') {
                // Reversed: user clicked input first, then output - swap them
                outputModule = moduleId;
                outputPort = outputId;
                inputModule = connectingFrom.moduleId;
                inputPort = connectingFrom.outputId;
            } else {
                // Invalid connection (input to input or output to output)
                setConnectingFrom(null);
                setTempConnection(null);
                return;
            }
            
            // Check if this input port already has a connection and remove it
            const existingConnection = connections.find(
                conn => conn.to.moduleId === inputModule && conn.to.outputId === inputPort
            );
            
            if (existingConnection) {
                // Remove the existing connection first
                getDestinationModuleIds(existingConnection.to.moduleId, existingConnection.to.outputId).forEach(destinationModuleId => {
                    disconnectInput(destinationModuleId, existingConnection.to.outputId);
                });
                setConnections(prev => prev.filter(c => c.id !== existingConnection.id));
            }
            
            const newConnection = {
                id: `conn-${Date.now()}`,
                from: { moduleId: outputModule, outputId: outputPort, position: null },
                to: { moduleId: inputModule, outputId: inputPort, position: null }
            };
            setConnections(prev => [...prev, newConnection]);
            
            // Create direct function reference in audio engine (always output -> input)
            // For keyboard outputs, map to the correct registered module ID
            let sourceModuleId = outputModule;
            if (outputModule === 'keyboard-singleton') {
                // Map keyboard outputs to their respective registered IDs
                if (outputPort === 'cv-out') {
                    sourceModuleId = 'keyboard-singleton-cv';
                } else if (outputPort === 'gate-out') {
                    sourceModuleId = 'keyboard-singleton-gate';
                }
            } else if (outputPort === 'output-a' || outputPort === 'output-b') {
                const sourceModule = modules.find(m => m.id === outputModule);
                sourceModuleId = sourceModule?.type === 'multi'
                    ? outputModule
                    : `${outputModule}-${outputPort}`;
            }
            
            getDestinationModuleIds(inputModule, inputPort).forEach(destinationModuleId => {
                connectModules(
                    sourceModuleId,
                    destinationModuleId,
                    inputPort
                );
            });
            
            setConnectingFrom(null);
            setTempConnection(null);
        } else {
            // Check if this port already has a connection
            const existingInputConnection = connections.find(
                conn => conn.to.moduleId === moduleId && conn.to.outputId === outputId
            );
            const existingOutputConnection = connections.find(
                conn => conn.from.moduleId === moduleId && conn.from.outputId === outputId
            );
            const existingConnection = existingInputConnection || existingOutputConnection;
            
            if (existingConnection) {
                // Remove existing connection and start new one
                getDestinationModuleIds(existingConnection.to.moduleId, existingConnection.to.outputId).forEach(destinationModuleId => {
                    disconnectInput(destinationModuleId, existingConnection.to.outputId);
                });
                setConnections(prev => prev.filter(c => c.id !== existingConnection.id));
            }
            
            // Start connection
            setConnectingFrom({ moduleId, outputId, position });
        }
    };

    const handleCanvasMouseMove = (e) => {
        if (connectingFrom) {
            const rect = canvasRef.current.getBoundingClientRect();
            setTempConnection({
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            });
        }
    };

    const handleCanvasClick = (e) => {
        if (connectingFrom && e.target === canvasRef.current) {
            // Cancel connection if clicking canvas
            setConnectingFrom(null);
            setTempConnection(null);
        }
    };

    const addModule = (type) => {
        const newModule = {
            id: `module-${Date.now()}`,
            type,
            x: 100 + modules.length * 50,
            y: 100 + modules.length * 30
        };
        setModules(prev => [...prev, newModule]);
    };

    const removeConnection = (connectionId) => {
        const connection = connections.find(c => c.id === connectionId);
        if (connection) {
            // Remove direct function reference in audio engine
            getDestinationModuleIds(connection.to.moduleId, connection.to.outputId).forEach(destinationModuleId => {
                disconnectInput(destinationModuleId, connection.to.outputId);
            });
        }
        setConnections(prev => prev.filter(c => c.id !== connectionId));
    };

    const amplifierModule = modules.find(m => m.type === 'amplifier');
    const keyboardModule = modules.find(m => m.type === 'keyboard');
    const envelopeModuleIds = new Set(modules.filter(m => m.type === 'envelope').map(m => m.id));
    const hasEnvelopeConnection = connections.some(c => envelopeModuleIds.has(c.from.moduleId));
    const hasKeyboardGateOutputConnection = connections.some(
        c => c.from.moduleId === 'keyboard-singleton' && c.from.outputId === 'gate-out'
    );
    
    const togglePower = () => {
        setIsPoweredOn(prev => !prev);
    };

    const handleSequenceLoad = async (file) => {
        setPendingTransportPlay(false);
        return loadMIDIFile(file);
    };

    const handleTransportPlay = async () => {
        if (!transportState.hasSequence) {
            throw new Error('Load a MIDI file before pressing play.');
        }

        if (!audioContext || !isPoweredOn) {
            setPendingTransportPlay(true);
            if (!isPoweredOn) {
                setIsPoweredOn(true);
            }
            return;
        }

        await audioContext.resume();
        await playLoadedSequence();
    };

    const handleTransportStop = () => {
        setPendingTransportPlay(false);
        stopLoadedSequence();
    };

    const handleTransportRewind = () => {
        setPendingTransportPlay(false);
        rewindLoadedSequence();
    };

    const handleTransportChannelSelect = (channel) => {
        setPendingTransportPlay(false);
        return selectLoadedSequenceChannel(channel);
    };

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative', display: 'flex', flexDirection: 'column', background: '#101010' }}>
            <Toolbar addModule={addModule} isPoweredOn={isPoweredOn} togglePower={togglePower} />

            <div ref={contentRef} style={{ flex: 1, position: 'relative', display: 'flex', minHeight: 0 }}>
            {/* SVG overlay for connections */}
            <svg style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                zIndex: 9999
            }}>
                {/* Draw connections */}
                {connections.map(conn => {
                    // Get current port positions from DOM
                    const fromPort = document.querySelector(`[data-module-id="${conn.from.moduleId}"][data-port-id="${conn.from.outputId}"]`);
                    const toPort = document.querySelector(`[data-module-id="${conn.to.moduleId}"][data-port-id="${conn.to.outputId}"]`);
                    const contentRect = contentRef.current?.getBoundingClientRect();
                    
                    if (!fromPort || !toPort || !contentRect) return null;
                    
                    const fromRect = fromPort.getBoundingClientRect();
                    const toRect = toPort.getBoundingClientRect();
                    
                    const x1 = fromRect.left - contentRect.left + fromRect.width / 2;
                    const y1 = fromRect.top - contentRect.top + fromRect.height / 2;
                    const x2 = toRect.left - contentRect.left + toRect.width / 2;
                    const y2 = toRect.top - contentRect.top + toRect.height / 2;
                    
                    return (
                        <g key={conn.id}>
                            <path
                                d={`M ${x1} ${y1} C ${x1 + 50} ${y1}, ${x2 - 50} ${y2}, ${x2} ${y2}`}
                                stroke="#00ff00"
                                strokeWidth="2"
                                fill="none"
                                style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    removeConnection(conn.id);
                                }}
                            />
                        </g>
                    );
                })}
                
                {/* Draw temporary connection while dragging */}
                {connectingFrom && tempConnection && (() => {
                    const fromPort = document.querySelector(`[data-module-id="${connectingFrom.moduleId}"][data-port-id="${connectingFrom.outputId}"]`);
                    const contentRect = contentRef.current?.getBoundingClientRect();

                    if (!fromPort || !contentRect) return null;
                    
                    const fromRect = fromPort.getBoundingClientRect();
                    const canvasRect = canvasRef.current?.getBoundingClientRect();
                    
                    const x1 = fromRect.left - contentRect.left + fromRect.width / 2;
                    const y1 = fromRect.top - contentRect.top + fromRect.height / 2;
                    
                    // tempConnection coordinates are relative to canvas, need to adjust
                    const x2 = canvasRect ? canvasRect.left - contentRect.left + tempConnection.x : tempConnection.x;
                    const y2 = canvasRect ? canvasRect.top - contentRect.top + tempConnection.y : tempConnection.y;
                    
                    return (
                        <path
                            d={`M ${x1} ${y1} L ${x2} ${y2}`}
                            stroke="#00ff0066"
                            strokeWidth="2"
                            fill="none"
                            strokeDasharray="5,5"
                        />
                    );
                })()}
            </svg>
            
            {/* Fixed left panel for Keyboard */}
            {keyboardModule && (
                <div style={{
                    width: '160px',
                    height: '100%',
                    background: '#1a1a1a',
                    borderRight: '2px solid #444',
                    flexShrink: 0
                }}>
                    <Keyboard
                        module={keyboardModule}
                        onOutputClick={handleOutputClick}
                        isConnecting={connectingFrom?.moduleId === 'keyboard-singleton'}
                        audioContext={audioContext}
                        isFixed={true}
                        hasGateOutputConnection={hasKeyboardGateOutputConnection}
                    />
                </div>
            )}
            
            {/* Main canvas area for modules */}
            <div style={{ flex: 1, position: 'relative' }}>
                <Canvas 
                    canvasRef={canvasRef}
                    modules={modules}
                    connections={connections}
                    connectingFrom={connectingFrom}
                    tempConnection={tempConnection}
                    onModuleDragStart={handleModuleDragStart}
                    onModuleDrag={handleModuleDrag}
                    onModuleDragEnd={handleModuleDragEnd}
                    onOutputClick={handleOutputClick}
                    onMouseMove={handleCanvasMouseMove}
                    onClick={handleCanvasClick}
                    onRemoveConnection={removeConnection}
                    audioContext={audioContext}
                    setAudioContext={setAudioContext}
                />
            </div>
            
            {/* Fixed right panel for Amplifier */}
            {amplifierModule && (
                <div style={{
                    width: '200px',
                    height: '100%',
                    background: '#1a1a1a',
                    borderLeft: '2px solid #444',
                    flexShrink: 0
                }}>
                    <Amplifier
                        module={amplifierModule}
                        onOutputClick={handleOutputClick}
                        isConnecting={connectingFrom?.moduleId === 'amplifier-singleton'}
                        audioContext={audioContext}
                        setAudioContext={setAudioContext}
                        connections={connections}
                        hasEnvelopeConnection={hasEnvelopeConnection}
                        isFixed={true}
                        isPoweredOn={isPoweredOn}
                    />
                </div>
            )}

            </div>

            <Transport
                transportState={transportState}
                onLoadFile={handleSequenceLoad}
                onPlay={handleTransportPlay}
                onStop={handleTransportStop}
                onRewind={handleTransportRewind}
                onSelectChannel={handleTransportChannelSelect}
                isPendingPlay={pendingTransportPlay}
            />
        </div>
    );
}

function Toolbar({ addModule, isPoweredOn, togglePower }) {
    return (
        <div style={{
            height: `${toolbarHeight}px`,
            background: '#2a2a2a',
            borderBottom: '2px solid #444',
            display: 'flex',
            alignItems: 'center',
            padding: '0 20px',
            gap: '10px',
            zIndex: 1000,
            flexShrink: 0
        }}>
            <button onClick={() => addModule('oscillator')} style={buttonStyle}>
                + Oscillator
            </button>
            <button onClick={() => addModule('filter')} style={buttonStyle}>
                + Filter
            </button>
            <button onClick={() => addModule('envelope')} style={buttonStyle}>
                + Envelope
            </button>
            <button onClick={() => addModule('random')} style={buttonStyle}>
                + Random
            </button>
            <button onClick={() => addModule('mixer')} style={buttonStyle}>
                + Mixer
            </button>
            <button onClick={() => addModule('multi')} style={buttonStyle}>
                + Multi
            </button>
            <div style={{ marginLeft: 'auto' }}>
                <button 
                    onClick={togglePower}
                    style={{
                        ...buttonStyle,
                        background: isPoweredOn ? '#0a0' : '#444',
                        color: isPoweredOn ? '#000' : '#0f0',
                        fontWeight: 'bold',
                        border: isPoweredOn ? '2px solid #0f0' : '1px solid #666'
                    }}
                >
                    {isPoweredOn ? 'ON' : 'OFF'}
                </button>
            </div>
        </div>
    );
}

function Canvas({ 
    canvasRef, 
    modules, 
    connections, 
    connectingFrom, 
    tempConnection,
    onModuleDragStart, 
    onModuleDrag, 
    onModuleDragEnd,
    onOutputClick,
    onMouseMove,
    onClick,
    onRemoveConnection,
    audioContext,
    setAudioContext
}) {
    return (
        <div 
            ref={canvasRef}
            onMouseMove={onMouseMove}
            onClick={onClick}
            style={{
                width: '100%',
                height: '100%',
                position: 'relative',
                background: 'repeating-linear-gradient(0deg, transparent, transparent 19px, #222 19px, #222 20px), repeating-linear-gradient(90deg, transparent, transparent 19px, #222 19px, #222 20px)',
                backgroundSize: '20px 20px'
            }}
        >
            {modules.map(module => {
                // Skip amplifier and keyboard - they're rendered in the fixed right panel
                if (module.type === 'amplifier' || module.type === 'keyboard') {
                    return null;
                }
                
                if (module.type === 'oscillator') {
                    return (
                        <Oscillator
                            key={module.id}
                            module={module}
                            onDragStart={onModuleDragStart}
                            onDrag={onModuleDrag}
                            onDragEnd={onModuleDragEnd}
                            onOutputClick={onOutputClick}
                            isConnecting={connectingFrom?.moduleId === module.id}
                            audioContext={audioContext}
                            connections={connections}
                        />
                    );
                }
                
                if (module.type === 'filter') {
                    return (
                        <Filter
                            key={module.id}
                            module={module}
                            onDragStart={onModuleDragStart}
                            onDrag={onModuleDrag}
                            onDragEnd={onModuleDragEnd}
                            onOutputClick={onOutputClick}
                            isConnecting={connectingFrom?.moduleId === module.id}
                            audioContext={audioContext}
                            connections={connections}
                        />
                    );
                }
                
                if (module.type === 'random') {
                    return (
                        <RandomVoltageGenerator
                            key={module.id}
                            module={module}
                            onDragStart={onModuleDragStart}
                            onDrag={onModuleDrag}
                            onDragEnd={onModuleDragEnd}
                            onOutputClick={onOutputClick}
                            isConnecting={connectingFrom?.moduleId === module.id}
                            audioContext={audioContext}
                            connections={connections}
                        />
                    );
                }

                if (module.type === 'envelope') {
                    return (
                        <Envelope
                            key={module.id}
                            module={module}
                            onDragStart={onModuleDragStart}
                            onDrag={onModuleDrag}
                            onDragEnd={onModuleDragEnd}
                            onOutputClick={onOutputClick}
                            isConnecting={connectingFrom?.moduleId === module.id}
                            audioContext={audioContext}
                            connections={connections}
                        />
                    );
                }

                if (module.type === 'mixer') {
                    return (
                        <Mixer
                            key={module.id}
                            module={module}
                            onDragStart={onModuleDragStart}
                            onOutputClick={onOutputClick}
                            isConnecting={connectingFrom?.moduleId === module.id}
                            connections={connections}
                        />
                    );
                }

                if (module.type === 'multi') {
                    return (
                        <Multi
                            key={module.id}
                            module={module}
                            onDragStart={onModuleDragStart}
                            onOutputClick={onOutputClick}
                            isConnecting={connectingFrom?.moduleId === module.id}
                        />
                    );
                }
                
                return (
                    <Module
                        key={module.id}
                        module={module}
                        onDragStart={onModuleDragStart}
                        onDrag={onModuleDrag}
                        onDragEnd={onModuleDragEnd}
                        onOutputClick={onOutputClick}
                        isConnecting={connectingFrom?.moduleId === module.id}
                    />
                );
            })}
        </div>
    );
}

function Module({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting }) {
    return (
        <div
            draggable
            onDragStart={(e) => {
                e.preventDefault = () => {};
                onDragStart(e, module.id);
            }}
            onDrag={onDrag}
            onDragEnd={onDragEnd}
            style={{
                position: 'absolute',
                left: module.x,
                top: module.y,
                width: '150px',
                minHeight: '80px',
                background: '#333',
                border: '2px solid #555',
                borderRadius: '4px',
                padding: '10px',
                cursor: 'move',
                zIndex: 10,
                transition: 'none',
                boxShadow: '0 4px 8px rgba(0,0,0,0.3)'
            }}
        >
            <div style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '10px', color: '#0f0' }}>
                {module.type.toUpperCase()}
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {/* Inputs */}
                    <Port type="input" label="IN" />
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {/* Outputs */}
                    <Port 
                        type="output" 
                        label="OUT" 
                        onClick={() => onOutputClick(module.id, 'output')}
                        isConnecting={isConnecting}
                    />
                </div>
            </div>
        </div>
    );
}

function Port({ type, label, onClick, isConnecting }) {
    return (
        <div 
            onClick={onClick}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                cursor: onClick ? 'pointer' : 'default'
            }}
        >
            {type === 'input' && <span style={{ fontSize: '10px' }}>{label}</span>}
            <div style={{
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                background: isConnecting ? '#0f0' : (type === 'input' ? '#f00' : '#00f'),
                border: '1px solid #fff',
                transition: 'all 0.2s'
            }} />
            {type === 'output' && <span style={{ fontSize: '10px' }}>{label}</span>}
        </div>
    );
}

const buttonStyle = {
    padding: '8px 15px',
    background: '#444',
    border: '1px solid #666',
    borderRadius: '4px',
    color: '#0f0',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'inherit'
};

export default App;
