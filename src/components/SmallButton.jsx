import { useState } from 'react';

/**
 * SmallButton — compact icon/symbol button for track controls (mute, delete, etc.)
 *
 * active={bool}       — shows activeBackground/activeBorder/activeColor when true
 * activeBackground    — background when active (default: dark red)
 * activeBorder        — border colour when active
 * activeColor         — text colour when active
 * hoverColor          — border/text tint on hover (default: lighter grey)
 */
export default function SmallButton({
    children,
    onClick,
    title,
    active = false,
    activeBackground = '#732b2b',
    activeBorder = '#b74d4d',
    activeColor = '#f2f2f2',
    hoverBorder = '#888',
    hoverColor = '#ccc',
    ...props
}) {
    const [hovered, setHovered] = useState(false);

    const style = {
        width: '22px',
        height: '22px',
        padding: 0,
        background: active ? activeBackground : '#2a2a2a',
        border: `1px solid ${active ? activeBorder : hovered ? hoverBorder : '#444'}`,
        borderRadius: '3px',
        color: active ? activeColor : hovered ? hoverColor : '#888',
        fontSize: '13px',
        lineHeight: '1',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background 0.1s, border-color 0.1s, color 0.1s',
        fontFamily: 'inherit',
        flexShrink: 0,
    };

    return (
        <button
            style={style}
            onClick={onClick}
            title={title}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            {...props}
        >
            {children}
        </button>
    );
}
