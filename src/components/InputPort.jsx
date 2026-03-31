import Port from './Port.jsx';

/**
 * InputPort – port circle on the left, label to the right.
 * Use for input sockets that have no slider (plain signal/CV inputs).
 */
export default function InputPort({ moduleId, portId, label, onOutputClick, isConnecting, title, style }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px', ...style }}>
            <Port
                type="input"
                moduleId={moduleId}
                portId={portId}
                isConnecting={isConnecting}
                title={title}
                onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    onOutputClick(moduleId, portId, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
                }}
            />
            {label && (
                <span style={{ fontSize: '10px', color: '#aaa', marginLeft: '6px', userSelect: 'none' }}>
                    {label}
                </span>
            )}
        </div>
    );
}
