import React from 'react';
import Oscillator from './Oscillator.jsx';
import Filter from './Filter.jsx';
import Envelope from './Envelope.jsx';
import Mixer from './Mixer.jsx';
import Multi from './Multi.jsx';
import RandomVoltageGenerator from './RandomVoltageGenerator.jsx';

// Canvas renders all modules and their connections
function Canvas({
    canvasRef,
    modules,
    connections,
    connectingFrom,
    onModuleDragStart,
    onOutputClick,
    onMouseMove,
    onClick,
    audioContext,
    moduleUiRevision,
    onRemove
}) {
    // Helper to determine if a module is fixed (not removable)
    const isFixed = (module) => module.id === 'keyboard-singleton' || module.id === 'track-output-singleton';

    // Render the correct module type
    const renderModule = (module) => {
        const isFixed = module.id === 'keyboard-singleton' || module.id === 'track-output-singleton';
        const commonProps = {
            module,
            onDragStart: onModuleDragStart,
            onOutputClick,
            isConnecting: connectingFrom?.moduleId === module.id,
            audioContext,
            connections,
            onRemove: !isFixed ? () => onRemove(module.id) : undefined
        };
        switch (module.type) {
            case 'oscillator': return <Oscillator key={module.id} {...commonProps} />;
            case 'filter': return <Filter key={module.id} {...commonProps} />;
            case 'envelope': return <Envelope key={module.id} {...commonProps} />;
            case 'mixer': return <Mixer key={module.id} {...commonProps} />;
            case 'multi': return <Multi key={module.id} {...commonProps} />;
            case 'random': return <RandomVoltageGenerator key={module.id} {...commonProps} />;
            default: return null;
        }
    };

    return (
        <div
            ref={canvasRef}
            style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
            onMouseMove={onMouseMove}
            onClick={onClick}
        >
            {modules.map((module) => (
                <div key={module.id} style={{ position: 'absolute', left: module.x, top: module.y }}>
                    {renderModule(module)}
                </div>
            ))}
        </div>
    );
}

export default Canvas;
