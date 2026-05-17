export function DemoExtra(): JSX.Element {
  return (
    <div
      style={{
        marginTop: 16,
        padding: 12,
        border: '1px dashed var(--border-color)',
        borderRadius: 6,
        background: 'var(--card-bg, transparent)',
        fontSize: 13,
      }}
    >
      <strong>UI slot example</strong> — this card is rendered via a contribution into
      the <code>kitchen-sink:demo:extra</code> slot. See <code>plugins/kitchen-sink/README.md</code>
      and <code>docs/plugins/ui.md</code> for the pattern.
    </div>
  );
}
