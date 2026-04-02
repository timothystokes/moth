import React, { useEffect, useRef, useState } from 'react';
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
import Delay from './components/Delay.jsx';
import MFX from './components/MFX.jsx';
import Transport from './components/Transport.jsx';
import PianoRoll from './components/PianoRoll.jsx';
import {
    clearAllModules,
    connectModules,
    disconnectInput,
    getModuleState,
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
    importMidiFile,
    loadSession,
    updateSession,
    play,
    rewind,
    seekTo,
    setActiveTrack,
    stop,
    startRecording,
    stopRecording,
    getIsRecording,
    subscribeToTransport
} from './audio/sequencer.js';
import { midiToNoteName, absoluteBeatToBarBeat } from './audio/noteUtils.js';

const toolbarHeight = 50;

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
    noteAffinedVoices: 0,
    releaseVoices: 0,
    processingVoices: 0,
    activeTrackCount: 0,
    perTrack: []
};

let manualTrackCounter = 1;
let moduleCounter = 1;


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
        ? track.modules.map((module, moduleIndex) => {
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
                params: module?.params ?? fallbackState?.params ?? {}
            };
        })
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
            mute: Boolean(track?.mix?.mute)
        },
        modules: normalizedModules,
        connections: normalizedConnections
    };
}

function syncCountersFromTracks(projectTracks) {
    const highestModuleCounter = projectTracks.reduce((maximum, track) => (
        track.modules.reduce((trackMaximum, module) => {
            const match = typeof module?.id === 'string' ? module.id.match(/:module-(\d+)$/) : null;
            return match ? Math.max(trackMaximum, Number.parseInt(match[1], 10)) : trackMaximum;
        }, maximum)
    ), 0);

    const highestManualTrackNumber = projectTracks.reduce((maximum, track) => {
        const match = typeof track?.name === 'string' ? track.name.match(/^Track\s+(\d+)$/) : null;
        return match ? Math.max(maximum, Number.parseInt(match[1], 10)) : maximum;
    }, 0);

    moduleCounter = Math.max(moduleCounter, highestModuleCounter + 1);
    manualTrackCounter = Math.max(manualTrackCounter, highestManualTrackNumber + 1);
}

