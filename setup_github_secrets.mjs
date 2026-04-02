// setup_github_secrets.mjs
// Ejecutar con: node setup_github_secrets.mjs

import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Genera un nuevo token en: https://github.com/settings/tokens (scopes: repo, workflow)
const TOKEN = process.env.GITHUB_TOKEN || 'REEMPLAZA_CON_TU_TOKEN';
const OWNER = 'jijascuas';
const REPO = 'topmeme-build';

// Credenciales del keystore
const KEYSTORE_PASSWORD = 'topmeme123';
const KEY_ALIAS = 'topmeme-alias';
const KEY_PASSWORD = 'topmeme123';

async function ghApi(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `token ${TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.github.com${path}`, opts);
  if (res.status === 204) return { ok: true };
  return res.json();
}

async function encryptSecret(publicKeyBase64, secretValue) {
  // Instalar libsodium-wrappers si no está disponible
  let sodium;
  try {
    const require = createRequire(import.meta.url);
    sodium = require('libsodium-wrappers');
  } catch {
    console.log('📦 Instalando libsodium-wrappers...');
    execSync('npm install libsodium-wrappers --no-save', { cwd: __dirname, stdio: 'inherit' });
    const require = createRequire(import.meta.url);
    sodium = require('libsodium-wrappers');
  }
  
  await sodium.ready;
  
  const pubKey = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const secretBytes = sodium.from_string(secretValue);
  const encrypted = sodium.crypto_box_seal(secretBytes, pubKey);
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
}

async function setSecret(keyId, publicKey, name, value) {
  const encrypted = await encryptSecret(publicKey, value);
  const result = await ghApi(
    `/repos/${OWNER}/${REPO}/actions/secrets/${name}`,
    'PUT',
    { encrypted_value: encrypted, key_id: keyId }
  );
  const ok = result.ok || result.status === 201 || result.status === 204;
  console.log(`  ${ok ? '✅' : '❌'} ${name} → status: ${result.status ?? 'ok'}`);
  return ok;
}

async function main() {
  console.log('\n🔐 Configurando GitHub Secrets para', `${OWNER}/${REPO}`);
  console.log('='.repeat(50));

  // 1. Obtener clave pública del repo
  console.log('\n1️⃣  Obteniendo clave pública del repo...');
  const pkData = await ghApi(`/repos/${OWNER}/${REPO}/actions/secrets/public-key`);
  if (!pkData.key_id) {
    console.error('❌ No se pudo obtener la clave pública:', pkData);
    process.exit(1);
  }
  console.log('   Key ID:', pkData.key_id);

  // 2. Leer el keystore y convertir a Base64
  console.log('\n2️⃣  Leyendo keystore...');
  const keystorePath = path.join(__dirname, 'topmeme.keystore');
  const keystoreBytes = readFileSync(keystorePath);
  const keystoreB64 = keystoreBytes.toString('base64');
  console.log(`   Keystore leído: ${keystoreBytes.length} bytes`);

  // 3. Subir los 4 secrets
  console.log('\n3️⃣  Subiendo secrets...');
  await setSecret(pkData.key_id, pkData.key, 'KEYSTORE_BASE64', keystoreB64);
  await setSecret(pkData.key_id, pkData.key, 'KEYSTORE_PASSWORD', KEYSTORE_PASSWORD);
  await setSecret(pkData.key_id, pkData.key, 'KEY_ALIAS', KEY_ALIAS);
  await setSecret(pkData.key_id, pkData.key, 'KEY_PASSWORD', KEY_PASSWORD);

  // 4. Disparar el workflow
  console.log('\n4️⃣  Disparando el build de Android...');
  const dispatch = await ghApi(
    `/repos/${OWNER}/${REPO}/actions/workflows/android-build.yml/dispatches`,
    'POST',
    { ref: 'main' }
  );
  const dispatchOk = dispatch.ok || !dispatch.message;
  console.log(`   ${dispatchOk ? '✅' : '❌'} Workflow disparado: ${dispatchOk ? 'SÍ' : dispatch.message}`);

  console.log('\n' + '='.repeat(50));
  console.log('🎉 ¡Listo! Ve a GitHub Actions para ver el build:');
  console.log(`   https://github.com/${OWNER}/${REPO}/actions`);
  console.log('');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
