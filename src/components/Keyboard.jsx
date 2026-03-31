import React, { useState, useEffect, useRef } from 'react';
import {
    triggerNoteOn,
    triggerNoteOff,
    initializeMidi,
    onNoteOn,
    onNoteOff,
    getMidiInputs,
    selectMidiInput,
    setMidiChannel,
    getMidiChannel,
    subscribeMidiStateChange
} from '../audio/sequencer.js';
import OutputPort from './OutputPort.jsx';

function Keyboard({ module, onOutputClick, isConnecting, isFixed, selectedTrackId, selectedTrackLabel }) {
    // Musical keyboard state - just for UI display now
    const [activeNote, setActiveNote] = useState(null); // { noteNumber, velocity }
    const [hoveredKey, setHoveredKey] = useState(null);
    const [midiInputs, setMidiInputs] = useState([]);
    const [selectedMidiInputId, setSelectedMidiInputId] = useState(null);
    const [midiChannel, setMidiChannelState] = useState('all'); // 'all' or 0-15
    const activeNoteRef = useRef(null); // Track active note for mouse up handler
    const lastPressedCvRef = useRef(0);
    
    // Initialize MIDI on mount
    useEffect(() => {
        initializeMidi().then(() => {
            const inputs = getMidiInputs();
            setMidiInputs(inputs);
            if (inputs.length > 0) setSelectedMidiInputId(inputs[0].id);
        });

        const unsubscribe = subscribeMidiStateChange((inputs) => {
            setMidiInputs(inputs);
        });

        return () => unsubscribe();
    }, []);

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
        const unsubscribeNoteOn = onNoteOn(({ trackId, noteNumber, velocity }) => {
            if (trackId !== selectedTrackId) {
                return;
            }

            lastPressedCvRef.current = (noteNumber - 69) / 12;
            setActiveNote({ noteNumber, velocity });
        });

        const unsubscribeNoteOff = onNoteOff(({ trackId, noteNumber }) => {
            if (trackId !== selectedTrackId) {
                return;
            }

            setActiveNote((current) => {
                if (!current || current.noteNumber !== noteNumber) {
                    return current;
                }

                return null;
            });
        });

        return () => {
            unsubscribeNoteOn();
            unsubscribeNoteOff();
        };
    }, [selectedTrackId]);

    useEffect(() => {
        setActiveNote(null);
        activeNoteRef.current = null;
    }, [selectedTrackId]);
    
    const handleMouseDown = (note) => {
        if (!selectedTrackId) {
            return;
        }

        const noteData = { noteNumber: note.noteNumber, velocity: 0.8 };
        setActiveNote(noteData);
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
            activeNoteRef.current = null;
        }
        setActiveNote(null);
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
    
    const handleMidiInputChange = (e) => {
        const id = e.target.value;
        setSelectedMidiInputId(id);
        if (id) selectMidiInput(id);
    };

    const handleMidiChannelChange = (e) => {
        const val = e.target.value;
        setMidiChannelState(val);
        setMidiChannel(val === 'all' ? null : parseInt(val, 10));
    };

    const keyHeight = 12; // Smaller height per key to fit 88 keys
    const whiteKeyWidth = 140; // Match panel width
    const blackKeyWidth = 90;
    
    const containerHeight = notes.filter(n => !n.isBlack).length * keyHeight;
    
    return (
        <div style={{
            width: isFixed ? '100%' : '180px',
            height: isFixed ? '100%' : 'auto',
            background: '#333',
            border: isFixed ? 'none' : '2px solid #555',
            borderRadius: isFixed ? '0' : '4px',
            padding: 0,
            position: isFixed ? 'relative' : 'absolute',
            boxShadow: isFixed ? 'none' : '0 4px 8px rgba(0,0,0,0.3)',
            display: 'flex',
            flexDirection: 'column'
        }}>
            {/* Header Banner */}
            <div style={{
                fontSize: '12px',
                fontWeight: 'bold',
                padding: '10px',
                color: '#888',
                background: '#2a2a2a',
                borderBottom: '1px solid #555',
                borderRadius: isFixed ? '0' : '2px 2px 0 0'
            }}>
                KEYBOARD
            </div>

            {/* MIDI Device + Channel selectors */}
            <div style={{ padding: '8px 10px', background: '#252525', borderBottom: '1px solid #3a3a3a', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div>
                    <label style={{ fontSize: '9px', color: '#777', display: 'block', marginBottom: '3px', letterSpacing: '0.05em' }}>MIDI IN</label>
                    <select
                        value={selectedMidiInputId || ''}
                        onChange={handleMidiInputChange}
                        style={{ width: '100%', background: '#1a1a1a', border: '1px solid #444', color: '#ccc', fontSize: '10px', padding: '3px 4px', borderRadius: '3px' }}
                    >
                        {midiInputs.length === 0 && <option value="">No MIDI devices</option>}
                        {midiInputs.map(input => (
                            <option key={input.id} value={input.id}>{input.name}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label style={{ fontSize: '9px', color: '#777', display: 'block', marginBottom: '3px', letterSpacing: '0.05em' }}>CHANNEL</label>
                    <select
                        value={midiChannel}
                        onChange={handleMidiChannelChange}
                        style={{ width: '100%', background: '#1a1a1a', border: '1px solid #444', color: '#ccc', fontSize: '10px', padding: '3px 4px', borderRadius: '3px' }}
                    >
                        <option value="all">All</option>
                        {Array.from({ length: 16 }, (_, i) => (
                            <option key={i} value={i}>{i + 1}</option>
                        ))}
                    </select>
                </div>
            </div>

            <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                {/* Output port: CV OUT */}
                <OutputPort moduleId={module.id} portId="cv-out" label="CV OUT"
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    title="CV Out (1V/octave)" />

                {/* Output port: GATE OUT */}
                <OutputPort moduleId={module.id} portId="gate-out" label="GATE OUT"
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    title="Gate Out (+5V high, 0V low)" />

                <OutputPort moduleId={module.id} portId="velocity-out" label="VELOCITY OUT"
                    onOutputClick={onOutputClick} isConnecting={isConnecting}
                    title="Velocity Out (0–5V)" />
                
                {/* Keyboard display */}
                <div style={{
                    flex: 1,
                    position: 'relative',
                    overflow: 'auto',
                    border: '1px solid #555',
                    borderRadius: '4px',
                    background: '#0a0a0a',
                    minHeight: 0
                }}>
                    <div style={{
                    position: 'relative',
                    height: `${containerHeight}px`,
                    userSelect: 'none'
                }}>
                    {/* Draw white keys first */}
                    {notes.filter(note => !note.isBlack).map((note, index) => {
                        const isActive = activeNote?.noteNumber === note.noteNumber;
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
                                    left: 0,
                                    width: `${whiteKeyWidth}px`,
                                    height: `${keyHeight}px`,
                                    background: isActive ? '#0a0' : (isHovered ? '#ddd' : '#fff'),
                                    border: '1px solid #000',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    paddingLeft: '5px',
                                    fontSize: '10px',
                                    fontWeight: 'bold',
                                    color: isActive ? '#fff' : '#000',
                                    transition: 'background 0.05s'
                                }}
                            >
                                {note.noteName}
                            </div>
                        );
                    })}
                    
                    {/* Draw black keys on top */}
                    {notes.filter(note => note.isBlack).map((note) => {
                        const isActive = activeNote?.noteNumber === note.noteNumber;
                        const isHovered = hoveredKey === note.noteNumber;
                        
                        // Calculate position based on surrounding white keys
                        const whiteKeyIndex = notes.filter(n => !n.isBlack && n.noteNumber > note.noteNumber).length;
                        const topPosition = whiteKeyIndex * keyHeight - keyHeight / 2;
                        
                        return (
                            <div
                                key={note.noteNumber}
                                onMouseDown={() => handleMouseDown(note)}
                                onMouseEnter={() => handleMouseEnter(note)}
                                onMouseLeave={handleMouseLeave}
                                style={{
                                    position: 'absolute',
                                    top: `${topPosition}px`,
                                    left: 0,
                                    width: `${blackKeyWidth}px`,
                                    height: `${keyHeight}px`,
                                    background: isActive ? '#0a0' : (isHovered ? '#555' : '#222'),
                                    border: '1px solid #000',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    paddingLeft: '5px',
                                    fontSize: '9px',
                                    fontWeight: 'bold',
                                    color: isActive ? '#000' : '#fff',
                                    zIndex: 10,
                                    transition: 'background 0.05s'
                                }}
                            >
                                {note.noteName}
                            </div>
                        );
                    })}
                </div>
            </div>
            
            {/* Active note display */}
            <div style={{
                marginTop: '10px',
                fontSize: '11px',
                color: '#888',
                textAlign: 'center',
                minHeight: '35px',
                display: 'flex',
                flexDirection: 'column',
                gap: '3px'
            }}>
                {activeNote ? (
                    <>
                        <div style={{ color: '#0f0' }}>{notes.find(n => n.noteNumber === activeNote.noteNumber)?.noteName}</div>
                        <div style={{ fontSize: '9px', color: '#666' }}>
                            {((activeNote.noteNumber - 36) / 12).toFixed(2)}V
                        </div>
                    </>
                ) : (
                    <div>---</div>
                )}
            </div>
        </div>
        </div>
    );
}

export default Keyboard;
