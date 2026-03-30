import React, { useState, useEffect, useRef } from 'react';
import { getPlaybackPositionMs, getIsPlaying } from '../audio/sequencer.js';

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
    onPlay,
    onStop,
    onRewind,
    onSelectTrack,
    onUpdateTrackMix,
    onCreateTrack,
    onRemoveTrack,
    onRenameTrack,
    isPendingPlay,
    onSetTransportPosition
}) {
    const [statusMessage, setStatusMessage] = useState('No sequence loaded');
    const rafRef = useRef(null);

    const timelineDurationMs = Math.max(
        transportState?.durationMs ?? 0,
        ...tracks.map((track) => track.durationMs ?? 0),
        1
    );

    const isPlaying = transportState?.isPlaying;

    const handlePlayStop = async () => {
        if (isPlaying) {
            onStop();
            setStatusMessage('Stopped');
        } else {
            try {
                await onPlay();
                setStatusMessage('Playing');
            } catch (error) {
                setStatusMessage(error instanceof Error ? error.message : 'Playback could not start.');
            }
        }
    };

    const handleRewind = () => {
        onRewind();
        setStatusMessage('Rewound to start');
    };

    const timelineRef = React.useRef(null);
    const handleTimelineClick = (e) => {
        if (!timelineRef.current) return;
        const rect = timelineRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percent = Math.max(0, Math.min(1, x / rect.width));
        const ms = percent * timelineDurationMs;
        if (typeof onSetTransportPosition === 'function') {
            onSetTransportPosition(ms);
        }
    };

    return (
        <div style={{
            height: '320px',
            background: '#161616',
            borderTop: '2px solid #444',
            display: 'flex',
            flexDirection: 'column',
            padding: '12px 18px 14px',
            flexShrink: 0,
            boxShadow: '0 -10px 24px rgba(0,0,0,0.3)',
            position: 'relative'
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', width: '100%', minHeight: '40px' }}>
                <button onClick={handlePlayStop} style={isPlaying ? stopButtonStyle : primaryButtonStyle} disabled={!transportState?.hasSequence || isPendingPlay}>
                    {isPendingPlay ? 'Starting…' : isPlaying ? 'Stop' : 'Play'}
                </button>
                <button onClick={handleRewind} style={controlButtonStyle} disabled={!transportState?.hasSequence}>Rewind</button>
                <button onClick={onCreateTrack} style={secondaryButtonStyle}>New Track</button>

                <div style={{ minWidth: '240px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ fontSize: '11px', letterSpacing: '0.08em', color: '#6f6f6f' }}>STATUS</div>
                    <div style={{ fontSize: '13px', color: isPlaying ? '#9cff9c' : '#c8c8c8' }}>
                        {isPlaying ? 'Playing' : statusMessage}
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

            {/* Track List */}
            <div
                ref={timelineRef}
                style={{ flex: 1, width: '100%', overflow: 'auto', marginTop: '2px', border: '1px solid #2a2a2a', background: '#111', position: 'relative' }}
            >
                {tracks.map((track) => (
                    <TrackRow
                        key={track.id}
                        track={track}
                        isSelected={track.id === selectedTrackId}
                        isPlaying={isPlaying}
                        playbackPositionMs={0}
                        timelineDurationMs={timelineDurationMs}
                        onSelect={() => onSelectTrack(track.id)}
                        onToggleMute={() => onUpdateTrackMix(track.id, { mute: !track.mix.mute })}
                        onVolumeChange={(volume) => onUpdateTrackMix(track.id, { volume })}
                        onSeek={(ms) => onSetTransportPosition(ms)}
                        onRemove={() => onRemoveTrack(track.id)}
                        onRename={(name) => onRenameTrack(track.id, name)}
                    />
                ))}
            </div>
        </div>
    );
}

function TrackRow({ track, isSelected, isPlaying, timelineDurationMs, onSelect, onToggleMute, onVolumeChange, onSeek, onRemove, onRename }) {
    const noteAreaRef = React.useRef(null);
    const playheadRef = React.useRef(null);
    const durationRef = React.useRef(timelineDurationMs);
    const [editing, setEditing] = React.useState(false);
    const [editValue, setEditValue] = React.useState('');
    const inputRef = React.useRef(null);

    // Keep durationRef current so the rAF closure always has the latest value.
    React.useEffect(() => { durationRef.current = timelineDurationMs; }, [timelineDurationMs]);

    // Direct DOM rAF — bypasses React state entirely for smooth 60fps playhead.
    React.useEffect(() => {
        let rafId;
        const tick = () => {
            if (playheadRef.current) {
                const pos = getPlaybackPositionMs();
                const dur = durationRef.current || 1;
                const left = Math.min(100, Math.max(0, (pos / dur) * 100));
                playheadRef.current.style.left = `${left}%`;
                playheadRef.current.style.background = getIsPlaying() ? '#d7ffd7' : '#4a4a4a';
            }
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafId);
    }, []);

    const noteSegments = Array.isArray(track?.noteSegments) ? track.noteSegments : [];
    const trackName = typeof track?.name === 'string' ? track.name : 'Untitled';
    const mix = track?.mix || { volume: 0.8, mute: false };

    const handleNoteAreaClick = (e) => {
        e.stopPropagation();
        if (!noteAreaRef.current || !onSeek) return;
        const rect = noteAreaRef.current.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        onSeek(percent * timelineDurationMs);
    };

    const handleRemove = (e) => {
        e.stopPropagation();
        if (window.confirm(`Remove track "${trackName}"?`)) {
            onRemove();
        }
    };

    const startEdit = (e) => {
        e.stopPropagation();
        setEditValue(trackName);
        setEditing(true);
        setTimeout(() => inputRef.current?.select(), 0);
    };

    const commitEdit = () => {
        setEditing(false);
        onRename(editValue);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') commitEdit();
        if (e.key === 'Escape') setEditing(false);
    };

    return (
        <div
            style={{
                display: 'grid',
                gridTemplateColumns: '200px 60px 120px 28px 1fr',
                alignItems: 'center',
                minHeight: '40px',
                borderBottom: '1px solid #1e1e1e',
                background: isSelected ? '#1c241c' : '#111'
            }}
        >
            {/* Name — click to select, double-click to rename */}
            <div
                onClick={onSelect}
                onDoubleClick={startEdit}
                style={{ padding: '0 10px', minWidth: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', height: '100%' }}
            >
                {editing ? (
                    <input
                        ref={inputRef}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={handleKeyDown}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            width: '100%',
                            background: '#1a2a1a',
                            border: '1px solid #4f9b54',
                            borderRadius: '3px',
                            color: '#eaffea',
                            fontSize: '12px',
                            padding: '2px 4px',
                            fontFamily: 'inherit',
                            outline: 'none'
                        }}
                        autoFocus
                    />
                ) : (
                    <div style={{ minWidth: 0, width: '100%' }}>
                        <div
                            title="Double-click to rename"
                            style={{ fontSize: '12px', color: '#e3e3e3', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                        >
                            {trackName}
                        </div>
                        <div style={{ fontSize: '10px', color: '#666', marginTop: '1px' }}>
                            {track?.notes?.length ?? 0} notes
                        </div>
                    </div>
                )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'center' }}>
                <button
                    onClick={(e) => { e.stopPropagation(); onToggleMute(); }}
                    style={{
                        ...muteButtonStyle,
                        background: mix.mute ? '#732b2b' : '#2a2a2a',
                        borderColor: mix.mute ? '#b74d4d' : '#555'
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
                    value={mix.volume}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                    style={{ width: '100%' }}
                />
            </div>

            {/* Delete track */}
            <div style={{ display: 'flex', justifyContent: 'center' }}>
                <button
                    onClick={handleRemove}
                    title={`Remove "${trackName}"`}
                    style={{
                        width: '18px',
                        height: '18px',
                        padding: 0,
                        background: 'transparent',
                        border: '1px solid #444',
                        borderRadius: '3px',
                        color: '#888',
                        fontSize: '13px',
                        lineHeight: '1',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#c44'; e.currentTarget.style.color = '#f88'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = '#444'; e.currentTarget.style.color = '#888'; }}
                >
                    ×
                </button>
            </div>

            {/* Note/timeline area — clicking here seeks, does not select */}
            <div
                ref={noteAreaRef}
                onClick={handleNoteAreaClick}
                style={{ position: 'relative', height: '40px', overflow: 'hidden', cursor: 'crosshair' }}
            >
                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))' }} />
                {noteSegments.map((segment, index) => {
                    if (!segment || typeof segment.startMs !== 'number' || typeof segment.endMs !== 'number' || typeof segment.noteNumber !== 'number') return null;
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
                                background: mix.mute ? '#555' : '#6dbe6d',
                                borderRadius: '2px',
                                opacity: 0.9
                            }}
                        />
                    );
                })}
                {/* Playhead — position driven by direct DOM rAF, not React state */}
                <div
                    ref={playheadRef}
                    style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        left: '0%',
                        width: '2px',
                        background: '#4a4a4a',
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

const stopButtonStyle = {
    padding: '10px 18px',
    background: '#5d2929',
    border: '1px solid #9b4f4f',
    borderRadius: '5px',
    color: '#ffeaea',
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