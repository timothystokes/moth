/** Vertical separator bar for use inside flex nav/toolbar rows. */
export default function NavDivider() {
    return (
        <div style={{
            width: '1px',
            alignSelf: 'stretch',
            background: '#505050',
            margin: '8px 18px',
            flexShrink: 0,
        }} />
    );
}
