const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const REPOSITORY = 'akwaa2545-gif/PCN-';
const FIELDS = ['schemaVersion', 'repository', 'runNumber', 'runAttempt', 'commit', 'releaseId', 'archive', 'sha256'];

function validateManifest(value) {
  const counter = number => Number.isSafeInteger(number) && number > 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== FIELDS.length || FIELDS.some(field => !Object.hasOwn(value, field))
      || value.schemaVersion !== 1 || value.repository !== REPOSITORY
      || !counter(value.runNumber) || !counter(value.runAttempt)
      || value.releaseId !== `pcn-test-${value.runNumber}-${value.runAttempt}`
      || typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit)
      || value.archive !== 'pcn.zip' || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('Invalid release manifest');
  }
  return { ...value };
}

function verifyManifest({ manifestBytes, signature, publicKey }) {
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length > 16384) throw new Error('Invalid release manifest size');
  const encoded = String(signature).trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) throw new Error('Invalid release signature');
  const key = publicKey?.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Release signature requires an Ed25519 key');
  if (!crypto.verify(null, manifestBytes, key, Buffer.from(encoded, 'base64'))) throw new Error('Invalid release signature');
  // Parse only bytes authenticated by the server-pinned public key.
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error('Invalid release manifest'); }
  return validateManifest(manifest);
}

function verifyRelease(options) {
  const manifest = verifyManifest(options);
  if (!Buffer.isBuffer(options.archive)) throw new Error('Invalid release archive');
  const actual = crypto.createHash('sha256').update(options.archive).digest('hex');
  if (actual !== manifest.sha256) throw new Error('Invalid release archive digest');
  return manifest;
}

function parseArguments(args) {
  const allowed = new Set(['manifest', 'signature', 'archive', 'public-key']);
  const values = {};
  for (let i = 0; i < args.length;) {
    if (args[i] === '--manifest-only') {
      if (values.manifestOnly) throw new Error('Duplicate verifier arguments');
      values.manifestOnly = true;
      i++;
      continue;
    }
    const name = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !allowed.has(name) || !args[i + 1] || Object.hasOwn(values, name)) throw new Error('Invalid verifier arguments');
    values[name] = args[i + 1];
    i += 2;
  }
  if (['manifest', 'signature', 'public-key'].some(name => !values[name])
      || (values.manifestOnly ? values.archive : !values.archive)) throw new Error('Missing or incompatible verifier arguments');
  return values;
}

async function main(args = process.argv.slice(2)) {
  const paths = parseArguments(args);
  const [manifestBytes, signature, publicKey] = await Promise.all([
    fs.readFile(paths.manifest), fs.readFile(paths.signature, 'utf8'), fs.readFile(paths['public-key'], 'utf8'),
  ]);
  const manifest = verifyManifest({ manifestBytes, signature, publicKey });
  if (paths.manifestOnly) {
    process.stdout.write(JSON.stringify(manifest) + '\n');
    return;
  }
  // Read and hash the archive only after authenticating and validating its manifest.
  const archive = await fs.readFile(paths.archive);
  const result = verifyRelease({ manifestBytes, signature, publicKey, archive });
  if (result.releaseId !== manifest.releaseId) throw new Error('Release manifest changed');
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (require.main === module) main().catch(() => { console.error('Release verification failed'); process.exitCode = 1; });
module.exports = { validateManifest, verifyManifest, verifyRelease, parseArguments };
