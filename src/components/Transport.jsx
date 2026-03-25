import React, { useRef, useState } from 'react';

function formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function Transport({ transportState, onLoadFile, onPlay, onStop, onRewind, onSelectChannel, isPendingPlay }) {
    const inputRef = useRef(null);
    const [statusMessage, setStatusMessage] = useState('No sequence loaded');
    const [isLoading, setIsLoading] = useState(false);

    const handleFileChange = async (event) => {
        const file = event.target.files?.[0];

        if (!file) {
            return;
        }

        setIsLoading(true);

        try {
            const state = await onLoadFile(file);
            setStatusMessage(`Loaded ${state.fileName} on channel ${state.channelDisplay}`);
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

    const handleChannelChange = (event) => {
        const nextChannel = Number(event.target.value);

        try {
            const state = onSelectChannel(nextChannel);
            setStatusMessage(`Selected channel ${state.channelDisplay}`);
        } catch (error) {
            setStatusMessage(error instanceof Error ? error.message : 'Channel selection failed.');
        }
    };

    return (
        <div style={{
            height: '78px',
            background: '#161616',
            borderTop: '2px solid #444',
            display: 'flex',
            alignItems: 'center',
            gap: '18px',
            padding: '0 18px',
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

            <button
                onClick={() => inputRef.current?.click()}
                style={primaryButtonStyle}
                disabled={isLoading}
            >
                {isLoading ? 'Loading...' : 'Upload'}
            </button>

            <button
                onClick={handlePlay}
                style={controlButtonStyle}
                disabled={!transportState?.hasSequence || isLoading || isPendingPlay}
            >
                {isPendingPlay ? 'Starting...' : 'Play'}
            </button>

            <button
                onClick={handleStop}
                style={controlButtonStyle}
                disabled={!transportState?.hasSequence}
            >
                Stop
            </button>

            <button
                onClick={handleRewind}
                style={controlButtonStyle}
                disabled={!transportState?.hasSequence}
            >
                Rewind
            </button>

            <div style={{
                minWidth: '240px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px'
            }}>
                <div style={{ fontSize: '11px', letterSpacing: '0.08em', color: '#6f6f6f' }}>
                    SEQUENCE
                </div>
                <div style={{ fontSize: '13px', color: '#d9d9d9', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {transportState?.fileName ?? 'Empty slot'}
                </div>
            </div>

            <div style={{
                minWidth: '220px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px'
            }}>
                <div style={{ fontSize: '11px', letterSpacing: '0.08em', color: '#6f6f6f' }}>
                    STATUS
                </div>
                <div style={{ fontSize: '13px', color: transportState?.isPlaying ? '#9cff9c' : '#c8c8c8' }}>
                    {transportState?.isPlaying ? 'Playing' : statusMessage}
                </div>
            </div>

            <div style={{ marginLeft: 'auto', display: 'flex', gap: '22px', alignItems: 'center' }}>
                <div style={metaBlockStyle}>
                    <span style={metaLabelStyle}>CHANNEL</span>
                    <select
                        value={transportState?.channel ?? ''}
                        onChange={handleChannelChange}
                        disabled={!transportState?.availableChannels?.length || transportState?.isPlaying}
                        style={channelSelectStyle}
                    >
                        {transportState?.availableChannels?.map((channelData) => (
                            <option key={channelData.channel} value={channelData.channel}>
                                {channelData.channelDisplay}
                            </option>
                        ))}
                        {!transportState?.availableChannels?.length && (
                            <option value="">--</option>
                        )}
                    </select>
                </div>
                <div style={metaBlockStyle}>
                    <span style={metaLabelStyle}>EVENTS</span>
                    <span style={metaValueStyle}>{transportState?.eventCount ?? 0}</span>
                </div>
                <div style={metaBlockStyle}>
                    <span style={metaLabelStyle}>LENGTH</span>
                    <span style={metaValueStyle}>{formatDuration(transportState?.durationMs ?? 0)}</span>
                </div>
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

const channelSelectStyle = {
    minWidth: '68px',
    padding: '6px 8px',
    fontSize: '14px',
    color: '#f0f0f0',
    background: '#262626',
    border: '1px solid #5a5a5a',
    borderRadius: '4px',
    fontFamily: 'inherit'
};

export default Transport;