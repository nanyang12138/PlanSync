export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const fs = await import('fs');
    const path = await import('path');
    const cwd = process.cwd();
    const sourceSchema = path.join(cwd, 'prisma/schema.prisma');
    const generatedSchema = path.join(cwd, 'node_modules/.prisma/client/schema.prisma');
    try {
      const srcMtime = fs.statSync(sourceSchema).mtimeMs;
      const genMtime = fs.statSync(generatedSchema).mtimeMs;
      if (srcMtime > genMtime) {
        console.error(
          '\n⚠ prisma/schema.prisma has changed since last `prisma generate`.\n' +
            '  Run: npx prisma generate   (or restart via ./scripts/dev.sh)\n',
        );
        process.exit(1);
      }
    } catch {
      // If either file is missing, skip the check
    }

    const { startHeartbeatScanner } = await import('./lib/heartbeat-scanner');
    startHeartbeatScanner();
  }
}
