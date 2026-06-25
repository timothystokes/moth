import React, { useCallback, useEffect, useRef, useState } from 'react';
import exampleSong from '../example-song.json';
import AppSelect from './components/AppSelect.jsx';
import { COLOR_WIRE, COLOR_WIRE_DIM, COLOR_SLIDER } from './theme.js';
import ToolbarButton from './components/ToolbarButton.jsx';
import Amplifier from './components/Amplifier.jsx';
import Oscillator from './components/Oscillator.jsx';
import Filter from './components/Filter.jsx';
import Keyboard from './components/Keyboard.jsx';
import RandomVoltageGenerator from './components/RandomVoltageGenerator.jsx';
import Envelope from './components/Envelope.jsx';
import Mixer from './components/Mixer.jsx';
import Multi from './components/Multi.jsx';
import VCA from './components/VCA.jsx';
import Scope from './components/Scope.jsx';
import MFX from './components/MFX.jsx';
import Sampler from './components/Sampler.jsx';
import Transport from './components/Transport.jsx';
import NavDivider from './components/NavDivider.jsx';
import ControlBlock from './components/ControlBlock.jsx';
import PianoRoll from './components/PianoRoll.jsx';
import {
    clearAllModules,
    connectModules,
    disconnectInput,
    getModuleState,
    initializeAudioEngine,
    registerModule,
    removeTrack,
    setScopeTrack,
    subscribeToAudioEngineDiagnostics,
    subscribeToAudioEngineErrors,
    subscribeToVoiceStatus,
    upsertTrack
} from './audio/audioEngine.js';
import {
    buildNoteSegments,
    buildNotesFromMidiEvents,
    getMidiChannel,
    getMidiInputs,
    importMidiFile,
    initializeMidi,
    loadSession,
    updateSession,
    play,
    rewind,
    seekTo,
    selectMidiInput,
    setActiveTrack,
    setMidiChannel,
    stop,
    startRecording,
    stopRecording,
    getIsRecording,
    subscribeMidiStateChange,
    subscribeToTransport
} from './audio/sequencer.js';
import { midiToNoteName, absoluteBeatToBarBeat } from './audio/noteUtils.js';

const toolbarHeight = 54;

const initialTransportState = {
    hasSequence: false,
    durationMs: 0,
    trackCount: 0,
    tracks: [],
    isPlaying: false,
    playbackPositionMs: 0
};


// Data model for song/sequence
// Each track contains a flat notes[] array with absolute bar/beat-positioned notes.

const initialProjectSequence = {
    bpm: 120,
    ticksPerBeat: null,
    tempoMap: [],
    timeSignatures: []
};

const initialVoiceStatus = {
    capacityVoices: 0,
    activeVoices: 0,
    processingVoices: 0,
    activeTrackCount: 0,
    perTrack: []
};

let manualTrackCounter = 1;


function createManualTrack(name = `Track ${manualTrackCounter++}`) {
    return {
        id: `track-manual-${Date.now()}-${manualTrackCounter}`,
        name,
        notes: [],
        noteSegments: [],
        durationMs: 0,
        mix: {
            volume: 0.8,
            mute: false
        },
        modules: [],
        connections: []
    };
}


function createImportedTrack(trackData) {
    return {
        id: trackData.id,
        name: trackData.name,
        notes: trackData.notes ?? [],
        noteSegments: trackData.noteSegments ?? [],
        durationMs: trackData.durationMs ?? 0,
        mix: { volume: 0.8, mute: false },
        modules: [],
        connections: []
    };
}

function createProjectModuleStateLookup(moduleStates) {
    const lookup = new Map();

    if (!Array.isArray(moduleStates)) {
        return lookup;
    }

    moduleStates.forEach((entry) => {
        if (typeof entry?.moduleId === 'string' && entry.module) {
            lookup.set(entry.moduleId, entry.module);
        }
    });

    return lookup;
}

// Flatten legacy sequences+arrangement into a flat notes[] array.
// Used when loading old project files that haven't been migrated yet.
function migrateTrackToFlatNotes(track, timeSignatures = []) {
    if (Array.isArray(track?.notes)) return track.notes;
    const beatsPerBar = (Array.isArray(timeSignatures) && timeSignatures.length > 0)
        ? (timeSignatures[0]?.numerator ?? 4) : 4;
    const sequences = Array.isArray(track?.sequences) ? track.sequences : [];
    const arrangement = Array.isArray(track?.arrangement) ? track.arrangement : [];
    const notes = [];
    for (const entry of arrangement) {
        const seq = sequences.find(s => s.id === entry.sequenceId);
        if (!seq || !Array.isArray(seq.events)) continue;
        const seqLengthBeats = seq.events.reduce((max, ev) => {
            const startBeat = (ev.bar != null && ev.beat != null)
                ? (ev.bar - 1) * beatsPerBar + ev.beat : 0;
            return Math.max(max, startBeat + (ev.duration ?? ev.beats ?? 0.25));
        }, 0);
        const repeat = entry.repeat || 1;
        for (let rep = 0; rep < repeat; rep++) {
            const repOffset = entry.startBeat + rep * seqLengthBeats;
            for (const ev of seq.events) {
                if (!ev.note || ev.note === '-') continue;
                const duration = ev.duration ?? ev.beats ?? 0.25;
                const evBeat = (ev.bar != null && ev.beat != null)
                    ? (ev.bar - 1) * beatsPerBar + ev.beat : 0;
                const absoluteBeat = repOffset + evBeat;
                const newBar = Math.floor(absoluteBeat / beatsPerBar) + 1;
                const newBeat = Math.round((absoluteBeat % beatsPerBar) * 10000) / 10000;
                notes.push({ note: ev.note, bar: newBar, beat: newBeat, duration, velocity: ev.velocity ?? 0.8 });
            }
        }
    }
    return notes.sort((a, b) => {
        const aBeat = (a.bar - 1) * beatsPerBar + a.beat;
        const bBeat = (b.bar - 1) * beatsPerBar + b.beat;
        return aBeat - bBeat;
    });
}

function normalizeTrackModuleId(trackId, moduleId, fallbackSuffix = 'module') {
    if (moduleId === 'keyboard-singleton' || moduleId === 'track-output-singleton') {
        return moduleId;
    }

    if (typeof moduleId !== 'string' || !moduleId) {
        return `${trackId}:${fallbackSuffix}`;
    }

    if (moduleId.startsWith(`${trackId}:`)) {
        return moduleId;
    }

    return `${trackId}:${moduleId}`;
}

