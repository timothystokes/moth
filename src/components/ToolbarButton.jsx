import { useState } from 'react';

/**
 * ToolbarButton — standard button used throughout the toolbar and transport.
 *
 * variant="power"   active={bool}  — power button, bright green when on
 * variant="active"  active={bool}  — toggle button, bright green when active (play, etc.)
 * Default: standard grey button with green hover
 */
export default function ToolbarButton({ children, variant, active, style, disabled, ...props }) {
    const [hovered, setHovered] = useState(false);

    const isPower  = variant === 'power';
    const isActive = variant === 'active';
    const lit      = (isPower || isActive) && active;

    const base = {
        padding: '8px 14px',
        background: lit     ? '#00cc00'
                  : hovered ? '#1a3a1a'
                  : '#444',
        border: lit     ? '2px solid #00ff00'
              : hovered ? '1px solid #22aa22'
              : '1px solid #666',
        borderRadius: '4px',
        color: lit ? '#000' : '#fff',
        fontWeight: (isPower || isActive) ? 'bold' : 'normal',
        cursor: disabled ? 'default' : 'pointer',
        fontSize: '12px',
        opacity: disabled ? 0.4 : 1,
        transition: 'background 0.1s, border-color 0.1s',
        fontFamily: 'inherit',
    };

    return (
        <button
            style={{ ...base, ...style }}
            disabled={disabled}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            {...props}
        >
            {children}
        </button>
    );
}
