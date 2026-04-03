import React, { useState, useEffect, useRef } from 'react';
import {
    triggerNoteOn,
    triggerNoteOff,
    onNoteOn,
    onNoteOff,
} from '../audio/sequencer.js';
import OutputPort from './OutputPort.jsx';
import ModuleShell from './ModuleShell.jsx';

function Keyboard({ module, onOutputClick, isConnecting, isFixed, selectedTrackId, selectedTrackLabel, scrollContainerRef, onKeyboardScroll }) {
    const [activeNotes, setActiveNotes] = useState(new Set());
    const [hoveredKey, setHoveredKey] = useState(null);
    const activeNoteRef = useRef(null);
    const lastPressedCvRef = useRef(0);

    // Define keyboard layout: 88 keys (A0 to C8) - full piano range
    // Note numbers: A0=21 (MIDI), C8=108
    const startNote = 21; // A0
    const endNote = 108;   // C8 (88 keys total)
    const notes = [];
    
    // Build note array with black/white key info
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const blackKeys = [1, 3, 6, 8, 10]; // Sharp keys
    
    for (let i = startNote; i <= endNote; i++) {
        const noteName = noteNames[i % 12];
        const octave = Math.floor(i / 12) - 1;
        const isBlack = blackKeys.includes(i % 12);
        notes.push({
            noteNumber: i,
            noteName: `${noteName}${octave}`,
            isBlack
        });
    }
    
    // Reverse for vertical display (high notes at top)
    notes.reverse();

    useEffect(() => {
        const unsubscribeNoteOn = onNoteOn(({ trackId, noteNumber }) => {
            if (trackId !== selectedTrackId) return;
            lastPressedCvRef.current = (noteNumber - 69) / 12;
            setActiveNotes(prev => new Set([...prev, noteNumber]));
        });

        const unsubscribeNoteOff = onNoteOff(({ trackId, noteNumber }) => {
            if (trackId !== selectedTrackId) return;
            setActiveNotes(prev => { const s = new Set(prev); s.delete(noteNumber); return s; });
        });

        return () => {
            unsubscribeNoteOn();
            unsubscribeNoteOff();
        };
    }, [selectedTrackId]);

    useEffect(() => {
        setActiveNotes(new Set());
        activeNoteRef.current = null;
    }, [selectedTrackId]);
    
    const handleMouseDown = (note) => {
        if (!selectedTrackId) {
            return;
        }

        setActiveNotes(prev => new Set([...prev, note.noteNumber]));
        activeNoteRef.current = {
            trackId: selectedTrackId,
            noteNumber: note.noteNumber
        };
        lastPressedCvRef.current = (note.noteNumber - 69) / 12;
        triggerNoteOn(selectedTrackId, note.noteNumber, 0.8);
    };
    
    const handleMouseUp = () => {
        if (activeNoteRef.current) {
            triggerNoteOff(activeNoteRef.current.trackId, activeNoteRef.current.noteNumber);
            setActiveNotes(prev => { const s = new Set(prev); s.delete(activeNoteRef.current?.noteNumber); return s; });
            activeNoteRef.current = null;
        }
    };
    
    const handleMouseEnter = (note) => {
        setHoveredKey(note.noteNumber);
    };
    
    const handleMouseLeave = () => {
        setHoveredKey(null);
    };
    
    // Add global mouse up listener
    useEffect(() => {
        const handleGlobalMouseUp = () => {
            handleMouseUp();
        };
        
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
    }, []); // Empty deps - handleMouseUp is stable because it uses ref
    
    const keyHeight = 12;
    const blackKeyWidthPct = 60; // % of white key width
    const containerHeight = notes.filter(n => !n.isBlack).length * keyHeight;

    return (
        <ModuleShell isFixed>
            {/* Vertical layout: ports on top, scrollable keys below */}
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 4 }}>
                {/* Ports */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 2 }}>
                    <OutputPort moduleId={module.id} portId="cv-out" label="CV"
                        onOutputClick={onOutputClick} isConnecting={isConnecting}
                        title="CV Out (1V/octave)" />
                    <OutputPort moduleId={module.id} portId="gate-out" label="GATE"
                        onOutputClick={onOutputClick} isConnecting={isConnecting}
                        title="Gate Out (+5V high, 0V low)" />
                    <OutputPort moduleId={module.id} portId="velocity-out" label="VEL"
                        onOutputClick={onOutputClick} isConnecting={isConnecting}
                        title="Velocity Out (0–5V)" />
                </div>

                {/* Keyboard — scrollable, takes remaining height */}
                <div
                    ref={scrollContainerRef}
                    onScroll={onKeyboardScroll}
                    className="keyboard-keys"
                    style={{
                        flex: 1,
                        position: 'relative',
                        overflow: 'auto',
                        minHeight: 0,
                        scrollbarWidth: 'none',
                        msOverflowStyle: 'none',
                    }}
                >
                    <div style={{ position: 'relative', height: `${containerHeight}px`, width: '100%', userSelect: 'none' }}>
                        {/* White keys */}
                        {notes.filter(note => !note.isBlack).map((note, index) => {
                            const isActive = activeNotes.has(note.noteNumber);
                            const isHovered = hoveredKey === note.noteNumber;
                            return (
                                <div
                                    key={note.noteNumber}
                                    onMouseDown={() => handleMouseDown(note)}
                                    onMouseEnter={() => handleMouseEnter(note)}
                                    onMouseLeave={handleMouseLeave}
                                    style={{
                                        position: 'absolute',
                                        top: `${index * keyHeight}px`,
                                        left: 1,
                                        width: '100%',
                                        height: `${keyHeight}px`,
                                        background: isActive ? '#0a0' : (isHovered ? '#eee' : '#eee'),
                                        border: '1px solid #000',
                                        cursor: 'pointer',
                                        boxSizing: 'border-box',
                                        transition: 'background 0.05s',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'flex-end',
                                        paddingRight: 2,
                                        overflow: 'hidden',
                                        borderTopRightRadius: 3,
                                        borderBottomRightRadius: 3
                                    }}
                                    title={note.noteName}
                                >
                                    {note.noteName.startsWith('C') && !note.noteName.includes('#') && (
                                        <span style={{ fontSize: '9px', color: isActive ? '#fff' : '#000', lineHeight: 1, pointerEvents: 'none', userSelect: 'none' }}>
                                            {note.noteName}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                        {/* Black keys */}
                        {notes.filter(note => note.isBlack).map((note) => {
                            const isActive = activeNotes.has(note.noteNumber);
                            const isHovered = hoveredKey === note.noteNumber;
                            const whiteKeyIndex = notes.filter(n => !n.isBlack && n.noteNumber > note.noteNumber).length;
                            return (
                                <div
                                    key={note.noteNumber}
                                    onMouseDown={() => handleMouseDown(note)}
                                    onMouseEnter={() => handleMouseEnter(note)}
                                    onMouseLeave={handleMouseLeave}
                                    style={{
                                        position: 'absolute',
                                        top: `${whiteKeyIndex * keyHeight - keyHeight / 2 + 1}px`,
                                        left: 0,
                                        width: `${blackKeyWidthPct}%`,
                                        height: `${keyHeight - 2}px`,
                                        background: isActive ? '#0a0' : (isHovered ? '#111' : '#111'),
                                        cursor: 'pointer',
                                        zIndex: 10,
                                        borderTopRightRadius: 3,
                                        borderBottomRightRadius: 3
                                    }}
                                />
                            );
                        })}
                    </div>
                </div>
            </div>
        </ModuleShell>
    );
}

export default Keyboard;
