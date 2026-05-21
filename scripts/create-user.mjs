#!/usr/bin/env node
/**
 * R-013: admin tool to pre-create a UserAccount.
 *
 * Usage:
 *   bin/ps-admin create-user <userName> [--password <pw>]
 *
 * Reads DATABASE_URL from env (.env is auto-loaded by ps-admin via
 * scripts/local-node-runtime.sh). If --password is omitted, a random
 * 24-byte hex password is generated and printed to stdout.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const scrypt = promisify(crypto.scrypt);

function parseArgs(argv) {
  const args = { userName: undefined, password: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--password' || arg === '-p') {
      args.password = argv[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (!args.userName) {
      args.userName = arg;
    }
  }
  return args;
}

function printUsageAndExit(code) {
  console.error(
    `Usage: bin/ps-admin create-user <userName> [--password <pw>]\n` +
      `\n` +
      `Pre-creates a PlanSync user account. With PLANSYNC_OPEN_REGISTRATION=false\n` +
      `(default), this is the only way to register a new user.\n` +
      `\n` +
      `Examples:\n` +
      `  bin/ps-admin create-user alice\n` +
      `  bin/ps-admin create-user bob --password 'hunter2'\n`,
  );
  process.exit(code);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${dk.toString('hex')}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.userName) {
    printUsageAndExit(args.userName ? 0 : 1);
  }

  const name = args.userName.trim();
  if (!name) {
    console.error('Error: userName must not be empty');
    process.exit(1);
  }

  const password =
    args.password && args.password.length > 0
      ? args.password
      : crypto.randomBytes(24).toString('hex');

  const generated = !args.password;

  const __filename = fileURLToPath(import.meta.url);
  const projectDir = path.resolve(path.dirname(__filename), '..');
  const require = createRequire(path.join(projectDir, 'package.json'));

  let PrismaClient;
  try {
    ({ PrismaClient } = require('@prisma/client'));
  } catch (err) {
    console.error(
      'Error: @prisma/client is not installed. Run `./bin/ps-admin start` once before create-user.',
    );
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.userAccount.findUnique({ where: { userName: name } });
    if (existing) {
      console.error(`Error: user "${name}" already exists. Refusing to overwrite.`);
      process.exit(2);
    }
    const passwordHash = await hashPassword(password);
    await prisma.userAccount.create({ data: { userName: name, passwordHash } });

    console.log(`Created user: ${name}`);
    if (generated) {
      console.log(`Generated password (share securely): ${password}`);
    } else {
      console.log('Password: <provided via --password>');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
