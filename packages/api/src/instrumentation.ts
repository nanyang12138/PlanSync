export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startHeartbeatScanner } = await import('./lib/heartbeat-scanner');
    startHeartbeatScanner();
  }
}
