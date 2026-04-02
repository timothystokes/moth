import React, { useRef, useEffect, useCallback } from 'react';
import { noteNameToMidi, midiToNoteName, getBeatsPerBar } from '../audio/noteUtils.js';
import { triggerNoteOn, triggerNoteOff } from '../audio/sequencer.js';

const ROW_HEIGHT = 14;
const CELL_WIDTH = 24;
const KEY_WIDTH = 60;
const START_NOTE = 21;   // A0
const END_NOTE = 108;    // C8
const NOTE_COUNT = END_NOTE - START_NOTE + 1;
const BEAT_RESOLUTION = 0.25;
const RULER_HEIGHT = 20;

const BLACK_SEMITONES = new Set([1, 3, 6, 8, 10]);
const isBlack = (midi) => BLACK_SEMITONES.has(midi % 12);
const midiToRow = (midi) => END_NOTE - midi;
const rowToMidi = (row) => END_NOTE - row;

// Draw the keyboard canvas with DPR scaling for crisp text
function drawKeyboard(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = KEY_WIDTH;
    const cssH = NOTE_COUNT * ROW_HEIGHT;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    for (let row = 0; row < NOTE_COUNT; row++) {
        const midi = rowToMidi(row);
        const black = isBlack(midi);
        const y = row * ROW_HEIGHT;

        if (black) {
            ctx.fillStyle = '#282828';
            ctx.fillRect(0, y, KEY_WIDTH, ROW_HEIGHT);
            ctx.fillStyle = '#181818';
            ctx.fillRect(KEY_WIDTH * 0.55, y, KEY_WIDTH * 0.45, ROW_HEIGHT);
        } else {
            ctx.fillStyle = '#c2c2c2';
            ctx.fillRect(0, y, KEY_WIDTH, ROW_HEIGHT);
            ctx.fillStyle = '#aaa';
            ctx.fillRect(KEY_WIDTH - 3, y, 3, ROW_HEIGHT);
        }

        // Row separator
        ctx.strokeStyle = black ? '#111' : '#999';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y + ROW_HEIGHT - 0.5);
        ctx.lineTo(KEY_WIDTH, y + ROW_HEIGHT - 0.5);
        ctx.stroke();

        // C label
        if (midi % 12 === 0) {
            const oct = Math.floor(midi / 12) - 1;
            ctx.fillStyle = '#333';
            ctx.font = `bold 10px sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(`C${oct}`, 4, y + ROW_HEIGHT / 2);
        }
    }

    // Right border
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(KEY_WIDTH - 0.5, 0);
    ctx.lineTo(KEY_WIDTH - 0.5, cssH);
    ctx.stroke();
}

// Draw the note grid canvas
function drawGrid(canvas, { notes, beatsPerBar, totalCells, cellsPerBar, cellsPerBeat, dragPreview }) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = totalCells * CELL_WIDTH;
    const cssH = NOTE_COUNT * ROW_HEIGHT;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    // Row backgrounds
    for (let row = 0; row < NOTE_COUNT; row++) {
        const midi = rowToMidi(row);
        const y = row * ROW_HEIGHT;
        ctx.fillStyle = isBlack(midi) ? '#141416' : '#1c1c20';
        ctx.fillRect(0, y, cssW, ROW_HEIGHT);
        // Row separator
        ctx.strokeStyle = '#2e2e2e';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y + ROW_HEIGHT - 0.5);
        ctx.lineTo(cssW, y + ROW_HEIGHT - 0.5);
        ctx.stroke();
    }

    // Column lines
    for (let cell = 0; cell <= totalCells; cell++) {
        const x = cell * CELL_WIDTH + 0.5;
        const isBar = cell % cellsPerBar === 0;
        const isBeat = cell % cellsPerBeat === 0;
        ctx.strokeStyle = isBar ? '#424242' : isBeat ? '#2e2e2e' : '#222';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, cssH);
        ctx.stroke();
    }

    // Notes
    for (const n of notes) {
        if (!n.note) continue;
        const midi = noteNameToMidi(n.note);
        if (midi == null || midi < START_NOTE || midi > END_NOTE) continue;
        const row = midiToRow(midi);
        const abs = (n.bar - 1) * beatsPerBar + n.beat;
        const sc = Math.round(abs / BEAT_RESOLUTION);
        const dc = Math.max(1, Math.round((n.duration ?? BEAT_RESOLUTION) / BEAT_RESOLUTION));
        const vel = n.velocity ?? 0.8;
        ctx.fillStyle = `rgb(0,${Math.round(80 + vel * 175)},30)`;
        ctx.fillRect(sc * CELL_WIDTH + 1, row * ROW_HEIGHT + 1, Math.max(2, dc * CELL_WIDTH - 2), ROW_HEIGHT - 2);
    }

    // Drag preview
    if (dragPreview) {
        const { startCell, endCell, row } = dragPreview;
        const sc = Math.min(startCell, endCell);
        const dc = Math.abs(endCell - startCell) + 1;
        ctx.fillStyle = 'rgba(0,210,60,0.35)';
        ctx.fillRect(sc * CELL_WIDTH + 1, row * ROW_HEIGHT + 1, dc * CELL_WIDTH - 2, ROW_HEIGHT - 2);
    }
}

export default function PianoRoll({ track, timeSignatures, onNotesChange, selectedTrackId }) {
    const keyCanvasRef = useRef(null);
    const gridCanvasRef = useRef(null);
    const scrollRef = useRef(null);
    const rulerInnerRef = useRef(null);
    const dragRef = useRef(null);

    // Refs for imperative drawing — avoids React re-renders on every mousemove
    const notesRef = useRef(track?.notes ?? []);
    const dragPreviewRef = useRef(null);
    const drawParamsRef = useRef(null);

    const notes = track?.notes ?? [];
    const beatsPerBar = getBeatsPerBar(timeSignatures);
    const cellsPerBeat = Math.round(1 / BEAT_RESOLUTION);
    const cellsPerBar = beatsPerBar * cellsPerBeat;

    const maxAbsBeat = notes.reduce((max, n) => {
        const abs = (n.bar - 1) * beatsPerBar + n.beat + (n.duration ?? BEAT_RESOLUTION);
        return Math.max(max, abs);
    }, 0);
    const totalBars = Math.max(4, Math.ceil(maxAbsBeat / beatsPerBar) + 2);
    const totalCells = totalBars * cellsPerBar;

    // Keep refs in sync with current props/computed values
    drawParamsRef.current = { beatsPerBar, totalCells, cellsPerBar, cellsPerBeat };

    const redrawGrid = useCallback(() => {
        if (!gridCanvasRef.current) return;
        drawGrid(gridCanvasRef.current, {
            notes: notesRef.current,
            dragPreview: dragPreviewRef.current,
            ...drawParamsRef.current,
        });
    }, []);

    // Draw keyboard once on mount
    useEffect(() => {
        if (keyCanvasRef.current) drawKeyboard(keyCanvasRef.current);
    }, []);

    // Redraw grid when notes or grid dimensions change
    useEffect(() => {
        notesRef.current = notes;
        redrawGrid();
    }, [notes, beatsPerBar, totalCells, cellsPerBar, cellsPerBeat, redrawGrid]);

    // ── Audio helpers ────────────────────────────────────────────────────────
    const playingNoteRef = useRef(null);

    const playNote = useCallback((midi) => {
        if (!selectedTrackId) return;
        if (playingNoteRef.current != null) triggerNoteOff(selectedTrackId, playingNoteRef.current);
        playingNoteRef.current = midi;
        triggerNoteOn(selectedTrackId, midi, 0.8);
    }, [selectedTrackId]);

    const releaseCurrentNote = useCallback(() => {
        if (!selectedTrackId || playingNoteRef.current == null) return;
        triggerNoteOff(selectedTrackId, playingNoteRef.current);
        playingNoteRef.current = null;
    }, [selectedTrackId]);

    // ── Hit test ────────────────────────────────────────────────────────────
    const hitTest = useCallback((cx, cy) => {
        const clickCell = Math.floor(cx / CELL_WIDTH);
        const midi = rowToMidi(Math.floor(cy / ROW_HEIGHT));
        const noteName = midiToNoteName(midi);
        return notesRef.current.findIndex(n => {
            if (n.note !== noteName) return false;
            const abs = (n.bar - 1) * beatsPerBar + n.beat;
            const sc = Math.round(abs / BEAT_RESOLUTION);
            const dc = Math.max(1, Math.round((n.duration ?? BEAT_RESOLUTION) / BEAT_RESOLUTION));
            return clickCell >= sc && clickCell < sc + dc;
        });
    }, [beatsPerBar]);

    const getGridPos = (e) => {
        const rect = gridCanvasRef.current.getBoundingClientRect();
        return { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
    };

    const cellFromCx = (cx) => Math.max(0, Math.floor(cx / CELL_WIDTH));

    // ── Grid mouse events ────────────────────────────────────────────────────
    const handleGridMouseDown = useCallback((e) => {
        if (e.button !== 0) return;
        const { cx, cy } = getGridPos(e);
        const row = Math.floor(cy / ROW_HEIGHT);
        const midi = rowToMidi(row);
        if (midi < START_NOTE || midi > END_NOTE) return;

        playNote(midi);

        const hitIdx = hitTest(cx, cy);
        if (hitIdx >= 0) {
            dragRef.current = { deleteIdx: hitIdx, midi };
        } else {
            const cell = cellFromCx(cx);
            dragRef.current = { startCell: cell, endCell: cell, row, midi };
            dragPreviewRef.current = { startCell: cell, endCell: cell, row };
            redrawGrid();
        }
        e.preventDefault();
    }, [hitTest, playNote, redrawGrid]);

    const handleGridMouseMove = useCallback((e) => {
        const drag = dragRef.current;
        if (!drag || drag.deleteIdx != null) return;
        const { cx } = getGridPos(e);
        const cell = Math.max(drag.startCell, cellFromCx(cx));
        if (cell === drag.endCell) return; // no change
        drag.endCell = cell;
        dragPreviewRef.current = { startCell: drag.startCell, endCell: cell, row: drag.row };
        redrawGrid(); // direct draw, no React state
    }, [redrawGrid]);

    const handleGridMouseUp = useCallback(() => {
        const drag = dragRef.current;
        dragRef.current = null;
        dragPreviewRef.current = null;
        releaseCurrentNote();

        if (!drag) return;

        const existing = notesRef.current;
        if (drag.deleteIdx != null) {
            onNotesChange(existing.filter((_, i) => i !== drag.deleteIdx));
            return;
        }

        const sc = drag.startCell;
        const dc = (drag.endCell ?? sc) - sc + 1;
        const noteName = midiToNoteName(drag.midi);
        const absBeats = sc * BEAT_RESOLUTION;
        const bar = Math.floor(absBeats / beatsPerBar) + 1;
        const beat = Math.round((absBeats % beatsPerBar) * 10000) / 10000;
        onNotesChange([...existing, { note: noteName, bar, beat, duration: dc * BEAT_RESOLUTION, velocity: 0.8 }]);
    }, [beatsPerBar, onNotesChange, releaseCurrentNote]);

    // ── Keyboard mouse events ────────────────────────────────────────────────
    const getKeyMidi = (e) => {
        const rect = keyCanvasRef.current.getBoundingClientRect();
        return rowToMidi(Math.floor((e.clientY - rect.top) / ROW_HEIGHT));
    };

    const handleKeyMouseDown = useCallback((e) => {
        if (e.button !== 0) return;
        const midi = getKeyMidi(e);
        if (midi < START_NOTE || midi > END_NOTE) return;
        playNote(midi);
        e.preventDefault();
    }, [playNote]);

    const handleKeyMouseUp = useCallback(() => releaseCurrentNote(), [releaseCurrentNote]);
    const handleKeyMouseLeave = useCallback(() => releaseCurrentNote(), [releaseCurrentNote]);

    return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#111', minWidth: 0 }}>
            {/* Ruler */}
            <div style={{ display: 'flex', flexShrink: 0, height: RULER_HEIGHT, background: '#161616', borderBottom: '1px solid #2a2a2a', zIndex: 5, overflow: 'hidden' }}>
                <div style={{ width: KEY_WIDTH, flexShrink: 0, background: '#1a1a1a', borderRight: '1px solid #333' }} />
                <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                    <div ref={rulerInnerRef} style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: totalCells * CELL_WIDTH }}>
                        {Array.from({ length: totalBars }, (_, i) => (
                            <div key={i} style={{
                                position: 'absolute',
                                left: i * cellsPerBar * CELL_WIDTH,
                                width: cellsPerBar * CELL_WIDTH,
                                height: '100%',
                                display: 'flex', alignItems: 'center', paddingLeft: 5,
                                fontSize: '9px', color: '#555',
                                borderLeft: i > 0 ? '1px solid #2a2a2a' : 'none',
                                boxSizing: 'border-box', pointerEvents: 'none',
                            }}>
                                {i + 1}
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Scroll area: sticky keyboard + scrollable grid */}
            <div
                ref={scrollRef}
                style={{ flex: 1, overflow: 'auto', position: 'relative' }}
                onScroll={(e) => {
                    if (rulerInnerRef.current) rulerInnerRef.current.style.left = `-${e.target.scrollLeft}px`;
                }}
            >
                <div style={{ display: 'inline-flex', minWidth: '100%' }}>
                    {/* Keyboard — sticky to left edge */}
                    <div style={{ position: 'sticky', left: 0, zIndex: 4, flexShrink: 0 }}>
                        <canvas
                            ref={keyCanvasRef}
                            style={{ display: 'block', cursor: 'pointer' }}
                            onMouseDown={handleKeyMouseDown}
                            onMouseUp={handleKeyMouseUp}
                            onMouseLeave={handleKeyMouseLeave}
                        />
                    </div>
                    {/* Note grid */}
                    <canvas
                        ref={gridCanvasRef}
                        style={{ display: 'block', cursor: 'crosshair', flexShrink: 0 }}
                        onMouseDown={handleGridMouseDown}
                        onMouseMove={handleGridMouseMove}
                        onMouseUp={handleGridMouseUp}
                        onMouseLeave={handleGridMouseUp}
                    />
                </div>
            </div>
        </div>
    );
}
