/**
 * ModuleShell – consistent outer wrapper for all modules.
 *
 * Props:
 *   title        – module name displayed in header
 *   module       – module object (needs module.id for drag)
 *   onDragStart  – drag handler; if omitted header is not draggable
 *   onRemove     – if provided, shows a × close button in the header
 *   width        – outer width (default '180px')
 *   minHeight    – optional minHeight
 *   isFixed      – true for Keyboard/Amplifier panel mode (fills container, no border/shadow)
 *   style        – extra style overrides for the outer wrapper
 *   children     – module body content (rendered inside padded content area)
 */
export default function ModuleShell({ title, module, onDragStart, onRemove, width, minHeight, isFixed, style, children }) {
    const outerStyle = isFixed ? {
        position: 'relative',
        width: '100%',
        height: '100%',
        background: '#3a3a3a',
        border: 'none',
        borderRadius: 0,
        padding: 0,
        zIndex: 10,
        boxShadow: 'none',
        display: 'flex',
        flexDirection: 'column',
        ...style,
    } : {
        position: 'relative',
        width: width ?? '180px',
        minHeight: minHeight,
        background: '#3a3a3a',
        border: '2px solid #666',
        borderRadius: '18px',
        padding: 0,
        zIndex: 200,
        transition: 'none',
        boxShadow: '0 4px 8px rgba(0,0,0,0.3)',
        ...style,
    };

    const headerStyle = {
        fontSize: '12px',
        fontWeight: 'bold',
        padding: '8px 10px',
        color: '#ccc',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        cursor: onDragStart ? 'move' : 'default',
        background: '#2e2e2e',
        borderBottom: '1px solid #666',
        borderRadius: isFixed ? 0 : '18px 18px 0 0',
        userSelect: 'none',
        position: 'relative',
        flexShrink: 0,
    };

    return (
        <div style={outerStyle}>
            <div
                style={headerStyle}
                onMouseDown={onDragStart ? (e) => onDragStart(e, module.id) : undefined}
            >
                <span style={{ marginLeft: '3px' }}>{title}</span>
                {onRemove && (
                    <button
                        style={{
                            background: '#555',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '50%',
                            width: 18,
                            height: 18,
                            fontWeight: 'bold',
                            fontSize: 12,
                            cursor: 'pointer',
                            boxShadow: '0 1px 4px #000a',
                            lineHeight: '18px',
                            padding: 0,
                            flexShrink: 0,
                            marginRight: '3px',
                        }}
                        title="Remove module"
                        onClick={(e) => { e.stopPropagation(); onRemove(); }}
                    >×</button>
                )}
            </div>
            <div className="module-body" style={{ padding: '10px 10px 12px', flex: isFixed ? 1 : undefined, overflow: isFixed ? 'hidden' : undefined }}>
                {children}
            </div>
        </div>
    );
}
