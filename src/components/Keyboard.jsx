import React, { useState, useEffect, useRef } from 'react';
import { registerModule } from '../audio/audioEngine.js';

function Keyboard({ module, onOutputClick, isConnecting, audioContext, isFixed }) {
    // Musical keyboard state
    const [activeNote, setActiveNote] = useState(null); // { noteNumber, velocity }
    const [hoveredKey, setHoveredKey] = useState(null);
    const lastNoteRef = useRef(null); // Hold the last note CV even after release
    
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
    
    // Register audio processing function
    useEffect(() => {
        if (!audioContext) return;
        
        // Update lastNoteRef when activeNote changes
        if (activeNote) {
            lastNoteRef.current = activeNote.noteNumber;
        }
        
        // Register CV output (frequency voltage)
        const cvProcessorFn = (time, inputFns) => {
            // No inputs for keyboard - it's a source
            // Output: frequency in 1V per octave format
            // Reference: C2 (MIDI 36) = 0V, each semitone up adds 1/12V
            
            // Use current active note, or hold the last note if released
            const noteToUse = activeNote ? activeNote.noteNumber : lastNoteRef.current;
            
            if (noteToUse !== null) {
                // Convert MIDI note to 1V/octave
                // C2 (36) = 0V, C3 (48) = 1V, etc.
                const voltage = (noteToUse - 36) / 12;
                return voltage;
            }
            
            return 0; // No note ever pressed
        };
        
        // Register Gate output (velocity)
        const gateProcessorFn = (time, inputFns) => {
            // Gate: -1 for off, 0-1 for velocity
            if (activeNote) {
                return activeNote.velocity;
            }
            
            return -1; // Note off
        };
        
        // Register both outputs with different suffixes
        registerModule(`${module.id}-cv`, cvProcessorFn);
        registerModule(`${module.id}-gate`, gateProcessorFn);
        
        return () => {
            // Cleanup on unmount
        };
    }, [audioContext, activeNote, module.id]);
    
    const handleMouseDown = (note) => {
        setActiveNote({ noteNumber: note.noteNumber, velocity: 0.8 });
    };
    
    const handleMouseUp = () => {
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
            setActiveNote(null);
        };
        
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
    }, []);
    
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
            
            <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                {/* Output port */}
                <div style={{ marginBottom: '15px' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        CV OUT
                    </label>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', position: 'relative' }}>
                        <div
                            data-module-id={module.id}
                            data-port-id="cv-out"
                            data-port-type="output"
                            onClick={() => onOutputClick(module.id, 'cv-out')}
                            style={{
                                width: '16px',
                                height: '16px',
                                background: '#222',
                                border: '2px solid ' + (isConnecting ? '#0f0' : '#00f'),
                                cursor: 'pointer',
                                position: 'absolute',
                                right: '-18px'
                            }}
                            title="CV Out (1V/octave)"
                        />
                    </div>
                </div>
                
                <div style={{ marginBottom: '15px' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        GATE OUT
                    </label>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', position: 'relative' }}>
                        <div
                            data-module-id={module.id}
                            data-port-id="gate-out"
                            data-port-type="output"
                            onClick={() => onOutputClick(module.id, 'gate-out')}
                            style={{
                                width: '16px',
                                height: '16px',
                                background: '#222',
                                border: '2px solid ' + (isConnecting ? '#0f0' : '#00f'),
                                cursor: 'pointer',
                                position: 'absolute',
                                right: '-18px'
                            }}
                            title="Gate Out (velocity)"
                        />
                    </div>
                </div>
                
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
