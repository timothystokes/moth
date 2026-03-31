import Port from './Port.jsx';

import { COLOR_SLIDER } from '../theme.js';

/**
 * InputSlider – a labelled slider row with an input CV socket.
 *
 * Props:
 *   moduleId, portId        – wired to the Port
 *   label                   – text above the row (can be a node for dynamic values)
 *   onOutputClick           – connection handler from parent
 *   isConnecting            – highlights port when actively connecting
 *   min, max, step, value   – range input props
 *   onChange                – range input change handler
 *   labelLeft, labelMid,
 *   labelRight              – optional tick labels below the slider
 *   sliderStyle             – extra style for the range input wrapper div
 */
export default function InputSlider({
    moduleId, portId, label,
    onOutputClick, isConnecting,
    min, max, step, value, onChange,
    labelLeft, labelMid, labelRight,
    sliderStyle,
}) {
    const hasTickLabels = labelLeft != null || labelMid != null || labelRight != null;

    return (
        <div style={{ marginBottom: '10px' }}>
            <label style={{ fontSize: '10px', color: '#bbb', display: 'block', marginBottom: '4px', marginLeft: '3px', userSelect: 'none' }}>
                {label}
            </label>
            <div style={{ display: 'flex', alignItems: 'center' }}>
                <Port
                    type="input"
                    moduleId={moduleId}
                    portId={portId}
                    isConnecting={isConnecting}
                    onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        onOutputClick(moduleId, portId, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
                    }}
                />
                <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={onChange}
                    style={{ flex: 1, marginLeft: '6px', marginRight: '3px', cursor: 'pointer', accentColor: COLOR_SLIDER, ...sliderStyle }}
                />
            </div>
            {hasTickLabels && (
                <div style={{ position: 'relative', marginTop: '2px', paddingLeft: '30px', height: '12px' }}>
                    {labelLeft  != null && <span style={{ fontSize: '8px', color: '#aaa', position: 'absolute', left: '30px' }}>{labelLeft}</span>}
                    {labelMid   != null && <span style={{ fontSize: '8px', color: '#aaa', position: 'absolute', left: 'calc(50% + 15px)', transform: 'translateX(-50%)' }}>{labelMid}</span>}
                    {labelRight != null && <span style={{ fontSize: '8px', color: '#aaa', position: 'absolute', right: '3px' }}>{labelRight}</span>}
                </div>
            )}
        </div>
    );
}
