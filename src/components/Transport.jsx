import React, { useRef, useState } from 'react';

function formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function Transport({
    transportState,
    tracks,
    selectedTrackId,
    onLoadFile,
    onPlay,
    onStop,
    onRewind,
    onSelectTrack,
    onUpdateTrackMix,
    onCreateTrack,
    onRemoveTrack,
    isPendingPlay
}) {
    const inputRef = useRef(null);
    const [statusMessage, setStatusMessage] = useState('No sequence loaded');
    const [isLoading, setIsLoading] = useState(false);
    const timelineDurationMs = Math.max(
        transportState?.durationMs ?? 0,
        ...tracks.map((track) => track.midi?.durationMs ?? 0),
        1
    );

    const handleFileChange = async (event) => {
        const file = event.target.files?.[0];

        if (!file) {
            return;
        }

        setIsLoading(true);

        try {
            const state = await onLoadFile(file);
            setStatusMessage(`Loaded ${state.fileName} into ${state.trackCount} track lanes`);
        } catch (error) {
            setStatusMessage(error instanceof Error ? error.message : 'Failed to load MIDI file.');
        } finally {
            setIsLoading(false);
            event.target.value = '';
        }
    };

    const handlePlay = async () => {
        try {
            await onPlay();
            if (transportState?.hasSequence) {
                setStatusMessage(`Playing ${transportState.fileName}`);
            }
        } catch (error) {
            setStatusMessage(error instanceof Error ? error.message : 'Playback could not start.');
        }
    };

    const handleStop = () => {
        onStop();
        setStatusMessage('Stopped');
    };

    const handleRewind = () => {
        onRewind();
        setStatusMessage('Rewound to start');
    };

    return (
        <div style={{
            height: '220px',
            background: '#161616',
            borderTop: '2px solid #444',
            display: 'flex',
            flexDirection: 'column',
            padding: '12px 18px 14px',
            flexShrink: 0,
            boxShadow: '0 -10px 24px rgba(0,0,0,0.3)'
        }}>
            <input
                ref={inputRef}
                type="file"
                accept=".mid,.midi,audio/midi,audio/x-midi"
                onChange={handleFileChange}
                style={{ display: 'none' }}
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', width: '100%', minHeight: '40px' }}>
                <button onClick={() => inputRef.current?.click()} style={primaryButtonStyle} disabled={isLoading}>
                    {isLoading ? 'Loading...' : 'Upload'}
                </button>
                <button onClick={handlePlay} style={controlButtonStyle} disabled={!transportState?.hasSequence || isLoading || isPendingPlay}>
                    {isPendingPlay ? 'Starting...' : 'Play'}
                </button>
                <button onClick={handleStop} style={controlButtonStyle} disabled={!transportState?.hasSequence}>Stop</button>
                <button onClick={handleRewind} style={controlButtonStyle} disabled={!transportState?.hasSequence}>Rewind</button>
                <button onClick={onCreateTrack} style={secondaryButtonStyle}>Create Track</button>
                <button onClick={() => selectedTrackId && onRemoveTrack(selectedTrackId)} style={secondaryButtonStyle} disabled={!selectedTrackId}>Remove Track</button>

                <div style={{ minWidth: '220px', display: 'flex', flexDirection: 'column', gap: '4px', marginLeft: '12px' }}>
                    <div style={{ fontSize: '11px', letterSpacing: '0.08em', color: '#6f6f6f' }}>SEQUENCE</div>
                    <div style={{ fontSize: '13px', color: '#d9d9d9', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {transportState?.fileName ?? 'Manual tracks'}
                    </div>
                </div>

                <div style={{ minWidth: '240px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ fontSize: '11px', letterSpacing: '0.08em', color: '#6f6f6f' }}>STATUS</div>
                    <div style={{ fontSize: '13px', color: transportState?.isPlaying ? '#9cff9c' : '#c8c8c8' }}>
                        {transportState?.isPlaying ? `Playing ${transportState.fileName}` : statusMessage}
                    </div>
                </div>

                <div style={{ marginLeft: 'auto', display: 'flex', gap: '22px', alignItems: 'center' }}>
                    <div style={metaBlockStyle}>
                        <span style={metaLabelStyle}>TRACKS</span>
                        <span style={metaValueStyle}>{tracks.length}</span>
                    </div>
                    <div style={metaBlockStyle}>
                        <span style={metaLabelStyle}>IMPORTED</span>
                        <span style={metaValueStyle}>{transportState?.trackCount ?? 0}</span>
                    </div>
                    <div style={metaBlockStyle}>
                        <span style={metaLabelStyle}>LENGTH</span>
                        <span style={metaValueStyle}>{formatDuration(timelineDurationMs)}</span>
                    </div>
                </div>
            </div>

            <div style={{ flex: 1, width: '100%', overflow: 'auto', marginTop: '10px', border: '1px solid #2a2a2a', background: '#111' }}>
                {tracks.map((track) => (
                    <TrackRow
                        key={track.id}
                        track={track}
                        isSelected={track.id === selectedTrackId}
                        isPlaying={transportState?.isPlaying}
                        playbackPositionMs={transportState?.playbackPositionMs ?? 0}
                        timelineDurationMs={timelineDurationMs}
                        onSelect={() => onSelectTrack(track.id)}
                        onToggleMute={() => onUpdateTrackMix(track.id, { mute: !track.mix.mute })}
                        onVolumeChange={(volume) => onUpdateTrackMix(track.id, { volume })}
                    />
                ))}
            </div>
        </div>
    );
}

function TrackRow({ track, isSelected, isPlaying, playbackPositionMs, timelineDurationMs, onSelect, onToggleMute, onVolumeChange }) {
    const noteSegments = track.midi?.noteSegments ?? [];

    return (
        <div
            onClick={onSelect}
            style={{
                display: 'grid',
                gridTemplateColumns: '200px 60px 120px 1fr',
                alignItems: 'center',
                minHeight: '40px',
                borderBottom: '1px solid #1e1e1e',
                background: isSelected ? '#1c241c' : '#111',
                cursor: 'pointer'
            }}
        >
            <div style={{ padding: '0 10px', minWidth: 0 }}>
                <div style={{ fontSize: '12px', color: '#e3e3e3', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {track.name}
                </div>
                <div style={{ fontSize: '10px', color: '#666' }}>
                    {track.source.kind === 'midi-import'
                        ? `TR ${track.source.midiTrackIndex + 1} · CH ${track.source.channel + 1}`
                        : 'Manual'}
                </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'center' }}>
                <button
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleMute();
                    }}
                    style={{
                        ...muteButtonStyle,
                        background: track.mix.mute ? '#732b2b' : '#2a2a2a',
                        borderColor: track.mix.mute ? '#b74d4d' : '#555'
                    }}
                >
                    M
                </button>
            </div>

            <div style={{ padding: '0 12px' }}>
                <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={track.mix.volume}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => onVolumeChange(parseFloat(event.target.value))}
                    style={{ width: '100%' }}
                />
            </div>

            <div style={{ position: 'relative', height: '40px', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))' }} />
                {noteSegments.map((segment, index) => {
                    const left = (segment.startMs / timelineDurationMs) * 100;
                    const width = Math.max(0.4, ((segment.endMs - segment.startMs) / timelineDurationMs) * 100);
                    const top = 4 + (1 - (segment.noteNumber - 21) / 87) * 28;
                    return (
                        <div
                            key={`${segment.noteNumber}-${segment.startMs}-${index}`}
                            style={{
                                position: 'absolute',
                                left: `${left}%`,
                                width: `${width}%`,
                                top: `${top}px`,
                                height: '3px',
                                background: track.mix.mute ? '#555' : '#6dbe6d',
                                borderRadius: '2px',
                                opacity: 0.9
                            }}
                        />
                    );
                })}
                <div
                    style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        left: `${(playbackPositionMs / timelineDurationMs) * 100}%`,
                        width: '1px',
                        background: isPlaying ? '#d7ffd7' : '#4a4a4a',
                        opacity: 0.9
                    }}
                />
            </div>
        </div>
    );
}

const primaryButtonStyle = {
    padding: '10px 18px',
    background: '#295d2b',
    border: '1px solid #4f9b54',
    borderRadius: '5px',
    color: '#eaffea',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'inherit'
};

const controlButtonStyle = {
    padding: '10px 16px',
    background: '#2f2f2f',
    border: '1px solid #5a5a5a',
    borderRadius: '5px',
    color: '#f2f2f2',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'inherit'
};

const secondaryButtonStyle = {
    padding: '10px 14px',
    background: '#202020',
    border: '1px solid #5a5a5a',
    borderRadius: '5px',
    color: '#f2f2f2',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'inherit'
};

const muteButtonStyle = {
    width: '32px',
    height: '24px',
    borderRadius: '4px',
    border: '1px solid #555',
    color: '#f2f2f2',
    cursor: 'pointer',
    fontSize: '11px',
    fontFamily: 'inherit'
};

const metaBlockStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    alignItems: 'flex-end'
};

const metaLabelStyle = {
    fontSize: '10px',
    letterSpacing: '0.08em',
    color: '#6f6f6f'
};

const metaValueStyle = {
    fontSize: '14px',
    color: '#f0f0f0'
};

export default Transport;