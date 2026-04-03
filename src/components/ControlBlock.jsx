/** Consistent control card: label top-left, value bottom-right, control centred. */
export default function ControlBlock({ label, value, children }) {
    return (
        <div style={{ position: 'relative', padding: '12px 4px 14px 4px' }}>
            <span style={{
                position: 'absolute', top: 0, left: 0,
                fontSize: '10px', color: '#fff', letterSpacing: '0.05em', userSelect: 'none',
            }}>{label}</span>
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                {children}
            </div>
            {value !== undefined && (
                <span style={{
                    position: 'absolute', bottom: 4, right: 0,
                    fontSize: '8px', color: '#ccc', letterSpacing: '0.03em', userSelect: 'none',
                }}>{value}</span>
            )}
        </div>
    );
}
