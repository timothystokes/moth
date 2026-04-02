import { useState } from 'react';

/**
 * AppSelect — styled <select> matching ToolbarButton aesthetics.
 *
 * Optional `label` prop renders a small label to the left of the select.
 * Without `label`, renders the select alone (drop-in for raw <select>).
 * `wrapperStyle` applies to the outer row when a label is present.
 */
export default function AppSelect({ children, label, style, wrapperStyle, disabled, ...props }) {
    const [hovered, setHovered] = useState(false);

    const select = (
        <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'stretch', flexShrink: 0, ...(label ? { flex: 1, minWidth: 0 } : {}) }}>
            <select
                disabled={disabled}
                style={{
                    appearance: 'none',
                    WebkitAppearance: 'none',
                    background: hovered && !disabled ? '#1a3a1a' : '#444',
                    color: disabled ? '#888' : '#fff',
                    border: hovered && !disabled ? '1px solid #22aa22' : '1px solid #ccc',
                    borderRadius: '4px',
                    fontSize: '16px',
                    fontFamily: 'inherit',
                    padding: '7px 28px 7px 10px',
                    cursor: disabled ? 'default' : 'pointer',
                    outline: 'none',
                    boxSizing: 'border-box',
                    width: '100%',
                    transition: 'background 0.1s, border-color 0.1s',
                    opacity: disabled ? 0.4 : 1,
                    ...style,
                }}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                {...props}
            >
                {children}
            </select>
            <span style={{
                position: 'absolute',
                right: '8px',
                top: '50%',
                transform: 'translateY(-50%)',
                pointerEvents: 'none',
                color: '#aaa',
                fontSize: '10px',
                lineHeight: 1,
            }}>▾</span>
        </div>
    );

    if (!label) return select;

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', ...wrapperStyle }}>
            <span style={{
                fontSize: '14px',
                color: '#fff',
                letterSpacing: '0.05em',
                whiteSpace: 'nowrap',
                userSelect: 'none',
                flexShrink: 0,
            }}>
                {label}
            </span>
            {select}
        </div>
    );
}
