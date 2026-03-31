import Port from './Port.jsx';

/**
 * OutputPort – label on the left, port circle on the right.
 * Right-justified. Accepts optional children to the left of the label
 * (e.g. switches or extra controls).
 */
export default function OutputPort({ moduleId, portId, label, onOutputClick, isConnecting, title, style, children }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: '10px', ...style }}>
            {children}
            {label && (
                <span style={{ fontSize: '10px', color: '#aaa', marginRight: '6px', userSelect: 'none' }}>
                    {label}
                </span>
            )}
            <Port
                type="output"
                moduleId={moduleId}
                portId={portId}
                isConnecting={isConnecting}
                title={title}
                onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    onOutputClick(moduleId, portId, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
                }}
            />
        </div>
    );
}
