import React, { useEffect, useRef, useState } from 'react';
import Amplifier from './components/Amplifier.jsx';
import Oscillator from './components/Oscillator.jsx';
import Filter from './components/Filter.jsx';
import Keyboard from './components/Keyboard.jsx';
import RandomVoltageGenerator from './components/RandomVoltageGenerator.jsx';
import Envelope from './components/Envelope.jsx';
import Mixer from './components/Mixer.jsx';
import Multi from './components/Multi.jsx';
import Transport from './components/Transport.jsx';
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
    buildNotesFromEvents,
    loadMIDIFile,
    loadProjectSequence,
    playLoadedSequence,
    rewindLoadedSequence,
    setSelectedTrack as setSelectedMidiTrack,
    stopLoadedSequence,
    subscribeToSequenceTransport
} from './audio/midiManager.js';

const toolbarHeight = 50;

const initialTransportState = {
    hasSequence: false,
    fileName: null,
    durationMs: 0,
    trackCount: 0,
    tracks: [],
    isPlaying: false,
    playbackPositionMs: 0
};

const initialProjectSequence = {
    fileName: null,
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
        source: { kind: 'manual' },
        midi: {
            notes: [],
            noteSegments: [],
            durationMs: 0,
            noteCount: 0
        },
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
        source: {
            kind: 'midi-import',
            midiTrackIndex: trackData.sourceTrackIndex,
            channel: trackData.channel
        },
        midi: {
            notes: trackData.notes ?? [],
            noteSegments: trackData.noteSegments,
            durationMs: trackData.durationMs,
            noteCount: trackData.noteCount ?? (trackData.notes?.length ?? 0)
        },
        mix: {
            volume: 0.8,
            mute: false
        },
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

function normalizeTrack(track, index, moduleStateLookup = new Map()) {
    const midiEvents = Array.isArray(track?.midi?.events) ? track.midi.events : [];
    const midiNotes = Array.isArray(track?.midi?.notes)
        ? track.midi.notes
        : buildNotesFromEvents(midiEvents);
    const noteSegments = Array.isArray(track?.midi?.noteSegments)
        ? track.midi.noteSegments
        : buildNoteSegments(midiNotes);
    const durationMs = Number.isFinite(track?.midi?.durationMs)
        ? track.midi.durationMs
        : (noteSegments.length > 0 ? noteSegments[noteSegments.length - 1].endMs : 0);
    const noteCount = Number.isFinite(track?.midi?.noteCount)
        ? track.midi.noteCount
        : midiNotes.length;

    const source = track?.source?.kind === 'midi-import'
        ? {
            kind: 'midi-import',
            midiTrackIndex: Number.isFinite(track?.source?.midiTrackIndex) ? track.source.midiTrackIndex : 0,
            channel: Number.isFinite(track?.source?.channel) ? track.source.channel : 0
        }
        : { kind: 'manual' };

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
        source,
        midi: {
            notes: midiNotes,
            noteSegments,
            durationMs,
            noteCount
        },
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
    return projectTracks.map((track) => ({
        ...track,
        midi: {
            ...track.midi,
            noteSegments: undefined,
            events: undefined,
            eventCount: undefined
        },
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
    const [projectSequence, setProjectSequence] = useState(initialProjectSequence);
    const [voiceStatus, setVoiceStatus] = useState(initialVoiceStatus);

    const canvasRef = useRef(null);
    const contentRef = useRef(null);
    const midiImportInputRef = useRef(null);
    const projectLoadInputRef = useRef(null);
    const previousTrackIdsRef = useRef(new Set());

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
        const unsubscribe = subscribeToSequenceTransport(setTransportState);
        return () => unsubscribe();
    }, []);

    useEffect(() => {
        const unsubscribe = subscribeToAudioEngineErrors((error) => {
            const nextMessage = error?.message || 'Audio engine error.';
            const phase = error?.context?.phase ? ` (${error.context.phase})` : '';
            setAudioError(`${nextMessage}${phase}`);
            setVoiceStatus(initialVoiceStatus);
            setPendingTransportPlay(false);
            stopLoadedSequence();
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
                stopLoadedSequence();
            }
        });

        return () => unsubscribe();
    }, []);

    useEffect(() => {
        setSelectedMidiTrack(effectiveSelectedTrackId);
        setScopeTrack(effectiveSelectedTrackId);
    }, [effectiveSelectedTrackId]);

    useEffect(() => {
        const currentTrackIds = new Set(tracks.map((track) => track.id));

        tracks.forEach((track) => {
            registerModule(`${track.id}:keyboard-cv`, { type: 'keyboard-cv', params: {} });
            registerModule(`${track.id}:keyboard-gate`, { type: 'keyboard-gate', params: {} });
            registerModule(`${track.id}:track-output`, { type: 'track-output', params: {} });
            upsertTrack(track.id, {
                volume: track.mix.volume,
                mute: track.mix.mute,
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
        stopLoadedSequence();
    }, [isPoweredOn]);

    useEffect(() => {
        if (!pendingTransportPlay || !audioContext || !isPoweredOn) {
            return;
        }

        let cancelled = false;

        const startPlayback = async () => {
            try {
                await audioContext.resume();
                await playLoadedSequence();
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

        const rect = event.currentTarget.getBoundingClientRect();
        setDraggedModule(moduleId);
        setDragOffset({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top
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

        const newModule = {
            id: `${selectedTrack.id}:module-${moduleCounter++}`,
            type,
            x: 100 + selectedTrack.modules.length * 40,
            y: 100 + selectedTrack.modules.length * 24
        };

        updateTrack(selectedTrack.id, (track) => ({
            ...track,
            modules: [...track.modules, newModule]
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
        const importedSequence = await loadMIDIFile(file);
        const importedTracks = importedSequence.tracks.map(createImportedTrack);
        syncCountersFromTracks(importedTracks);
        setProjectSequence({
            fileName: importedSequence.fileName,
            ticksPerBeat: importedSequence.ticksPerBeat ?? null,
            tempoMap: importedSequence.tempoMap ?? [],
            timeSignatures: importedSequence.timeSignatures ?? []
        });
        loadProjectSequence({
            fileName: importedSequence.fileName,
            ticksPerBeat: importedSequence.ticksPerBeat ?? null,
            tempoMap: importedSequence.tempoMap ?? [],
            timeSignatures: importedSequence.timeSignatures ?? []
        }, importedTracks);
        setTracks(importedTracks);
        setSelectedTrackId(importedTracks[0]?.id ?? null);
        return importedSequence;
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
        stopLoadedSequence();

        const rawText = await file.text();
        const parsedProject = JSON.parse(rawText);

        if (!Array.isArray(parsedProject?.tracks)) {
            throw new Error('Invalid project file: expected a tracks array.');
        }

        const moduleStateLookup = createProjectModuleStateLookup(parsedProject.moduleStates);
        const loadedTracks = parsedProject.tracks.map((track, index) => normalizeTrack(track, index, moduleStateLookup));
        syncCountersFromTracks(loadedTracks);

        const nextProjectSequence = {
            fileName: parsedProject.sequence?.fileName ?? parsedProject.fileName ?? file.name.replace(/\.json$/i, ''),
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
        loadProjectSequence(nextProjectSequence, loadedTracks);
        setTracks(loadedTracks);
        setSelectedTrackId(nextSelectedTrackId);
        setModuleUiRevision((current) => current + 1);
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
        const removedTrack = tracks.find((track) => track.id === trackId);
        setTracks(nextTracks);

        if (removedTrack?.midi?.noteCount > 0) {
            loadProjectSequence(projectSequence, nextTracks);
        }

        if (selectedTrackId === trackId) {
            setSelectedTrackId(nextTracks[0]?.id ?? null);
        }
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
            />

            <div ref={contentRef} style={{ flex: 1, position: 'relative', display: 'flex', minHeight: 0 }}>
                <svg key={overlayRefreshTick} style={{
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
                                    stroke="#00ff00"
                                    strokeWidth="2"
                                    fill="none"
                                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        removeConnection(connection.id);
                                    }}
                                />
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
                                stroke="#00ff0066"
                                strokeWidth="2"
                                fill="none"
                                strokeDasharray="5,5"
                            />
                        );
                    })()}
                </svg>

                <div style={{ width: '200px', height: '100%', background: '#1a1a1a', borderRight: '2px solid #444', flexShrink: 0 }}>
                    <Keyboard
                        module={{ id: 'keyboard-singleton' }}
                        onOutputClick={handleOutputClick}
                        isConnecting={connectingFrom?.moduleId === 'keyboard-singleton'}
                        isFixed={true}
                        selectedTrackId={effectiveSelectedTrackId}
                        selectedTrackLabel={selectedTrack?.name ?? null}
                    />
                </div>

                <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
                    <div style={{ height: '32px', borderBottom: '1px solid #2d2d2d', display: 'flex', alignItems: 'center', padding: '0 14px', color: '#8a8a8a', fontSize: '12px', letterSpacing: '0.06em' }}>
                        {selectedTrack ? `SELECTED TRACK · ${selectedTrack.name}` : 'NO TRACK SELECTED'}
                    </div>
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
                isPendingPlay={pendingTransportPlay}
            />
        </div>
    );
}

function Toolbar({ addModule, isPoweredOn, togglePower, hasSelectedTrack, audioError, voiceStatus, onImportMidi, onLoadProject, onSaveProject }) {
    const capacityThreads = voiceStatus?.capacityVoices ?? 0;
    const noteAffinedThreads = voiceStatus?.noteAffinedVoices ?? 0;
    const releaseThreads = voiceStatus?.releaseVoices ?? 0;
    const processingThreads = voiceStatus?.processingVoices ?? 0;
    const activeTracks = voiceStatus?.activeTrackCount ?? 0;
    const threadTitle = Array.isArray(voiceStatus?.perTrack) && voiceStatus.perTrack.length > 0
        ? voiceStatus.perTrack
            .filter((track) => track.processingVoices > 0 || track.capacityVoices > 0)
            .map((track) => `${track.trackId}: ${track.capacityVoices} cap, ${track.noteAffinedVoices} affined, ${track.releaseVoices} release, ${track.processingVoices} processing`)
            .join('\n')
        : 'No voice lanes';

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
            <button onClick={onImportMidi} style={buttonStyle}>Import MIDI</button>
            <button onClick={onLoadProject} style={buttonStyle}>LOAD</button>
            <button onClick={onSaveProject} style={buttonStyle}>SAVE</button>
            <div style={{ width: '1px', alignSelf: 'stretch', background: '#505050', margin: '6px 4px' }} />
            <button onClick={() => addModule('oscillator')} style={buttonStyle} disabled={!hasSelectedTrack}>+ Oscillator</button>
            <button onClick={() => addModule('filter')} style={buttonStyle} disabled={!hasSelectedTrack}>+ Filter</button>
            <button onClick={() => addModule('envelope')} style={buttonStyle} disabled={!hasSelectedTrack}>+ Envelope</button>
            <button onClick={() => addModule('random')} style={buttonStyle} disabled={!hasSelectedTrack}>+ Random</button>
            <button onClick={() => addModule('mixer')} style={buttonStyle} disabled={!hasSelectedTrack}>+ Mixer</button>
            <button onClick={() => addModule('multi')} style={buttonStyle} disabled={!hasSelectedTrack}>+ Multi</button>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                <div
                    style={{
                        padding: '6px 10px',
                        border: '1px solid #4e4e4e',
                        borderRadius: '4px',
                        background: '#202020',
                        color: capacityThreads > 0 ? '#d6f5d6' : '#9a9a9a',
                        fontSize: '11px',
                        whiteSpace: 'nowrap'
                    }}
                    title={threadTitle}
                >
                    LANES {capacityThreads} · AFFINED {noteAffinedThreads} · REL {releaseThreads} · PROC {processingThreads} · TRACKS {activeTracks}
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

function Canvas({ canvasRef, modules, connections, connectingFrom, onModuleDragStart, onOutputClick, onMouseMove, onClick, audioContext, moduleUiRevision }) {
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
                if (module.type === 'oscillator') {
                    return <Oscillator key={`${module.id}:${moduleUiRevision}`} module={module} onDragStart={onModuleDragStart} onOutputClick={onOutputClick} isConnecting={connectingFrom?.moduleId === module.id} audioContext={audioContext} connections={connections} />;
                }
                if (module.type === 'filter') {
                    return <Filter key={`${module.id}:${moduleUiRevision}`} module={module} onDragStart={onModuleDragStart} onOutputClick={onOutputClick} isConnecting={connectingFrom?.moduleId === module.id} audioContext={audioContext} connections={connections} />;
                }
                if (module.type === 'random') {
                    return <RandomVoltageGenerator key={`${module.id}:${moduleUiRevision}`} module={module} onDragStart={onModuleDragStart} onOutputClick={onOutputClick} isConnecting={connectingFrom?.moduleId === module.id} audioContext={audioContext} connections={connections} />;
                }
                if (module.type === 'envelope') {
                    return <Envelope key={`${module.id}:${moduleUiRevision}`} module={module} onDragStart={onModuleDragStart} onOutputClick={onOutputClick} isConnecting={connectingFrom?.moduleId === module.id} audioContext={audioContext} connections={connections} />;
                }
                if (module.type === 'mixer') {
                    return <Mixer key={`${module.id}:${moduleUiRevision}`} module={module} onDragStart={onModuleDragStart} onOutputClick={onOutputClick} isConnecting={connectingFrom?.moduleId === module.id} connections={connections} />;
                }
                if (module.type === 'multi') {
                    return <Multi key={`${module.id}:${moduleUiRevision}`} module={module} onDragStart={onModuleDragStart} onOutputClick={onOutputClick} isConnecting={connectingFrom?.moduleId === module.id} />;
                }
                return null;
            })}

            {modules.length === 0 && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4d4d4d', fontSize: '13px', letterSpacing: '0.04em' }}>
                    Add modules and patch them to TO MIXER to make this track audible.
                </div>
            )}
        </div>
    );
}

const buttonStyle = {
    padding: '8px 14px',
    background: '#444',
    border: '1px solid #666',
    borderRadius: '4px',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '12px'
};

export default App;