function normalizeTrack(track, index, moduleStateLookup = new Map(), timeSignatures = []) {
    // Support both new format (notes[]) and old saved format (sequences+arrangement)
    const notes = migrateTrackToFlatNotes(track, timeSignatures);
    const noteSegments = Array.isArray(track?.noteSegments) ? track.noteSegments
        : Array.isArray(track?.midi?.noteSegments) ? track.midi.noteSegments
        : [];
    const durationMs = Number.isFinite(track?.durationMs) ? track.durationMs
        : Number.isFinite(track?.midi?.durationMs) ? track.midi.durationMs
        : 0;

    const normalizedTrackId = typeof track?.id === 'string' && track.id ? track.id : `track-loaded-${Date.now()}-${index}`;
    const normalizedModules = Array.isArray(track?.modules)
        ? (() => {
            const typeCounters = {};
            return track.modules.map((module, moduleIndex) => {
                const type = typeof module?.type === 'string' ? module.type : 'module';
                typeCounters[type] = (typeCounters[type] || 0) + 1;
                const instanceNum = typeof module?.instanceNum === 'number' ? module.instanceNum : typeCounters[type];
                const originalModuleId = typeof module?.id === 'string' ? module.id : '';
                const normalizedModuleId = normalizeTrackModuleId(
                    normalizedTrackId,
                    originalModuleId,
                    `module-legacy-${index}-${moduleIndex}`
                );
                const fallbackState = moduleStateLookup.get(normalizedModuleId)
                    ?? moduleStateLookup.get(originalModuleId)
                    ?? null;

                return {
                    ...module,
                    id: normalizedModuleId,
                    instanceNum,
                    params: module?.params ?? fallbackState?.params ?? {}
                };
            });
        })()
        : [];
    const normalizedConnections = Array.isArray(track?.connections)
        ? track.connections
            .map((connection, connectionIndex) => {
                const fromModuleId = normalizeTrackModuleId(
                    normalizedTrackId,
                    connection?.from?.moduleId,
                    `connection-from-${index}-${connectionIndex}`
                );
                const toModuleId = normalizeTrackModuleId(
                    normalizedTrackId,
                    connection?.to?.moduleId,
                    `connection-to-${index}-${connectionIndex}`
                );

                return {
                    ...connection,
                    from: connection?.from
                        ? {
                            ...connection.from,
                            moduleId: fromModuleId
                        }
                        : null,
                    to: connection?.to
                        ? {
                            ...connection.to,
                            moduleId: toModuleId
                        }
                        : null
                };
            })
            .filter((connection) => connection.from?.moduleId && connection.to?.moduleId)
        : [];

    return {
        id: normalizedTrackId,
        name: typeof track?.name === 'string' && track.name ? track.name : `Track ${index + 1}`,
        polyphony: typeof track?.polyphony === 'number' ? Math.min(16, Math.max(1, Math.round(track.polyphony))) : 4,
        portamento: typeof track?.portamento === 'number' ? Math.min(2, Math.max(0, track.portamento)) : 0,
        notes,
        noteSegments,
        durationMs,
        mix: {
            volume: typeof track?.mix?.volume === 'number' ? Math.min(1, Math.max(0, track.mix.volume)) : 0.8,
            mute: Boolean(track?.mix?.mute),
            high: typeof track?.mix?.high === 'number' ? Math.max(-12, Math.min(12, track.mix.high)) : 0,
            mid: typeof track?.mix?.mid === 'number' ? Math.max(-12, Math.min(12, track.mix.mid)) : 0,
            low: typeof track?.mix?.low === 'number' ? Math.max(-12, Math.min(12, track.mix.low)) : 0,
            pan: typeof track?.mix?.pan === 'number' ? Math.max(-1, Math.min(1, track.mix.pan)) : 0,
        },
        modules: normalizedModules,
        connections: normalizedConnections
    };
}

function syncCountersFromTracks(projectTracks) {
    const highestManualTrackNumber = projectTracks.reduce((maximum, track) => {
        const match = typeof track?.name === 'string' ? track.name.match(/^Track\s+(\d+)$/) : null;
        return match ? Math.max(maximum, Number.parseInt(match[1], 10)) : maximum;
    }, 0);

    manualTrackCounter = Math.max(manualTrackCounter, highestManualTrackNumber + 1);
}

function buildSerializedProjectTracks(projectTracks) {
    return projectTracks.map(({ sequences: _seq, arrangement: _arr, noteSegments: _ns, ...track }) => ({
        ...track,
        mix: { ...track.mix, solo: undefined },
        modules: track.modules.map((module) => {
            const moduleState = getModuleState(module.id);
            return {
                ...module,
                params: moduleState?.params ?? module.params ?? {}
            };
        })
    }));
}

function resolveSourceModuleId(track, moduleId, outputId) {
    if (moduleId === 'keyboard-singleton') {
        if (outputId === 'cv-out') {
            return `${track.id}:keyboard-cv`;
        }

        if (outputId === 'gate-out') {
            return `${track.id}:keyboard-gate`;
        }

        if (outputId === 'velocity-out') {
            return `${track.id}:keyboard-velocity`;
        }
    }

    if (outputId === 'output-a' || outputId === 'output-b') {
        const sourceModule = track.modules.find((module) => module.id === moduleId);
        return sourceModule?.type === 'multi' ? moduleId : `${moduleId}-${outputId}`;
    }

    return moduleId;
}

function resolveDestinationModuleId(trackId, moduleId) {
    if (moduleId === 'track-output-singleton') {
        return `${trackId}:track-output`;
    }

    return moduleId;
}

function connectTrackConnection(track, connection) {
    connectModules(
        resolveSourceModuleId(track, connection.from.moduleId, connection.from.outputId),
        resolveDestinationModuleId(track.id, connection.to.moduleId),
        connection.to.outputId
    );
}

function disconnectTrackConnection(trackId, connection) {
    disconnectInput(resolveDestinationModuleId(trackId, connection.to.moduleId), connection.to.outputId);
}

