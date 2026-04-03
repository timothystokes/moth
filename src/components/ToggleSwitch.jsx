import { COLOR_TOGGLE_ON } from '../theme.js';

/**
 * ToggleSwitch – "LABEL: Value" on the left, pill toggle on the right.
 *
 * Props:
 *   label    – control name (e.g. "TYPE")
 *   value    – boolean controlled state
 *   onChange – fn(newValue: boolean)
 *   labelOn  – value text when true  (default 'ON')
 *   labelOff – value text when false (default 'OFF')
 *   style    – extra style overrides for the outer wrapper
 */
export default function ToggleSwitch({ label, value, onChange, labelOn = 'ON', labelOff = 'OFF', style }) {
    return (
        <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '14px',
            ...style,
        }}>
            <span style={{ fontSize: '10px', color: '#bbb', marginLeft: '3px', userSelect: 'none' }}>
                {label}: {value ? labelOn : labelOff}
            </span>
            <div
                onClick={() => onChange(!value)}
                style={{
                    width: '34px', height: '18px', borderRadius: '9px',
                    background: value ? COLOR_TOGGLE_ON : '#444',
                    position: 'relative', cursor: 'pointer',
                    transition: 'background 0.15s',
                    marginRight: '3px', flexShrink: 0,
                }}
            >
                <div style={{
                    position: 'absolute', top: '2px',
                    left: value ? '16px' : '2px',
                    width: '14px', height: '14px', borderRadius: '50%',
                    background: '#fff',
                    transition: 'left 0.15s',
                }} />
            </div>
        </div>
    );
}
