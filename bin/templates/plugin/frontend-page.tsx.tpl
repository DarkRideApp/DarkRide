import React from 'react';

export default function Main() {
  return (
    <div style={{ padding: 24 }}>
      <h1>{{label}}</h1>
      <p>Your plugin is working. Edit this page at <code>plugins/{{slug}}/frontend/pages/Main.tsx</code>.</p>
    </div>
  );
}