function App() {
    const [tracks, setTracks] = useState(() => [createManualTrack('Track 1')]);
    const [selectedTrackId, setSelectedTrackId] = useState(null);
    const [overlayRefreshTick, setOverlayRefreshTick] = useState(0);
    const [draggedModule, setDraggedModule] = useState(null);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [connectingFrom, setConnectingFrom] = useState(null);
    const [tempConnection, setTempConnection] = useState(null);
    const [audioContext, setAudioContext] = useState(null);
    const audioContextRef = useRef(null); // sync ref so ensureAudioReady is stable
    const [audioError, setAudioError] = useState(null);
    const [transportState, setTransportState] = useState(initialTransportState);
    const [moduleUiRevision, setModuleUiRevision] = useState(0);
    const [isRecording, setIsRecording] = useState(false);
    const [projectSequence, setProjectSequence] = useState(initialProjectSequence);
    const [voiceStatus, setVoiceStatus] = useState(initialVoiceStatus);

    const canvasRef = useRef(null);
    const contentRef = useRef(null);
    const midiImportInputRef = useRef(null);
    const projectLoadInputRef = useRef(null);
    const previousTrackIdsRef = useRef(new Set());

    const [viewMode, setViewMode] = useState('voice'); // 'voice' | 'notes'
    const [notesViewport, setNotesViewport] = useState(null); // {startMs, endMs} or null

    const handleViewportChange = useCallback((vp) => {
        setNotesViewport(vp ?? null);
    }, []);

    const selectedTrack = tracks.find((track) => track.id === selectedTrackId) ?? tracks[0] ?? null;
    const effectiveSelectedTrackId = selectedTrack?.id ?? null;
    const selectedConnections = selectedTrack?.connections ?? [];
    const selectedModules = selectedTrack?.modules ?? [];

    useEffect(() => {
        if (!selectedTrackId && tracks[0]) {
            setSelectedTrackId(tracks[0].id);
        }
    }, [selectedTrackId, tracks]);

    useEffect(() => {
        const animationFrameId = window.requestAnimationFrame(() => {
            setOverlayRefreshTick((current) => current + 1);
        });

        return () => {
            window.cancelAnimationFrame(animationFrameId);
        };
    }, [effectiveSelectedTrackId, selectedModules, selectedConnections]);

    useEffect(() => {
        const unsubscribe = subscribeToTransport(setTransportState);
        return () => unsubscribe();
    }, []);

    useEffect(() => {
        const unsubscribe = subscribeToAudioEngineErrors((error) => {
            const nextMessage = error?.message || 'Audio engine error.';
            const phase = error?.context?.phase ? ` (${error.context.phase})` : '';
            setAudioError(`${nextMessage}${phase}`);
            setVoiceStatus(initialVoiceStatus);
            stop();
        });

        return () => unsubscribe();
    }, []);

    useEffect(() => {
        const unsubscribe = subscribeToVoiceStatus((nextVoiceStatus) => {
            setVoiceStatus({
                capacityVoices: Number.isFinite(nextVoiceStatus?.capacityVoices) ? nextVoiceStatus.capacityVoices : 0,
                activeVoices: Number.isFinite(nextVoiceStatus?.activeVoices) ? nextVoiceStatus.activeVoices : 0,
                processingVoices: Number.isFinite(nextVoiceStatus?.processingVoices) ? nextVoiceStatus.processingVoices : 0,
                activeTrackCount: Number.isFinite(nextVoiceStatus?.activeTrackCount) ? nextVoiceStatus.activeTrackCount : 0,
                perTrack: Array.isArray(nextVoiceStatus?.perTrack) ? nextVoiceStatus.perTrack : []
            });
        });

        return () => unsubscribe();
    }, []);

    useEffect(() => {
        const unsubscribe = subscribeToAudioEngineDiagnostics((diagnostic) => {
            const trackId = diagnostic?.context?.trackId ? ` track ${diagnostic.context.trackId}` : '';
            const moduleId = diagnostic?.context?.moduleId ? ` module ${diagnostic.context.moduleId}` : '';
            const phase = diagnostic?.context?.phase ? ` (${diagnostic.context.phase})` : '';
            const topContributors = Array.isArray(diagnostic?.context?.trackContributions)
                ? diagnostic.context.trackContributions
                    .map((entry) => `${entry.trackId}:${entry.sample.toFixed(3)}`)
                    .join(', ')
                : '';
            const contributorSuffix = topContributors ? ` [${topContributors}]` : '';
            setAudioError(`Audio diagnostic on${trackId}${moduleId}: ${diagnostic?.type ?? 'runtime issue'}${phase}${contributorSuffix}`);

            if (diagnostic?.severity === 'fatal') {
                stop();
            }
        });

        return () => unsubscribe();
    }, []);

    useEffect(() => {
        setActiveTrack(effectiveSelectedTrackId);
        setScopeTrack(effectiveSelectedTrackId);
    }, [effectiveSelectedTrackId]);

    // When switching back to voice mode, wait for the DOM to settle then redraw wires
    useEffect(() => {
        if (viewMode === 'voice') {
            const id = requestAnimationFrame(() => setOverlayRefreshTick(t => t + 1));
            return () => cancelAnimationFrame(id);
        }
    }, [viewMode]);

    useEffect(() => {
        const currentTrackIds = new Set(tracks.map((track) => track.id));
        const anySolo = tracks.some((t) => t.mix?.solo);

        tracks.forEach((track) => {
            registerModule(`${track.id}:keyboard-cv`, { type: 'keyboard-cv', params: {} });
            registerModule(`${track.id}:keyboard-gate`, { type: 'keyboard-gate', params: {} });
            registerModule(`${track.id}:keyboard-velocity`, { type: 'keyboard-velocity', params: {} });
            registerModule(`${track.id}:track-output`, { type: 'track-output', params: {} });
            const effectiveMute = track.mix.mute || (anySolo && !track.mix?.solo);
            upsertTrack(track.id, {
                volume: track.mix.volume,
                mute: effectiveMute,
                polyphony: track.polyphony ?? 4,
                portamento: track.portamento ?? 0,
                high: track.mix.high ?? 0,
                mid: track.mix.mid ?? 0,
                low: track.mix.low ?? 0,
                pan: track.mix.pan ?? 0,
            });

            track.connections.forEach((connection) => {
                connectTrackConnection(track, connection);
            });
        });

        previousTrackIdsRef.current.forEach((trackId) => {
            if (!currentTrackIds.has(trackId)) {
                removeTrack(trackId);
            }
        });

        previousTrackIdsRef.current = currentTrackIds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        // Deliberately exclude module x/y positions — they are visual only and must not trigger audio graph rebuilds.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        tracks.map(t => JSON.stringify({
            id: t.id,
            mute: t.mix?.mute,
            solo: t.mix?.solo,
            polyphony: t.polyphony,
            portamento: t.portamento,
            connections: t.connections,
            modules: t.modules.map(m => ({ id: m.id, type: m.type }))
        })).join('|')
    ]);

    // Ensure AudioContext is created and worklet initialized — safe to call from any user gesture
    const ensureAudioReady = useCallback(async () => {
        if (!audioContextRef.current) {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            audioContextRef.current = ctx;
            setAudioContext(ctx);
            await initializeAudioEngine(ctx);
        } else if (audioContextRef.current.state === 'suspended') {
            await audioContextRef.current.resume();
        }
    }, []);

    // Auto-init on first user gesture so audio is ready before explicit actions
    useEffect(() => {
        const handler = () => {
            ensureAudioReady().catch(console.error);
            document.removeEventListener('mousedown', handler, true);
            document.removeEventListener('keydown', handler, true);
        };
        document.addEventListener('mousedown', handler, true);
        document.addEventListener('keydown', handler, true);
        return () => {
            document.removeEventListener('mousedown', handler, true);
            document.removeEventListener('keydown', handler, true);
        };
    }, [ensureAudioReady]);

    // Initialise worklet when audioContext is set (e.g. after load)
    useEffect(() => {
        if (audioContext) initializeAudioEngine(audioContext).catch(console.error);
    }, [audioContext]);

    useEffect(() => {
        const handleGlobalMouseMove = (event) => {
            if (!draggedModule || !selectedTrack) {
                return;
            }

            const canvasRect = canvasRef.current?.getBoundingClientRect();
            if (!canvasRect) {
                return;
            }

            setTracks((previousTracks) => previousTracks.map((track) => {
                if (track.id !== selectedTrack.id) {
                    return track;
                }

                return {
                    ...track,
                    modules: track.modules.map((module) => (
                        module.id === draggedModule
                            ? {
                                ...module,
                                x: event.clientX - canvasRect.left - dragOffset.x,
                                y: event.clientY - canvasRect.top - dragOffset.y
                            }
                            : module
                    ))
                };
            }));
        };

        const handleGlobalMouseUp = () => {
            setDraggedModule(null);
        };

        window.addEventListener('mousemove', handleGlobalMouseMove);
        window.addEventListener('mouseup', handleGlobalMouseUp);

        return () => {
            window.removeEventListener('mousemove', handleGlobalMouseMove);
            window.removeEventListener('mouseup', handleGlobalMouseUp);
        };
    }, [draggedModule, dragOffset, selectedTrack]);

    const updateTrack = (trackId, updater) => {
        setTracks((previousTracks) => previousTracks.map((track) => (
            track.id === trackId ? updater(track) : track
        )));
    };

    const handleModuleDragStart = (event, moduleId) => {
        event.preventDefault();
        if (!selectedTrack) {
            return;
        }

        const module = selectedTrack.modules.find((entry) => entry.id === moduleId);
        if (!module) {
            return;
        }

        const canvasRect = canvasRef.current?.getBoundingClientRect();
        if (!canvasRect) return;

        setDraggedModule(moduleId);
        setDragOffset({
            x: event.clientX - canvasRect.left - module.x,
            y: event.clientY - canvasRect.top - module.y
        });
    };

    const handleOutputClick = (moduleId, outputId, position) => {
        if (!selectedTrack) {
            return;
        }

        if (connectingFrom) {
            const fromPort = document.querySelector(`[data-module-id="${connectingFrom.moduleId}"][data-port-id="${connectingFrom.outputId}"]`);
            const toPort = document.querySelector(`[data-module-id="${moduleId}"][data-port-id="${outputId}"]`);

            if (!fromPort || !toPort) {
                setConnectingFrom(null);
                setTempConnection(null);
                return;
            }

            const fromPortType = fromPort.getAttribute('data-port-type');
            const toPortType = toPort.getAttribute('data-port-type');

            let outputModuleId;
            let outputPortId;
            let inputModuleId;
            let inputPortId;

            if (fromPortType === 'output' && toPortType === 'input') {
                outputModuleId = connectingFrom.moduleId;
                outputPortId = connectingFrom.outputId;
                inputModuleId = moduleId;
                inputPortId = outputId;
            } else if (fromPortType === 'input' && toPortType === 'output') {
                outputModuleId = moduleId;
                outputPortId = outputId;
                inputModuleId = connectingFrom.moduleId;
                inputPortId = connectingFrom.outputId;
            } else {
                setConnectingFrom(null);
                setTempConnection(null);
                return;
            }

            const existingConnection = selectedConnections.find(
                (connection) => connection.to.moduleId === inputModuleId && connection.to.outputId === inputPortId
            );

            if (existingConnection) {
                disconnectTrackConnection(selectedTrack.id, existingConnection);
            }

            const newConnection = {
                id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                from: { moduleId: outputModuleId, outputId: outputPortId, position: null },
                to: { moduleId: inputModuleId, outputId: inputPortId, position: null }
            };

            updateTrack(selectedTrack.id, (track) => ({
                ...track,
                connections: [
                    ...track.connections.filter((connection) => connection.id !== existingConnection?.id),
                    newConnection
                ]
            }));

            connectTrackConnection(selectedTrack, newConnection);
            setConnectingFrom(null);
            setTempConnection(null);
            return;
        }

        const existingInputConnection = selectedConnections.find(
            (connection) => connection.to.moduleId === moduleId && connection.to.outputId === outputId
        );
        const existingOutputConnection = selectedConnections.find(
            (connection) => connection.from.moduleId === moduleId && connection.from.outputId === outputId
        );
        const existingConnection = existingInputConnection || existingOutputConnection;

        if (existingConnection) {
            disconnectTrackConnection(selectedTrack.id, existingConnection);
            updateTrack(selectedTrack.id, (track) => ({
                ...track,
                connections: track.connections.filter((connection) => connection.id !== existingConnection.id)
            }));
        }

        setConnectingFrom({ moduleId, outputId, position });
    };

    const handleCanvasMouseMove = (event) => {
        if (!connectingFrom || !canvasRef.current) {
            return;
        }

        const rect = canvasRef.current.getBoundingClientRect();
        setTempConnection({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top
        });
    };

    const handleCanvasClick = (event) => {
        if (connectingFrom && event.target === canvasRef.current) {
            setConnectingFrom(null);
            setTempConnection(null);
        }
    };

    const addModule = (type) => {
        if (!selectedTrack) {
            return;
        }
        const trackId = selectedTrack.id;
        updateTrack(trackId, (track) => {
            const existing = track.modules.filter((m) => m.type === type);
            const maxNum = existing.reduce((max, m) => Math.max(max, m.instanceNum ?? 0), 0);
            const instanceNum = maxNum + 1;
            const moduleId = `${trackId}:${type}-${instanceNum}`;
            return {
                ...track,
                modules: [...track.modules, {
                    id: moduleId,
                    type,
                    instanceNum,
                    x: 100 + track.modules.length * 40,
                    y: 100 + track.modules.length * 24
                }]
            };
        });
    };

    const removeConnection = (connectionId) => {
        if (!selectedTrack) {
            return;
        }

        const connection = selectedConnections.find((entry) => entry.id === connectionId);
        if (!connection) {
            return;
        }

        disconnectTrackConnection(selectedTrack.id, connection);
        updateTrack(selectedTrack.id, (track) => ({
            ...track,
            connections: track.connections.filter((entry) => entry.id !== connectionId)
        }));
    };

    const handleSequenceLoad = async (file) => {
        const importedSession = await importMidiFile(file);
        const importedTracks = importedSession.tracks.map(createImportedTrack);
        syncCountersFromTracks(importedTracks);
        setProjectSequence({
            bpm: importedSession.bpm ?? 120,
            ticksPerBeat: importedSession.ticksPerBeat ?? null,
            tempoMap: importedSession.tempoMap ?? [],
            timeSignatures: importedSession.timeSignatures ?? []
        });
        loadSession({
            bpm: importedSession.bpm ?? 120,
            ticksPerBeat: importedSession.ticksPerBeat ?? null,
            tempoMap: importedSession.tempoMap ?? [],
            timeSignatures: importedSession.timeSignatures ?? []
        }, importedTracks);
        setTracks(importedTracks);
        setSelectedTrackId(importedTracks[0]?.id ?? null);
        return importedSession;
    };

    const handleProjectSave = () => {
        const serializedTracks = buildSerializedProjectTracks(tracks);
        const projectState = {
            version: 1,
            savedAt: new Date().toISOString(),
            sequence: projectSequence,
            selectedTrackId: effectiveSelectedTrackId,
            tracks: serializedTracks
        };

        const blob = new Blob([JSON.stringify(projectState, null, 2)], { type: 'application/json' });
        const objectUrl = window.URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = 'moth1-project.json';
        anchor.click();
        window.URL.revokeObjectURL(objectUrl);
    };

    const loadProjectData = useCallback((parsedProject) => {
        if (!Array.isArray(parsedProject?.tracks)) {
            throw new Error('Invalid project file: expected a tracks array.');
        }

        const moduleStateLookup = createProjectModuleStateLookup(parsedProject.moduleStates);
        const timeSignatures = Array.isArray(parsedProject.sequence?.timeSignatures)
            ? parsedProject.sequence.timeSignatures : [];
        const loadedTracks = parsedProject.tracks.map((track, index) => normalizeTrack(track, index, moduleStateLookup, timeSignatures));
        syncCountersFromTracks(loadedTracks);

        const nextProjectSequence = {
            bpm: parsedProject.sequence?.bpm ?? parsedProject.sequence?.tempoMap?.[0]?.bpm ?? 120,
            ticksPerBeat: parsedProject.sequence?.ticksPerBeat ?? null,
            tempoMap: Array.isArray(parsedProject.sequence?.tempoMap) ? parsedProject.sequence.tempoMap : [],
            timeSignatures: Array.isArray(parsedProject.sequence?.timeSignatures) ? parsedProject.sequence.timeSignatures : []
        };

        clearAllModules();

        loadedTracks.forEach((track) => {
            track.modules.forEach((module) => {
                registerModule(module.id, {
                    type: module.type,
                    params: module.params ?? {}
                });
            });
        });

        const nextSelectedTrackId = loadedTracks.some((track) => track.id === parsedProject.selectedTrackId)
            ? parsedProject.selectedTrackId
            : loadedTracks[0]?.id ?? null;

        setProjectSequence(nextProjectSequence);
        const sessionState = loadSession(nextProjectSequence, loadedTracks);
        // Sync computed noteSegments (from notes[]) back into React track state
        const tracksWithSegments = loadedTracks.map(track => {
            const sessionTrack = sessionState.tracks.find(t => t.id === track.id);
            return sessionTrack ? { ...track, noteSegments: sessionTrack.noteSegments, durationMs: sessionTrack.durationMs } : track;
        });
        setTracks(tracksWithSegments);
        setSelectedTrackId(nextSelectedTrackId);
        setModuleUiRevision((current) => current + 1);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Load example song on initial mount, or a song specified by URL hash (e.g. #ai-song.json)
    useEffect(() => {
        const hash = window.location.hash.slice(1); // strip leading '#'
        if (hash) {
            fetch(hash)
                .then((res) => {
                    if (!res.ok) throw new Error(`Failed to load "${hash}": ${res.status} ${res.statusText}`);
                    return res.json();
                })
                .then((data) => loadProjectData(data))
                .catch((err) => {
                    console.error(err);
                    loadProjectData(exampleSong);
                });
        } else {
            loadProjectData(exampleSong);
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const handleProjectLoad = async (file) => {
        stop();
        const rawText = await file.text();
        const parsedProject = JSON.parse(rawText);
        loadProjectData(parsedProject);
    };

    const handleReset = () => {
        stop();
        clearAllModules();
        const emptyTrack = createManualTrack('Track 1');
        manualTrackCounter = 2;
        const emptySequence = { ...initialProjectSequence };
        setProjectSequence(emptySequence);
        loadSession(emptySequence, [emptyTrack]);
        setTracks([emptyTrack]);
        setSelectedTrackId(emptyTrack.id);
        setModuleUiRevision((current) => current + 1);
    };

    const handleTransportPlay = async () => {
        if (!transportState.hasSequence) {
            throw new Error('No sequence loaded. Import a MIDI file or add sequences to tracks.');
        }
        await ensureAudioReady();
        await play();
    };

    const handleTransportStop = () => {
        if (isRecording) handleStopRecording();
        stop();
    };

    const handleTransportRewind = () => {
        if (isRecording) handleStopRecording();
        rewind();
    };

    const handleStopRecording = () => {
        const recorded = stopRecording();
        setIsRecording(false);
        if (!recorded || recorded.notes.length === 0 || !selectedTrackId) return;

        const bpm = projectSequence.bpm ?? 120;
        const msPerBeat = 60000 / bpm;
        const timeSignatures = projectSequence.timeSignatures ?? [];

        const newNotes = recorded.notes.map(({ noteNumber, velocity, startMs, durationMs }) => {
            const startBeat = startMs / msPerBeat;
            const { bar, beat } = absoluteBeatToBarBeat(startBeat, timeSignatures);
            const duration = Math.max(0.0625, durationMs / msPerBeat);
            return { note: midiToNoteName(noteNumber), bar, beat, duration, velocity };
        });

        const nextTracks = tracks.map((track) => {
            if (track.id !== selectedTrackId) return track;
            const existing = (track.notes ?? []).filter(n => {
                const noteBeat = (n.bar - 1) * 4 + n.beat;
                const noteMs = noteBeat * msPerBeat;
                return noteMs < recorded.startMs || noteMs >= recorded.endMs;
            });
            return { ...track, notes: [...existing, ...newNotes] };
        });

        const sessionState = updateSession(projectSequence, nextTracks);
        const synced = nextTracks.map(track => {
            const st = sessionState.tracks.find(t => t.id === track.id);
            return st ? { ...track, noteSegments: st.noteSegments, durationMs: st.durationMs } : track;
        });
        setTracks(synced);
    };

    const handleToggleRecord = async () => {
        if (isRecording) {
            handleStopRecording();
        } else {
            await ensureAudioReady();
            startRecording();
            setIsRecording(true);
        }
    };

    const handleSelectTrack = (trackId) => {
        setSelectedTrackId(trackId);
    };

    const handleUpdateTrackMix = (trackId, patch) => {
        updateTrack(trackId, (track) => ({
            ...track,
            mix: { ...track.mix, ...patch }
        }));
        // Send audio params directly — bypasses the module-registration effect to avoid recompile
        const track = tracks.find(t => t.id === trackId);
        if (track) {
            const mix = { ...track.mix, ...patch };
            const anySolo = tracks.some(t => t.mix?.solo || (t.id === trackId && patch.solo));
            upsertTrack(trackId, {
                volume: mix.volume ?? track.mix?.volume ?? 0.8,
                mute: mix.mute || (anySolo && !mix.solo) || false,
                polyphony: track.polyphony ?? 4,
                portamento: track.portamento ?? 0,
                high: mix.high ?? 0,
                mid: mix.mid ?? 0,
                low: mix.low ?? 0,
                pan: mix.pan ?? 0,
            });
        }
    };

    const handleCreateTrack = () => {
        const newTrack = createManualTrack();
        setTracks((previousTracks) => [...previousTracks, newTrack]);
        setSelectedTrackId(newTrack.id);
    };

    const handleRemoveTrack = (trackId) => {
        const nextTracks = tracks.filter((track) => track.id !== trackId);
        setTracks(nextTracks);
        loadSession(projectSequence, nextTracks);
        if (selectedTrackId === trackId) {
            setSelectedTrackId(nextTracks[0]?.id ?? null);
        }
    };

    const handleRenameTrack = (trackId, newName) => {
        const trimmed = newName.trim();
        if (!trimmed) return;
        setTracks((prev) => prev.map((t) => t.id === trackId ? { ...t, name: trimmed } : t));
    };

    const handleUpdatePolyphony = (trackId, polyphony) => {
        updateTrack(trackId, (track) => ({ ...track, polyphony }));
        upsertTrack(trackId, {
            volume: selectedTrack?.mix?.volume ?? 0.8,
            mute: selectedTrack?.mix?.mute ?? false,
            polyphony,
            portamento: selectedTrack?.portamento ?? 0,
        });
    };

    const handleNotesChange = (newNotes) => {
        if (!selectedTrack) return;
        const nextTracks = tracks.map((t) =>
            t.id === selectedTrack.id ? { ...t, notes: newNotes } : t
        );
        const sessionState = updateSession(projectSequence, nextTracks);
        const synced = nextTracks.map(track => {
            const st = sessionState.tracks.find(t => t.id === track.id);
            return st ? { ...track, noteSegments: st.noteSegments, durationMs: st.durationMs } : track;
        });
        setTracks(synced);
    };

    const handleUpdatePortamento = (trackId, portamento) => {
        updateTrack(trackId, (track) => ({ ...track, portamento }));
        upsertTrack(trackId, {
            volume: selectedTrack?.mix?.volume ?? 0.8,
            mute: selectedTrack?.mix?.mute ?? false,
            polyphony: selectedTrack?.polyphony ?? 4,
            portamento,
        });
    };

    const handleMidiImportChange = async (event) => {
        const file = event.target.files?.[0];

        if (!file) {
            return;
        }

        try {
            await handleSequenceLoad(file);
        } catch (error) {
            console.error('Failed to import MIDI file:', error);
        } finally {
            event.target.value = '';
        }
    };

    const handleProjectLoadChange = async (event) => {
        const file = event.target.files?.[0];

        if (!file) {
            return;
        }

        try {
            await handleProjectLoad(file);
        } catch (error) {
            console.error('Failed to load project file:', error);
        } finally {
            event.target.value = '';
        }
    };

    // Remove a module and all its connections
    const removeModule = (moduleId) => {
        if (!selectedTrack) return;
        updateTrack(selectedTrack.id, (track) => ({
            ...track,
            modules: track.modules.filter((m) => m.id !== moduleId),
            connections: track.connections.filter(
                (c) => c.from.moduleId !== moduleId && c.to.moduleId !== moduleId
            )
        }));
    };

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative', display: 'flex', flexDirection: 'column', background: '#101010' }}>
            <input
                ref={midiImportInputRef}
                type="file"
                accept=".mid,.midi,audio/midi,audio/x-midi"
                onChange={handleMidiImportChange}
                style={{ display: 'none' }}
            />
            <input
                ref={projectLoadInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleProjectLoadChange}
                style={{ display: 'none' }}
            />

            <Toolbar
                addModule={addModule}
                hasSelectedTrack={Boolean(selectedTrack)}
                audioError={audioError}
                onImportMidi={() => midiImportInputRef.current?.click()}
                onLoadProject={() => projectLoadInputRef.current?.click()}
                onSaveProject={handleProjectSave}
                onResetProject={handleReset}
                viewMode={viewMode}
                setViewMode={setViewMode}
                selectedTrack={selectedTrack}
                onUpdatePolyphony={handleUpdatePolyphony}
                onUpdatePortamento={handleUpdatePortamento}
            />

            <div ref={contentRef} style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0 }} onMouseMove={handleCanvasMouseMove}>
                {/* Wire overlay — only in VOICE mode; absolutely covers contentRef so coords match */}
                {viewMode === 'voice' && <svg key={overlayRefreshTick} style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    zIndex: 9999
                }}>
                    {selectedConnections.map((connection) => {
                        const fromPort = document.querySelector(`[data-module-id="${connection.from.moduleId}"][data-port-id="${connection.from.outputId}"]`);
                        const toPort = document.querySelector(`[data-module-id="${connection.to.moduleId}"][data-port-id="${connection.to.outputId}"]`);
                        const contentRect = contentRef.current?.getBoundingClientRect();

                        if (!fromPort || !toPort || !contentRect) {
                            return null;
                        }

                        const fromRect = fromPort.getBoundingClientRect();
                        const toRect = toPort.getBoundingClientRect();
                        const x1 = fromRect.left - contentRect.left + fromRect.width / 2;
                        const y1 = fromRect.top - contentRect.top + fromRect.height / 2;
                        const x2 = toRect.left - contentRect.left + toRect.width / 2;
                        const y2 = toRect.top - contentRect.top + toRect.height / 2;

                        return (
                            <g key={connection.id}>
                                <path
                                    d={`M ${x1} ${y1} C ${x1 + 50} ${y1}, ${x2 - 50} ${y2}, ${x2} ${y2}`}
                                    stroke={COLOR_WIRE}
                                    strokeWidth="2"
                                    fill="none"
                                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        removeConnection(connection.id);
                                    }}
                                />
                                <circle cx={x1} cy={y1} r="4" fill={COLOR_WIRE} style={{ pointerEvents: 'none' }} />
                                <circle cx={x2} cy={y2} r="4" fill={COLOR_WIRE} style={{ pointerEvents: 'none' }} />
                            </g>
                        );
                    })}

                    {connectingFrom && tempConnection && (() => {
                        const fromPort = document.querySelector(`[data-module-id="${connectingFrom.moduleId}"][data-port-id="${connectingFrom.outputId}"]`);
                        const contentRect = contentRef.current?.getBoundingClientRect();
                        if (!fromPort || !contentRect) {
                            return null;
                        }

                        const fromRect = fromPort.getBoundingClientRect();
                        const canvasRect = canvasRef.current?.getBoundingClientRect();
                        const x1 = fromRect.left - contentRect.left + fromRect.width / 2;
                        const y1 = fromRect.top - contentRect.top + fromRect.height / 2;
                        const x2 = canvasRect ? canvasRect.left - contentRect.left + tempConnection.x : tempConnection.x;
                        const y2 = canvasRect ? canvasRect.top - contentRect.top + tempConnection.y : tempConnection.y;

                        return (
                            <path
                                d={`M ${x1} ${y1} L ${x2} ${y2}`}
                                stroke={COLOR_WIRE_DIM}
                                strokeWidth="2"
                                fill="none"
                                strokeDasharray="5,5"
                            />
                        );
                    })()}
                </svg>}

                {/* Main row: changes based on view mode */}
                <div style={{ flex: 1, position: 'relative', display: 'flex', minHeight: 0 }}>
                    {viewMode === 'notes' ? (
                        // NOTES mode: full-width piano roll with integrated keyboard
                        <PianoRoll
                            track={selectedTrack}
                            timeSignatures={projectSequence.timeSignatures}
                            bpm={projectSequence.bpm ?? 120}
                            onNotesChange={handleNotesChange}
                            selectedTrackId={effectiveSelectedTrackId}
                            onViewportChange={handleViewportChange}
                        />
                    ) : (
                        // VOICE mode: keyboard | canvas | amplifier
                        <>
                            <div style={{ width: '80px', height: '100%', background: '#1a1a1a', borderRight: '2px solid #444', flexShrink: 0 }}>
                                <Keyboard
                                    module={{ id: 'keyboard-singleton' }}
                                    onOutputClick={handleOutputClick}
                                    isConnecting={connectingFrom?.moduleId === 'keyboard-singleton'}
                                    isFixed={true}
                                    selectedTrackId={effectiveSelectedTrackId}
                                    selectedTrackLabel={selectedTrack?.name ?? null}
                                />
                            </div>

                            <div style={{ flex: 1, position: 'relative', minWidth: 0, display: 'flex' }}>
                                <Canvas
                                    canvasRef={canvasRef}
                                    modules={selectedModules}
                                    connections={selectedConnections}
                                    connectingFrom={connectingFrom}
                                    onModuleDragStart={handleModuleDragStart}
                                    onOutputClick={handleOutputClick}
                                    onMouseMove={handleCanvasMouseMove}
                                    onClick={handleCanvasClick}
                                    audioContext={audioContext}
                                    moduleUiRevision={moduleUiRevision}
                                    onRemove={removeModule}
                                />
                                {/* Floating module add buttons — bottom-right of grid */}
                                <div style={{
                                    position: 'absolute',
                                    bottom: 10,
                                    right: 10,
                                    display: 'flex',
                                    gap: 4,
                                    flexWrap: 'nowrap',
                                    zIndex: 20,
                                }}>
                                    {[
                                        ['oscillator', 'VCO'],
                                        ['filter', 'VCF'],
                                        ['envelope', 'ENV'],
                                        ['random', 'RND'],
                                        ['mixer', 'MIX'],
                                        ['multi', 'MUL'],
                                        ['vca', 'VCA'],
                                        ['mfx', 'MFX'],
                                        ['sampler', 'SAM'],
                                        ['scope', 'SCO'],
                                    ].map(([type, label]) => (
                                        <ToolbarButton
                                            key={type}
                                            onClick={() => addModule(type)}
                                            disabled={!selectedTrack}
                                        >+ {label}</ToolbarButton>
                                    ))}
                                </div>
                            </div>

                            <div style={{ width: '80px', height: '100%', background: '#1a1a1a', borderLeft: '2px solid #444', flexShrink: 0 }}>
                                <Amplifier
                                    onOutputClick={handleOutputClick}
                                    isConnecting={connectingFrom?.moduleId === 'track-output-singleton'}
                                    isFixed={true}
                                    selectedTrack={selectedTrack}
                                    onUpdateMix={handleUpdateTrackMix}
                                />
                            </div>
                        </>
                    )}
                </div>{/* end main row */}
            </div>

            <Transport
                transportState={transportState}
                tracks={tracks}
                selectedTrackId={effectiveSelectedTrackId}
                onPlay={handleTransportPlay}
                onStop={handleTransportStop}
                onRewind={handleTransportRewind}
                onSelectTrack={handleSelectTrack}
                onUpdateTrackMix={handleUpdateTrackMix}
                onCreateTrack={handleCreateTrack}
                onRemoveTrack={handleRemoveTrack}
                onRenameTrack={handleRenameTrack}
                isPendingPlay={false}
                onSetTransportPosition={seekTo}
                isRecording={isRecording}
                onRecord={handleToggleRecord}
                notesViewport={viewMode === 'notes' ? notesViewport : null}
                bpm={projectSequence.bpm ?? 120}
                onBpmChange={(newBpm) => {
                    const updated = { ...projectSequence, bpm: newBpm };
                    setProjectSequence(updated);
                    updateSession(updated, tracks);
                }}
            />
        </div>
    );
}

