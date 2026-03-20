import React, { useState, useEffect, useRef } from 'react';
import { registerModule, unregisterModule } from '../audio/audioEngine.js';

function RandomVoltageGenerator({ module, onDragStart, onDrag, onDragEnd, onOutputClick, isConnecting, audioContext, connections }) {
    const [rate, setRate] = useState(5); // Hz - random value changes per second
    const lastOutputTime = useRef(0);
    const currentValue = useRef(0);
    
    // Register this module's processing function
    useEffect(() => {
        const randomVoltageProcessor = (time, voiceContext, inputFns) => {
            // Get rate modulation input if connected
            const rateModFn = inputFns?.['rate-input'];
            
            // Calculate final rate with modulation.
            // Uses the same logarithmic slider shape as oscillator frequency, with
            // socket CV applied as a relative exponential nudge (scaled so ±10V = ±1 octave).
            let finalRate = rate;
            const rateNudgeOctaves = rateModFn ? rateModFn(time, voiceContext) / 10 : 0;
            finalRate = rate * Math.pow(2, rateNudgeOctaves);
            finalRate = Math.max(0.1, Math.min(2000, finalRate));
            
            // Calculate time interval for this rate
            const intervalMs = 1000 / finalRate;
            
            // Check if we need to generate a new random value
            if (time - lastOutputTime.current >= intervalMs) {
                // Generate new random value between -10V and +10V
                currentValue.current = (Math.random() * 20) - 10;
                lastOutputTime.current = time;
            }
            
            // Return current value (±10V range)
            return currentValue.current;
        };
        
        registerModule(module.id, randomVoltageProcessor);
        
        return () => {
            unregisterModule(module.id);
        };
    }, [module.id, rate]);
    
    return (
        <div
            style={{
                position: 'absolute',
                left: module.x,
                top: module.y,
                width: '180px',
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
            }}>
                <span>RANDOM</span>
            </div>
            
            <div style={{ padding: '10px' }}>
                {/* Rate Control with Port */}
                <div style={{ marginBottom: '15px', position: 'relative' }}>
                    <label style={{ fontSize: '10px', color: '#aaa', display: 'block', marginBottom: '5px' }}>
                        {connections?.some(c => c.to.moduleId === module.id && c.to.outputId === 'rate-input') 
                            ? 'RATE' 
                            : `RATE: ${rate < 10 ? rate.toFixed(2) : rate < 100 ? rate.toFixed(1) : rate.toFixed(0)}Hz`}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                        <Port 
                            type="input" 
                            moduleId={module.id}
                            portId="rate-input"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'rate-input', { 
                                    x: rect.left + rect.width / 2, 
                                    y: rect.top + rect.height / 2 
                                });
                            }}
                            isConnecting={isConnecting}
                        />
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.001"
                            value={Math.log(rate / 0.1) / Math.log(2000 / 0.1)}
                            onChange={(e) => setRate(0.1 * Math.pow(2000 / 0.1, parseFloat(e.target.value)))}
                            style={{
                                width: '100%',
                                cursor: 'pointer',
                                marginLeft: '20px'
                            }}
                        />
                    </div>
                </div>
                
                {/* Output Port */}
                <div style={{ position: 'relative', marginTop: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', position: 'relative' }}>
                        <span style={{ fontSize: '9px', color: '#aaa', marginRight: '16px' }}>OUT</span>
                        <Port 
                            type="output" 
                            moduleId={module.id}
                            portId="output"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onOutputClick(module.id, 'output', { 
                                    x: rect.left + rect.width / 2, 
                                    y: rect.top + rect.height / 2 
                                });
                            }}
                            isConnecting={isConnecting}
                        />
                    </div>
                </div>
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

export default RandomVoltageGenerator;