function buildSerializedProjectTracks(projectTracks) {
    return projectTracks.map(({ sequences: _seq, arrangement: _arr, noteSegments: _ns, ...track }) => ({
        ...track,
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
    const [isPoweredOn, setIsPoweredOn] = useState(false);
    const [audioError, setAudioError] = useState(null);
    const [transportState, setTransportState] = useState(initialTransportState);
    const [pendingTransportPlay, setPendingTransportPlay] = useState(false);
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
            setPendingTransportPlay(false);
            stop();
            setIsPoweredOn(false);
        });

        return () => unsubscribe();
    }, []);

    useEffect(() => {
        const unsubscribe = subscribeToVoiceStatus((nextVoiceStatus) => {
            setVoiceStatus({
                capacityVoices: Number.isFinite(nextVoiceStatus?.capacityVoices) ? nextVoiceStatus.capacityVoices : 0,
                noteAffinedVoices: Number.isFinite(nextVoiceStatus?.noteAffinedVoices) ? nextVoiceStatus.noteAffinedVoices : 0,
                releaseVoices: Number.isFinite(nextVoiceStatus?.releaseVoices) ? nextVoiceStatus.releaseVoices : 0,
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
                setPendingTransportPlay(false);
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

        tracks.forEach((track) => {
            registerModule(`${track.id}:keyboard-cv`, { type: 'keyboard-cv', params: {} });
            registerModule(`${track.id}:keyboard-gate`, { type: 'keyboard-gate', params: {} });
            registerModule(`${track.id}:keyboard-velocity`, { type: 'keyboard-velocity', params: {} });
            registerModule(`${track.id}:track-output`, { type: 'track-output', params: {} });
            upsertTrack(track.id, {
                volume: track.mix.volume,
                mute: track.mix.mute,
                polyphony: track.polyphony ?? 4,
                portamento: track.portamento ?? 0,
                keyboardLatchModeEnabled: !track.connections.some(
                    (connection) => connection.from.moduleId === 'keyboard-singleton' && connection.from.outputId === 'gate-out'
                )
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
    }, [tracks]);

    useEffect(() => {
        if (isPoweredOn) {
            setVoiceStatus(initialVoiceStatus);
            return;
        }

        setPendingTransportPlay(false);
        stop();
    }, [isPoweredOn]);

    useEffect(() => {
        if (!pendingTransportPlay || !audioContext || !isPoweredOn) {
            return;
        }

        let cancelled = false;

        const startPlayback = async () => {
            try {
                await audioContext.resume();
                await play();
            } catch (error) {
                console.error('Failed to start MIDI playback:', error);
            } finally {
                if (!cancelled) {
                    setPendingTransportPlay(false);
                }
            }
        };

        startPlayback();

        return () => {
            cancelled = true;
        };
    }, [pendingTransportPlay, audioContext, isPoweredOn]);

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
        const moduleId = `${trackId}:module-${moduleCounter++}`;
        updateTrack(trackId, (track) => ({
            ...track,
            modules: [...track.modules, {
                id: moduleId,
                type,
                x: 100 + track.modules.length * 40,
                y: 100 + track.modules.length * 24
            }]
        }));
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

    const togglePower = () => {
        setAudioError(null);
        setIsPoweredOn((previous) => !previous);
    };

    const handleSequenceLoad = async (file) => {
        setPendingTransportPlay(false);
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

    const handleProjectLoad = async (file) => {
        setPendingTransportPlay(false);
        stop();

        const rawText = await file.text();
        const parsedProject = JSON.parse(rawText);

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
    };

    const handleTransportPlay = async () => {
        if (!transportState.hasSequence) {
            throw new Error('No sequence loaded. Import a MIDI file or add sequences to tracks.');
        }

        if (!audioContext || !isPoweredOn) {
            setPendingTransportPlay(true);
            if (!isPoweredOn) {
                setIsPoweredOn(true);
            }
            return;
        }

        await audioContext.resume();
        await play();
    };

    const handleTransportStop = () => {
        setPendingTransportPlay(false);
        if (isRecording) {
            handleStopRecording();
        }
        stop();
    };

    const handleTransportRewind = () => {
        setPendingTransportPlay(false);
        if (isRecording) {
            handleStopRecording();
        }
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

    const handleToggleRecord = () => {
        if (isRecording) {
            handleStopRecording();
        } else {
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
            mix: {
                ...track.mix,
                ...patch
            }
        }));
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
            keyboardLatchModeEnabled: !selectedTrack?.connections?.some(
                (c) => c.from.moduleId === 'keyboard-singleton' && c.from.outputId === 'gate-out'
            )
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
            keyboardLatchModeEnabled: !selectedTrack?.connections?.some(
                (c) => c.from.moduleId === 'keyboard-singleton' && c.from.outputId === 'gate-out'
            )
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
                isPoweredOn={isPoweredOn}
                togglePower={togglePower}
                hasSelectedTrack={Boolean(selectedTrack)}
                audioError={audioError}
                voiceStatus={voiceStatus}
                onImportMidi={() => midiImportInputRef.current?.click()}
                onLoadProject={() => projectLoadInputRef.current?.click()}
                onSaveProject={handleProjectSave}
                viewMode={viewMode}
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

                {/* Full-width track title bar */}
                <div style={{ height: '30px', borderBottom: '1px solid #2d2d2d', display: 'flex', alignItems: 'center', padding: '0 10px', gap: '8px', background: '#1a1a1a', flexShrink: 0, zIndex: 1 }}>
                    {/* Mode toggle buttons */}
                    {(['voice', 'notes']).map((mode) => (
                        <button
                            key={mode}
                            onClick={() => setViewMode(mode)}
                            style={{
                                padding: '2px 10px',
                                fontSize: '10px',
                                fontWeight: 600,
                                letterSpacing: '0.06em',
                                textTransform: 'uppercase',
                                border: `1px solid ${viewMode === mode ? '#5a9a5a' : '#444'}`,
                                borderRadius: '10px',
                                background: viewMode === mode ? '#2a4a2a' : 'transparent',
                                color: viewMode === mode ? '#8adb8a' : '#666',
                                cursor: 'pointer',
                                lineHeight: 1.4,
                                flexShrink: 0,
                            }}
                        >
                            {mode}
                        </button>
                    ))}
                    <div style={{ width: '1px', alignSelf: 'stretch', background: '#333', margin: '4px 2px' }} />
                    <span style={{ color: '#555', fontSize: '11px', letterSpacing: '0.06em', flexShrink: 0 }}>TRACK:</span>
                    <span style={{ color: '#8a8a8a', fontSize: '11px', letterSpacing: '0.06em', flexShrink: 0 }}>
                        {selectedTrack ? selectedTrack.name : 'none'}
                    </span>
                    {selectedTrack && (
                        <>
                            <div style={{ width: '1px', alignSelf: 'stretch', background: '#333', margin: '4px 4px' }} />
                            <span style={{ color: '#555', fontSize: '10px', letterSpacing: '0.05em', flexShrink: 0 }}>VOICES</span>
                            <select
                                value={selectedTrack.polyphony ?? 4}
                                onChange={(e) => handleUpdatePolyphony(selectedTrack.id, Number(e.target.value))}
                                style={{ width: '46px', background: '#1e1e1e', color: '#aaa', border: '1px solid #444', borderRadius: '3px', fontSize: '11px', height: '20px', padding: '0 2px', cursor: 'pointer', outline: 'none' }}
                                title="Voices (polyphony)"
                            >
                                {Array.from({ length: 16 }, (_, i) => i + 1).map(n => (
                                    <option key={n} value={n}>{n}</option>
                                ))}
                            </select>
                        </>
                    )}
                    {selectedTrack && (selectedTrack.polyphony ?? 4) === 1 && (
                        <>
                            <span style={{ color: '#555', fontSize: '10px', letterSpacing: '0.05em', flexShrink: 0 }}>PORTA</span>
                            <input
                                type="range" min="0" max="2" step="0.01"
                                value={selectedTrack.portamento ?? 0}
                                onChange={(e) => handleUpdatePortamento(selectedTrack.id, parseFloat(e.target.value))}
                                style={{ width: '80px', cursor: 'pointer', accentColor: COLOR_SLIDER }}
                                title={`Portamento: ${(selectedTrack.portamento ?? 0).toFixed(2)}s`}
                            />
                            <span style={{ color: '#bbb', fontSize: '10px', minWidth: '28px' }}>
                                {(selectedTrack.portamento ?? 0).toFixed(2)}s
                            </span>
                        </>
                    )}
                </div>

                {/* Main row: changes based on view mode */}
                <div style={{ flex: 1, position: 'relative', display: 'flex', minHeight: 0 }}>
                    {viewMode === 'notes' ? (
                        // NOTES mode: full-width piano roll with integrated keyboard
                        <PianoRoll
                            track={selectedTrack}
                            timeSignatures={projectSequence.timeSignatures}
                            onNotesChange={handleNotesChange}
                            selectedTrackId={effectiveSelectedTrackId}
                        />
                    ) : (
                        // VOICE mode: keyboard | canvas | amplifier
                        <>
                            <div style={{ width: '165px', height: '100%', background: '#1a1a1a', borderRight: '2px solid #444', flexShrink: 0 }}>
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
                            </div>

                            <div style={{ width: '220px', height: '100%', background: '#1a1a1a', borderLeft: '2px solid #444', flexShrink: 0 }}>
                                <Amplifier
                                    onOutputClick={handleOutputClick}
                                    isConnecting={connectingFrom?.moduleId === 'track-output-singleton'}
                                    audioContext={audioContext}
                                    setAudioContext={setAudioContext}
                                    isFixed={true}
                                    isPoweredOn={isPoweredOn}
                                    selectedTrackLabel={selectedTrack?.name ?? null}
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
                isPendingPlay={pendingTransportPlay}
                onSetTransportPosition={seekTo}
                isRecording={isRecording}
                onRecord={handleToggleRecord}
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

function Toolbar({ addModule, isPoweredOn, togglePower, hasSelectedTrack, audioError, voiceStatus, onImportMidi, onLoadProject, onSaveProject, viewMode }) {


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
            <b>MOTH1</b>
            <ToolbarButton onClick={onLoadProject}>LOAD</ToolbarButton>
            <ToolbarButton onClick={onSaveProject}>SAVE</ToolbarButton>
            <ToolbarButton onClick={onImportMidi}>IMPORT</ToolbarButton>
            {viewMode !== 'notes' && (
                <>
                    <div style={{ width: '1px', alignSelf: 'stretch', background: '#505050', margin: '6px 4px' }} />
                    <ToolbarButton onClick={() => addModule('oscillator')} disabled={!hasSelectedTrack}>+ VCO</ToolbarButton>
                    <ToolbarButton onClick={() => addModule('filter')} disabled={!hasSelectedTrack}>+ VCF</ToolbarButton>
                    <ToolbarButton onClick={() => addModule('envelope')} disabled={!hasSelectedTrack}>+ ENV</ToolbarButton>
                    <ToolbarButton onClick={() => addModule('random')} disabled={!hasSelectedTrack}>+ RND</ToolbarButton>
                    <ToolbarButton onClick={() => addModule('mixer')} disabled={!hasSelectedTrack}>+ MIX</ToolbarButton>
                    <ToolbarButton onClick={() => addModule('multi')} disabled={!hasSelectedTrack}>+ MUL</ToolbarButton>
                    <ToolbarButton onClick={() => addModule('vca')} disabled={!hasSelectedTrack}>+ VCA</ToolbarButton>
                    <ToolbarButton onClick={() => addModule('mfx')} disabled={!hasSelectedTrack}>+ MFX</ToolbarButton>
                </>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>

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
                <ToolbarButton
                    variant="power"
                    active={isPoweredOn}
                    onClick={togglePower}
                >
                    {/* Unicode power symbol ⏻ */}
                    ⏻
                </ToolbarButton>
            </div>
        </div>
    );
}

function Canvas({ canvasRef, modules, connections, connectingFrom, onModuleDragStart, onOutputClick, onMouseMove, onClick, audioContext, moduleUiRevision, onRemove }) {
    // Helper to determine if a module is fixed (not removable)
    const isFixed = (module) => module.id === 'keyboard-singleton' || module.id === 'track-output-singleton';

    return (
        <div
            ref={canvasRef}
            onMouseMove={onMouseMove}
            onClick={onClick}
            style={{
                width: '100%',
                height: 'calc(100% - 32px)',
                position: 'relative',
                background: 'repeating-linear-gradient(0deg, transparent, transparent 19px, #222 19px, #222 20px), repeating-linear-gradient(90deg, transparent, transparent 19px, #222 19px, #222 20px)',
                backgroundSize: '20px 20px'
            }}
        >
            {modules.map((module) => {
                const removeProp = !isFixed(module) ? { onRemove: () => onRemove(module.id) } : {};
                let child = null;
                if (module.type === 'oscillator') {
                    child = <Oscillator key={`${module.id}:${moduleUiRevision}`} module={module} onDragStart={onModuleDragStart} onOutputClick={onOutputClick} isConnecting={connectingFrom?.moduleId === module.id} audioContext={audioContext} connections={connections} {...removeProp} />;
                } else if (module.type === 'filter') {
                    child = <Filter key={`${module.id}:${moduleUiRevision}`} module={module} onDragStart={onModuleDragStart} onOutputClick={onOutputClick} isConnecting={connectingFrom?.moduleId === module.id} audioContext={audioContext} connections={connections} {...removeProp} />;
                } else if (module.type === 'random') {
                    child = <RandomVoltageGenerator key={`${module.id}:${moduleUiRevision}`} module={module} onDragStart={onModuleDragStart} onOutputClick={onOutputClick} isConnecting={connectingFrom?.moduleId === module.id} audioContext={audioContext} connections={connections} {...removeProp} />;
                } else if (module.type === 'envelope') {
                    child = <Envelope key={`${module.id}:${moduleUiRevision}`} module={module} onDragStart={onModuleDragStart} onOutputClick={onOutputClick} isConnecting={connectingFrom?.moduleId === module.id} audioContext={audioContext} connections={connections} {...removeProp} />;
                } else if (module.type === 'mixer') {
                    child = <Mixer key={`${module.id}:${moduleUiRevision}`} module={module} onDragStart={onModuleDragStart} onOutputClick={onOutputClick} isConnecting={connectingFrom?.moduleId === module.id} connections={connections} {...removeProp} />;
                } else if (module.type === 'multi') {
                    child = <Multi key={`${module.id}:${moduleUiRevision}`} module={module} onDragStart={onModuleDragStart} onOutputClick={onOutputClick} isConnecting={connectingFrom?.moduleId === module.id} {...removeProp} />;
                } else if (module.type === 'vca') {
                    child = <VCA key={`${module.id}:${moduleUiRevision}`} module={module} onDragStart={onModuleDragStart} onOutputClick={onOutputClick} isConnecting={connectingFrom?.moduleId === module.id} connections={connections} {...removeProp} />;
                } else if (module.type === 'delay' || module.type === 'mfx') {
                    child = <MFX key={`${module.id}:${moduleUiRevision}`} module={module} onDragStart={onModuleDragStart} onOutputClick={onOutputClick} isConnecting={connectingFrom?.moduleId === module.id} {...removeProp} />;
                }
                if (!child) return null;
                return (
                    <div key={module.id} style={{ position: 'absolute', left: module.x, top: module.y }}>
                        {child}
                    </div>
                );
            })}

            {modules.length === 0 && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4d4d4d', fontSize: '13px', letterSpacing: '0.04em' }}>
                    Add modules and patch them TO MIXER to make this track audible.
                </div>
            )}
        </div>
    );
}

export default App;