function MidiSelector() {
    const [midiInputs, setMidiInputs] = React.useState([]);
    const [selectedId, setSelectedId] = React.useState('');
    const [channel, setChannelState] = React.useState('all');

    useEffect(() => {
        initializeMidi().then(() => {
            const inputs = getMidiInputs();
            setMidiInputs(inputs);
            if (inputs.length > 0) { setSelectedId(inputs[0].id); selectMidiInput(inputs[0].id); }
            const ch = getMidiChannel();
            setChannelState(ch == null ? 'all' : String(ch));
        });
        return subscribeMidiStateChange((inputs) => setMidiInputs(inputs));
    }, []);

    const handleDevice = (e) => {
        const id = e.target.value;
        setSelectedId(id);
        selectMidiInput(id);
    };

    const handleChannel = (e) => {
        const val = e.target.value;
        setChannelState(val);
        setMidiChannel(val === 'all' ? null : parseInt(val, 10));
    };

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AppSelect label="MIDI" style={{ width: 180 }} wrapperStyle={{ marginBottom: 0 }} value={selectedId} onChange={handleDevice}>
                {midiInputs.length === 0 && <option value="">No MIDI devices</option>}
                {midiInputs.map(inp => <option key={inp.id} value={inp.id}>{inp.name}</option>)}
            </AppSelect>
            <AppSelect style={{ width: 140 }} value={channel} onChange={handleChannel}>
                <option value="all">All Channels</option>
                {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}
            </AppSelect>
        </div>
    );
}

