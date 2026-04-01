import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import { noteNameToMidi, midiToNoteName, getBeatsPerBar } from '../audio/noteUtils.js';

const ROW_HEIGHT = 8;       // px per semitone (chromatic grid)
const CELL_WIDTH = 20;      // px per 1/4-beat cell
const START_NOTE = 21;      // A0 (lowest)
const END_NOTE = 108;       // C8 (highest)
const NOTE_COUNT = END_NOTE - START_NOTE + 1; // 88
const BEAT_RESOLUTION = 0.25;
const RULER_HEIGHT = 20;

const BLACK_SEMITONES = new Set([1, 3, 6, 8, 10]); // relative to octave
function isBlack(midi) { return BLACK_SEMITONES.has(midi % 12); }

export default function PianoRoll({ track, timeSignatures, onNotesChange, scrollRef, onScroll }) {
    const canvasRef = useRef(null);
    const notes = track?.notes ?? [];
    const beatsPerBar = getBeatsPerBar(timeSignatures);
    const cellsPerBeat = Math.round(1 / BEAT_RESOLUTION); // 4
    const cellsPerBar = beatsPerBar * cellsPerBeat;        // 16 for 4/4

    // Total bars: cover existing content + 2 empty bars minimum 4
    const maxAbsBeat = notes.reduce((max, n) => {
        const abs = (n.bar - 1) * beatsPerBar + n.beat + (n.duration ?? BEAT_RESOLUTION);
        return Math.max(max, abs);
    }, 0);
    const totalBars = Math.max(4, Math.ceil(maxAbsBeat / beatsPerBar) + 2);
    const totalCells = totalBars * cellsPerBar;
    const canvasWidth = totalCells * CELL_WIDTH;
    const canvasHeight = NOTE_COUNT * ROW_HEIGHT;

    // Build a lookup: `${midi}-${startCell}` → note index in array
    const noteMap = useMemo(() => {
        const map = new Map();
        notes.forEach((n, i) => {
            if (!n.note) return;
            const midi = noteNameToMidi(n.note);
            if (midi == null) return;
            const abs = (n.bar - 1) * beatsPerBar + n.beat;
            const startCell = Math.round(abs / BEAT_RESOLUTION);
            map.set(`${midi}-${startCell}`, i);
        });
        return map;
    }, [notes, beatsPerBar]);

    // Draw grid + notes on canvas
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);

        // Row backgrounds
        for (let row = 0; row < NOTE_COUNT; row++) {
            const midi = END_NOTE - row;
            ctx.fillStyle = isBlack(midi) ? '#141418' : '#1e1e1e';
            ctx.fillRect(0, row * ROW_HEIGHT, canvasWidth, ROW_HEIGHT);
            // C note divider
            if (midi % 12 === 0) {
                ctx.strokeStyle = '#383838';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(0, row * ROW_HEIGHT + 0.5);
                ctx.lineTo(canvasWidth, row * ROW_HEIGHT + 0.5);
                ctx.stroke();
            }
        }

        // Column lines
        for (let cell = 0; cell <= totalCells; cell++) {
            const x = cell * CELL_WIDTH + 0.5;
            const isBarLine = cell % cellsPerBar === 0;
            const isBeatLine = cell % cellsPerBeat === 0;
            ctx.strokeStyle = isBarLine ? '#484848' : isBeatLine ? '#2c2c2c' : '#222';
            ctx.lineWidth = isBarLine ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, canvasHeight);
            ctx.stroke();
        }

        // Notes
        for (const n of notes) {
            if (!n.note) continue;
            const midi = noteNameToMidi(n.note);
            if (midi == null || midi < START_NOTE || midi > END_NOTE) continue;
            const row = END_NOTE - midi;
            const abs = (n.bar - 1) * beatsPerBar + n.beat;
            const startCell = Math.round(abs / BEAT_RESOLUTION);
            const durationCells = Math.max(1, Math.round((n.duration ?? BEAT_RESOLUTION) / BEAT_RESOLUTION));
            const x = startCell * CELL_WIDTH + 1;
            const y = row * ROW_HEIGHT + 1;
            const w = Math.max(2, durationCells * CELL_WIDTH - 2);
            const h = ROW_HEIGHT - 2;
            const vel = n.velocity ?? 0.8;
            const g = Math.round(80 + vel * 175);
            ctx.fillStyle = `rgb(0, ${g}, 30)`;
            ctx.fillRect(x, y, w, h);
        }
    }, [notes, canvasWidth, canvasHeight, totalCells, cellsPerBar, cellsPerBeat, beatsPerBar]);

    const handleClick = useCallback((e) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const cx = (e.clientX - rect.left) * scaleX;
        const cy = (e.clientY - rect.top) * scaleY;

        const clickCell = Math.floor(cx / CELL_WIDTH);
        const rowIdx = Math.floor(cy / ROW_HEIGHT);
        const midi = END_NOTE - rowIdx;
        if (midi < START_NOTE || midi > END_NOTE || clickCell < 0 || clickCell >= totalCells) return;

        const noteName = midiToNoteName(midi);
        const existingNotes = track?.notes ?? [];

        // Check if click falls within any existing note span for this pitch
        const hitIdx = existingNotes.findIndex(n => {
            if (n.note !== noteName) return false;
            const abs = (n.bar - 1) * beatsPerBar + n.beat;
            const startCell = Math.round(abs / BEAT_RESOLUTION);
            const durationCells = Math.max(1, Math.round((n.duration ?? BEAT_RESOLUTION) / BEAT_RESOLUTION));
            return clickCell >= startCell && clickCell < startCell + durationCells;
        });

        if (hitIdx >= 0) {
            onNotesChange(existingNotes.filter((_, i) => i !== hitIdx));
        } else {
            const absBeats = clickCell * BEAT_RESOLUTION;
            const bar = Math.floor(absBeats / beatsPerBar) + 1;
            const beat = Math.round((absBeats % beatsPerBar) * 10000) / 10000;
            onNotesChange([...existingNotes, { note: noteName, bar, beat, duration: BEAT_RESOLUTION, velocity: 0.8 }]);
        }
    }, [notes, track, totalCells, beatsPerBar, onNotesChange]);

    return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#111', minWidth: 0 }}>
            <div
                ref={scrollRef}
                onScroll={onScroll}
                style={{ flex: 1, overflow: 'auto' }}
            >
                {/* Bar ruler — sticky so it stays visible when scrolling down */}
                <div style={{
                    position: 'sticky',
                    top: 0,
                    zIndex: 10,
                    height: RULER_HEIGHT,
                    width: canvasWidth,
                    background: '#1a1a1a',
                    borderBottom: '1px solid #333',
                }}>
                    {Array.from({ length: totalBars }, (_, i) => (
                        <div key={i} style={{
                            position: 'absolute',
                            left: i * cellsPerBar * CELL_WIDTH + 3,
                            top: 0,
                            height: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            fontSize: '9px',
                            color: '#666',
                            pointerEvents: 'none',
                            borderLeft: i > 0 ? '1px solid #333' : 'none',
                            paddingLeft: i > 0 ? 3 : 0,
                        }}>
                            {i + 1}
                        </div>
                    ))}
                </div>
                <canvas
                    ref={canvasRef}
                    onClick={handleClick}
                    style={{ display: 'block', cursor: 'crosshair' }}
                />
            </div>
        </div>
    );
}
