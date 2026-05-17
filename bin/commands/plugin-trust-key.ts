export function runPluginTrustKey(args: string[]): void {
  // darkride plugin trust-key <id> <base64-public-key> <label>
  const [id, publicKey, ...labelParts] = args;
  const label = labelParts.join(' ');

  if (!id || !publicKey || !label) {
    console.error('Usage: darkride plugin trust-key <id> <base64-public-key> <label>');
    console.error('Example: darkride plugin trust-key acme-corp MCowBQ... "Acme Corp Internal"');
    process.exit(1);
  }

  const port = process.env.PORT || 3000;
  fetch(`http://localhost:${port}/v1/plugins/signing-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, publicKey, label }),
  })
    .then(res => res.json() as Promise<{ success: boolean; error?: string }>)
    .then(data => {
      if (data.success) {
        console.log(`Trusted key "${id}" added: ${label}`);
      } else {
        console.error(`Error: ${data.error}`);
        process.exit(1);
      }
    })
    .catch(err => {
      console.error(`Failed to connect to DarkRide server: ${err.message}`);
      console.error('Make sure the server is running.');
      process.exit(1);
    });
}

export function runPluginRevokeKey(args: string[]): void {
  const [id] = args;
  if (!id) {
    console.error('Usage: darkride plugin revoke-key <id>');
    process.exit(1);
  }

  const port = process.env.PORT || 3000;
  fetch(`http://localhost:${port}/v1/plugins/signing-keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
    .then(res => res.json() as Promise<{ success: boolean; error?: string }>)
    .then(data => {
      if (data.success) {
        console.log(`Trusted key "${id}" revoked.`);
      } else {
        console.error(`Error: ${data.error}`);
        process.exit(1);
      }
    })
    .catch(err => {
      console.error(`Failed to connect to DarkRide server: ${err.message}`);
      process.exit(1);
    });
}