function Toolbar({ addModule, hasSelectedTrack, audioError, onImportMidi, onLoadProject, onSaveProject, onResetProject, viewMode, setViewMode, selectedTrack, onUpdatePolyphony, onUpdatePortamento }) {
    return (
        <div style={{
            height: `${toolbarHeight}px`,
            background: '#222222',
            borderBottom: '2px solid #444',
            display: 'flex',
            alignItems: 'center',
            padding: '0 10px',
            gap: '0',
            zIndex: 1000,
            flexShrink: 0,
            overflow: 'visible',
            position: 'relative',
        }}>
            {/* App title */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                <img src={`${import.meta.env.BASE_URL}moth.svg`} alt="moth" style={{ height: 44, width: 'auto', display: 'block', opacity: 0.9 }} />
                <b style={{ fontSize: '14px', letterSpacing: '0.15em' }}>MOTH</b>
            </div>
            <NavDivider />

            {/* Track name + polyphony */}
            {selectedTrack ? (
                <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingRight: '12px', flexShrink: 0 }}>
                        <span style={{ color: '#8adb8a', fontSize: '16px', letterSpacing: '0.06em' }}>{selectedTrack.name}</span>
                    </div>
                </>
            ) : (
                <div style={{ display: 'flex', alignItems: 'center', paddingRight: '12px' }}>
                    <span style={{ color: '#444', fontSize: '11px', letterSpacing: '0.06em' }}>no track</span>
                </div>
            )}

            {/* View tabs — folder tabs, bottom-aligned, active merges into content */}
            {(['voice', 'notes']).map((mode) => {
                const isActive = viewMode === mode;
                return (
                    <button
                        key={mode}
                        onClick={() => setViewMode(mode)}
                        style={{
                            padding: '0 18px',
                            fontSize: '11px',
                            fontWeight: 600,
                            letterSpacing: '0.1em',
                            textTransform: 'uppercase',
                            fontFamily: 'inherit',
                            cursor: 'pointer',
                            flexShrink: 0,
                            alignSelf: 'flex-end',
                            height: isActive ? `${toolbarHeight - 6}px` : `${toolbarHeight - 14}px`,
                            marginBottom: isActive ? '-2px' : '0',
                            background: isActive ? '#101010' : '#1c1c1c',
                            color: isActive ? '#e0e0e0' : '#505050',
                            border: '1px solid #444',
                            borderBottom: isActive ? '2px solid #101010' : '1px solid #444',
                            borderRadius: '5px 5px 0 0',
                            marginLeft: mode === 'voice' ? '10px' : '3px',
                            zIndex: isActive ? 1001 : 999,
                            position: 'relative',
                            transition: 'background 0.12s, color 0.12s',
                        }}
                    >
                        {mode}
                    </button>
                );
            })}

            {/* Right-side tools */}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', alignSelf: 'stretch', minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                    {(selectedTrack.polyphony ?? 4) === 1 && (
                            <ControlBlock label="PORTA" value={`${(selectedTrack.portamento ?? 0).toFixed(2)}s`}>
                                <input
                                    type="range" min="0" max="2" step="0.01"
                                    value={selectedTrack.portamento ?? 0}
                                    onChange={(e) => onUpdatePortamento(selectedTrack.id, parseFloat(e.target.value))}
                                    style={{ width: '80px', cursor: 'pointer', accentColor: COLOR_SLIDER }}
                                    title={`Portamento: ${(selectedTrack.portamento ?? 0).toFixed(2)}s`}
                                />
                            </ControlBlock>
                        )}
                        <AppSelect
                            label="POLY"
                            value={selectedTrack.polyphony ?? 4}
                            onChange={(e) => onUpdatePolyphony(selectedTrack.id, Number(e.target.value))}
                            style={{ width: '62px' }}
                            wrapperStyle={{ marginBottom: 0 }}
                            title="Voices (polyphony)"
                        >
                            {Array.from({ length: 16 }, (_, i) => i + 1).map(n => (
                                <option key={n} value={n}>{n}</option>
                            ))}
                        </AppSelect>
                        </div>
                        <NavDivider />

                <MidiSelector />
                <NavDivider />
                <div style={{ display: 'flex', gap: '8px' }}>
                    <ToolbarButton onClick={onLoadProject}>LOAD</ToolbarButton>
                    <ToolbarButton onClick={onSaveProject}>SAVE</ToolbarButton>
                    <ToolbarButton onClick={onResetProject}>RESET</ToolbarButton>
                    <ToolbarButton onClick={onImportMidi}>IMPORT</ToolbarButton>
                </div>

                {audioError && (
                    <div style={{
                        maxWidth: '420px',
                        padding: '6px 10px',
                        border: '1px solid #b44444',
                        borderRadius: '4px',
                        background: '#3a1616',
                        color: '#ffb0b0',
                        fontSize: '11px',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                    }} title={audioError}>
                        AUDIO ERROR: {audioError}
                    </div>
                )}
            </div>
        </div>
    );
}

