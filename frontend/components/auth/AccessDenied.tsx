export function AccessDenied({ scope }: { scope?: string }) {
  return (
    <div className="access-denied">
      <h2>Access denied</h2>
      <p>You don't have permission to view this page.</p>
      {scope && <p className="scope-hint">Required scope: <code>{scope}</code></p>}
    </div>
  );
}
