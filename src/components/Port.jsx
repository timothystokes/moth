export default function Port({ type, onClick, isConnecting, moduleId, portId, title }) {
    const isInput = type === 'input';
    const borderColor = isConnecting ? '#0f0' : (isInput ? '#c55' : '#55c');

    return (
        <div
            onClick={onClick}
            data-module-id={moduleId}
            data-port-id={portId}
            data-port-type={type}
            title={title}
            style={{
                width: '18px',
                height: '18px',
                flexShrink: 0,
                borderRadius: '50%',
                background: 'radial-gradient(circle at 40% 35%, #2a2a2a 30%, #111 65%, #0a0a0a 100%)',
                border: '2px solid ' + borderColor,
                boxShadow: `inset 0 1px 3px rgba(0,0,0,0.8), 0 0 0 1px rgba(0,0,0,0.4)`,
                cursor: onClick ? 'pointer' : 'default',
                boxSizing: 'border-box',
                margin: '0 3px',
            }}
        />
    );
}
