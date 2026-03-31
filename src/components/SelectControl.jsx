/**
 * SelectControl – a consistently styled label + dropdown row.
 *
 * Props:
 *   label     – text label shown to the left
 *   value     – controlled value
 *   onChange  – change handler
 *   children  – <option> elements
 *   style     – extra style overrides for the outer wrapper
 */
export default function SelectControl({ label, value, onChange, children, style }) {
    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '8px',
            ...style,
        }}>
            <span style={{
                fontSize: '10px',
                color: '#bbb',
                letterSpacing: '0.05em',
                whiteSpace: 'nowrap',
                userSelect: 'none',
                flexShrink: 0,
            }}>
                {label}
            </span>
            <select
                value={value}
                onChange={onChange}
                style={{
                    flex: 1,
                    background: '#2a2a2a',
                    color: '#ccc',
                    border: '1px solid #555',
                    borderRadius: '4px',
                    fontSize: '10px',
                    height: '22px',
                    padding: '0 4px',
                    cursor: 'pointer',
                    outline: 'none',
                    minWidth: 0,
                }}
            >
                {children}
            </select>
        </div>
    );
}
