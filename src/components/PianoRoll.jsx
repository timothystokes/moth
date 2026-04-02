import React, { useRef, useEffect, useCallback, useMemo } from 'react';
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

// Pre-computed SVG row-colour pattern: 12-row octave descending from C
// C B Bb A Ab G F# F E Eb D Db → W W B W B W B W W B W B
const ROW_PATTERN = (() => {
    const BLACK_IN_OCTAVE = new Set([2, 4, 6, 9, 11]);
    const h = ROW_HEIGHT * 12;
    const rects = Array.from({ length: 12 }, (_, r) =>
        `<rect x="0" y="${r * ROW_HEIGHT}" width="1" height="${ROW_HEIGHT}" fill="${BLACK_IN_OCTAVE.has(r) ? '#141416' : '#1c1c20'}"/>`
    ).join('');
    const lines = Array.from({ length: 11 }, (_, i) =>
        `<line x1="0" y1="${(i + 1) * ROW_HEIGHT - .5}" x2="1" y2="${(i + 1) * ROW_HEIGHT - .5}" stroke="#252528" stroke-width=".5"/>`
    ).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="${h}">${rects}${lines}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
})();

// SVG column-line pattern: one bar wide, tiles horizontally
// Three brightness levels: sub-beat (dimmest) → beat/quarter-note → bar (brightest)
function makeColBg(cellsPerBar, cellsPerBeat) {
    const w = cellsPerBar * CELL_WIDTH;
    // Draw dimmest first so brighter lines paint on top
    const subLines = [], beatLines = [], barLines = [];
    for (let c = 1; c < cellsPerBar; c++) {
        const x = c * CELL_WIDTH + .5;
        const line = (color) => `<line x1="${x}" y1="0" x2="${x}" y2="1" stroke="${color}" stroke-width="1"/>`;
        if (c % cellsPerBeat === 0) beatLines.push(line('#505068'));
        else subLines.push(line('#282832'));
    }
    // Bar line at left edge of tile (x=0 wraps to form bar boundary when tiled)
    barLines.push(`<line x1=".5" y1="0" x2=".5" y2="1" stroke="#7878a0" stroke-width="1"/>`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="1">${[...subLines, ...beatLines, ...barLines].join('')}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// Keyboard: canvas drawn once on mount (crisp DPR text, never changes)
function drawKeyboard(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = KEY_WIDTH;
    const cssH = NOTE_COUNT * ROW_HEIGHT;
    const physW = Math.round(cssW * dpr);
    const physH = Math.round(cssH * dpr);
    if (canvas.width === physW && canvas.height === physH) return;
    canvas.width = physW;
    canvas.height = physH;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Base white keys
    ctx.fillStyle = '#c2c2c2';
    ctx.fillRect(0, 0, KEY_WIDTH, cssH);
    // Black key fills
    ctx.fillStyle = '#282828';
    for (let row = 0; row < NOTE_COUNT; row++) {
        if (isBlack(rowToMidi(row))) ctx.fillRect(0, row * ROW_HEIGHT, KEY_WIDTH, ROW_HEIGHT);
    }
    ctx.fillStyle = '#181818';
    for (let row = 0; row < NOTE_COUNT; row++) {
        if (isBlack(rowToMidi(row))) ctx.fillRect(KEY_WIDTH * 0.55, row * ROW_HEIGHT, KEY_WIDTH * 0.45, ROW_HEIGHT);
    }
    // White key right edge
    ctx.fillStyle = '#aaa';
    for (let row = 0; row < NOTE_COUNT; row++) {
        if (!isBlack(rowToMidi(row))) ctx.fillRect(KEY_WIDTH - 3, row * ROW_HEIGHT, 3, ROW_HEIGHT);
    }
    // Row separators (batched)
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = '#999';
    ctx.beginPath();
    for (let row = 1; row < NOTE_COUNT; row++) {
        if (!isBlack(rowToMidi(row))) { ctx.moveTo(0, row * ROW_HEIGHT - .5); ctx.lineTo(KEY_WIDTH, row * ROW_HEIGHT - .5); }
    }
    ctx.stroke();
    ctx.strokeStyle = '#111';
    ctx.beginPath();
    for (let row = 1; row < NOTE_COUNT; row++) {
        if (isBlack(rowToMidi(row))) { ctx.moveTo(0, row * ROW_HEIGHT - .5); ctx.lineTo(KEY_WIDTH, row * ROW_HEIGHT - .5); }
    }
    ctx.stroke();
    // C labels
    ctx.fillStyle = '#333';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let row = 0; row < NOTE_COUNT; row++) {
        const midi = rowToMidi(row);
        if (midi % 12 === 0) ctx.fillText(`C${Math.floor(midi / 12) - 1}`, 4, row * ROW_HEIGHT + ROW_HEIGHT / 2);
    }
    // Right border
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(KEY_WIDTH - .5, 0);
    ctx.lineTo(KEY_WIDTH - .5, cssH);
    ctx.stroke();
}

export default function PianoRoll({ track, timeSignatures, onNotesChange, selectedTrackId }) {
    const keyCanvasRef = useRef(null);
    const gridDivRef = useRef(null);
    const dragGhostRef = useRef(null);
    const scrollRef = useRef(null);
    const rulerInnerRef = useRef(null);
    const dragRef = useRef(null);
    const notesRef = useRef(track?.notes ?? []);

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

    const colBg = useMemo(() => makeColBg(cellsPerBar, cellsPerBeat), [cellsPerBar, cellsPerBeat]);

    // Keep notesRef in sync with prop
    useEffect(() => { notesRef.current = notes; }, [notes]);

    // Draw keyboard once on mount (never needs redrawing)
    useEffect(() => {
        if (keyCanvasRef.current) drawKeyboard(keyCanvasRef.current);
    }, []);

    // ── Audio ────────────────────────────────────────────────────────────────
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

    // ── Hit test ─────────────────────────────────────────────────────────────
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
        const rect = gridDivRef.current.getBoundingClientRect();
        return { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
    };

    const cellFromCx = (cx) => Math.max(0, Math.floor(cx / CELL_WIDTH));

    // Imperatively update ghost div — no React state, zero re-render overhead
    const updateDragGhost = (startCell, endCell, row) => {
        const ghost = dragGhostRef.current;
        if (!ghost) return;
        const sc = Math.min(startCell, endCell);
        const dc = Math.abs(endCell - startCell) + 1;
        ghost.style.left = `${sc * CELL_WIDTH + 1}px`;
        ghost.style.top = `${row * ROW_HEIGHT + 1}px`;
        ghost.style.width = `${dc * CELL_WIDTH - 2}px`;
        ghost.style.display = 'block';
    };

    // ── Grid mouse events ─────────────────────────────────────────────────────
    const handleMouseDown = useCallback((e) => {
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
            updateDragGhost(cell, cell, row);
        }
        e.preventDefault();
    }, [hitTest, playNote]);

    const handleMouseMove = useCallback((e) => {
        const drag = dragRef.current;
        if (!drag || drag.deleteIdx != null) return;
        const { cx } = getGridPos(e);
        const cell = Math.max(drag.startCell, cellFromCx(cx));
        if (cell === drag.endCell) return;
        drag.endCell = cell;
        updateDragGhost(drag.startCell, cell, drag.row);
    }, []);

    const handleMouseUp = useCallback(() => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (dragGhostRef.current) dragGhostRef.current.style.display = 'none';
        releaseCurrentNote();

        if (!drag) return;

        const existing = notesRef.current;
        let nextNotes;

        if (drag.deleteIdx != null) {
            nextNotes = existing.filter((_, i) => i !== drag.deleteIdx);
        } else {
            const sc = drag.startCell;
            const dc = (drag.endCell ?? sc) - sc + 1;
            const noteName = midiToNoteName(drag.midi);
            const absBeats = sc * BEAT_RESOLUTION;
            const bar = Math.floor(absBeats / beatsPerBar) + 1;
            const beat = Math.round((absBeats % beatsPerBar) * 10000) / 10000;
            const newNote = { note: noteName, bar, beat, duration: dc * BEAT_RESOLUTION, velocity: 0.8 };
            // Remove any existing notes on the same pitch that overlap the new note's range
            const without = existing.filter(n => {
                if (n.note !== noteName) return true;
                const nAbs = (n.bar - 1) * beatsPerBar + n.beat;
                const nSc = Math.round(nAbs / BEAT_RESOLUTION);
                const nDc = Math.max(1, Math.round((n.duration ?? BEAT_RESOLUTION) / BEAT_RESOLUTION));
                return nSc + nDc <= sc || nSc >= sc + dc; // entirely before or after
            });
            nextNotes = [...without, newNote];
        }

        notesRef.current = nextNotes;
        onNotesChange(nextNotes);
    }, [beatsPerBar, onNotesChange, releaseCurrentNote]);

    // ── Keyboard mouse events ─────────────────────────────────────────────────
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
                    {/* Keyboard — sticky to left edge, drawn once */}
                    <div style={{ position: 'sticky', left: 0, zIndex: 4, flexShrink: 0 }}>
                        <canvas
                            ref={keyCanvasRef}
                            style={{ display: 'block', cursor: 'pointer' }}
                            onMouseDown={handleKeyMouseDown}
                            onMouseUp={handleKeyMouseUp}
                            onMouseLeave={handleKeyMouseLeave}
                        />
                    </div>

                    {/* Grid — CSS backgrounds, note divs, drag ghost */}
                    <div
                        ref={gridDivRef}
                        style={{
                            position: 'relative',
                            width: totalCells * CELL_WIDTH,
                            height: NOTE_COUNT * ROW_HEIGHT,
                            flexShrink: 0,
                            backgroundImage: `${colBg}, ${ROW_PATTERN}`,
                            backgroundSize: `${cellsPerBar * CELL_WIDTH}px 1px, 1px ${12 * ROW_HEIGHT}px`,
                            backgroundRepeat: 'repeat, repeat',
                            cursor: 'crosshair',
                        }}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseUp}
                    >
                        {notes.map((note, i) => {
                            if (!note.note) return null;
                            const midi = noteNameToMidi(note.note);
                            if (midi == null || midi < START_NOTE || midi > END_NOTE) return null;
                            const row = midiToRow(midi);
                            const abs = (note.bar - 1) * beatsPerBar + note.beat;
                            const sc = Math.round(abs / BEAT_RESOLUTION);
                            const dc = Math.max(1, Math.round((note.duration ?? BEAT_RESOLUTION) / BEAT_RESOLUTION));
                            const vel = note.velocity ?? 0.8;
                            return (
                                <div key={i} style={{
                                    position: 'absolute',
                                    left: sc * CELL_WIDTH + 1,
                                    top: row * ROW_HEIGHT + 1,
                                    width: Math.max(2, dc * CELL_WIDTH - 2),
                                    height: ROW_HEIGHT - 2,
                                    background: `rgb(0,${Math.round(80 + vel * 175)},30)`,
                                    borderRadius: 2,
                                    pointerEvents: 'none',
                                    boxSizing: 'border-box',
                                }} />
                            );
                        })}

                        {/* Drag ghost — imperatively updated, zero React overhead on mousemove */}
                        <div ref={dragGhostRef} style={{
                            position: 'absolute',
                            display: 'none',
                            background: 'rgba(0,210,60,0.45)',
                            height: ROW_HEIGHT - 2,
                            borderRadius: 2,
                            pointerEvents: 'none',
                        }} />
                    </div>
                </div>
            </div>
        </div>
    );
}
