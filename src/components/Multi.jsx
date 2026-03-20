import React, { useEffect } from 'react';
import { registerModule, unregisterModule } from '../audio/audioEngine.js';

function Multi({ module, onDragStart, onOutputClick, isConnecting }) {
    useEffect(() => {
        const passthroughProcessor = (time, voiceContext, inputFns) => {
            const signalInFn = inputFns?.['signal-input'];
            return signalInFn ? signalInFn(time, voiceContext) : 0;
        };

        registerModule(module.id, passthroughProcessor);

        return () => {
            unregisterModule(module.id);
        };
    }, [module.id]);

    return (
        <div
            style={{
                position: 'absolute',
                left: module.x,
                top: module.y,
                width: '150px',
                minHeight: '120px',
                background: '#333',
                border: '2px solid #555',
                borderRadius: '4px',
                padding: 0,
                zIndex: 10,
                transition: 'none',
                boxShadow: '0 4px 8px rgba(0,0,0,0.3)'
            }}
        >
            <div
                onMouseDown={(e) => {
                    onDragStart(e, module.id);
                }}
                style={{
                    fontSize: '12px',
                    fontWeight: 'bold',
                    padding: '10px',
                    marginBottom: '10px',
                    color: '#888',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    cursor: 'move',
                    background: '#2a2a2a',
                    borderBottom: '1px solid #555',
                    borderRadius: '2px 2px 0 0'
                }}
            >
                <span>MULTI</span>
            </div>

            <div style={{ padding: '10px' }}>
                <div style={{ position: 'relative', marginBottom: '18px' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        IN
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative', minHeight: '16px' }}>
                        <Port
                            type="input"
                            moduleId={module.id}
                            portId="signal-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'signal-input', {
                                    x: rect.left + rect.width / 2,
                                    y: rect.top + rect.height / 2
                                });
                            }}
                            isConnecting={isConnecting}
                        />
                    </div>
                </div>

                <OutputRow
                    label="OUT A"
                    moduleId={module.id}
                    portId="output-a"
                    onOutputClick={onOutputClick}
                    isConnecting={isConnecting}
                />

                <OutputRow
                    label="OUT B"
                    moduleId={module.id}
                    portId="output-b"
                    onOutputClick={onOutputClick}
                    isConnecting={isConnecting}
                />
            </div>
        </div>
    );
}

function OutputRow({ label, moduleId, portId, onOutputClick, isConnecting }) {
    return (
        <div style={{ position: 'relative', marginTop: '10px' }}>
            <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px', textAlign: 'right' }}>
                {label}
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', position: 'relative' }}>
                <Port
                    type="output"
                    moduleId={moduleId}
                    portId={portId}
                    onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        onOutputClick(moduleId, portId, {
                            x: rect.left + rect.width / 2,
                            y: rect.top + rect.height / 2
                        });
                    }}
                    isConnecting={isConnecting}
                />
            </div>
        </div>
    );
}

function Port({ type, onClick, isConnecting, moduleId, portId }) {
    const isInput = type === 'input';

    return (
        <div
            onClick={onClick}
            data-module-id={moduleId}
            data-port-id={portId}
            data-port-type={type}
            style={{
                width: '16px',
                height: '16px',
                background: '#222',
                border: '2px solid ' + (isConnecting ? '#0f0' : (isInput ? '#f00' : '#00f')),
                cursor: onClick ? 'pointer' : 'default',
                position: 'absolute',
                left: isInput ? '-18px' : 'auto',
                right: !isInput ? '-18px' : 'auto'
            }}
        />
    );
}

export default Multi;