function Canvas({ canvasRef, modules, connections, connectingFrom, onModuleDragStart, onOutputClick, onMouseMove, onClick, audioContext, moduleUiRevision, onRemove }) {
    const isFixed = (module) => module.id === 'keyboard-singleton' || module.id === 'track-output-singleton';

    const moduleComponents = {
        oscillator: Oscillator,
        filter: Filter,
        random: RandomVoltageGenerator,
        envelope: Envelope,
        mixer: Mixer,
        multi: Multi,
        vca: VCA,
        delay: MFX,
        mfx: MFX,
        sampler: Sampler,
        scope: Scope,
    };

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
            {modules.map((module) => {
                const Component = moduleComponents[module.type];
                if (!Component) return null;
                const removeProp = !isFixed(module) ? { onRemove: () => onRemove(module.id) } : {};
                return (
                    <div key={module.id} style={{ position: 'absolute', left: module.x, top: module.y }}>
                        <Component
                            key={`${module.id}:${moduleUiRevision}`}
                            module={module}
                            onDragStart={onModuleDragStart}
                            onOutputClick={onOutputClick}
                            isConnecting={connectingFrom?.moduleId === module.id}
                            audioContext={audioContext}
                            connections={connections}
                            isAudioReady={!!audioContext}
                            {...removeProp}
                        />
                    </div>
                );
            })}

            {modules.length === 0 && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4d4d4d', fontSize: '13px', letterSpacing: '0.04em' }}>
                    Add modules and patch them TO MIX to make this track audible.
                </div>
            )}
        </div>
    );
}

export default App;
