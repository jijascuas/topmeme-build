
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');

// INSTRUCTIONS: 
// 1. Download your service account JSON file from the Firebase console 
//    (Project Settings > Service Accounts > Generate new private key).
// 2. Name it 'serviceAccountKey.json' and place it in this folder.
// 3. Run: node subir_codigos.js

const serviceAccount = require('./serviceAccountKey.json');

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();
const codes = fs.readFileSync('codigos_regalo.txt', 'utf-8').split('\n').filter(c => c.trim());

async function upload() {
  console.log('Starting upload of ' + codes.length + ' codes...');
  const batchSize = 400; // Firestore allows 500 operations per batch
  
  for (let i = 0; i < codes.length; i += batchSize) {
    const batch = db.batch();
    const chunk = codes.slice(i, i + batchSize);
    
    chunk.forEach(code => {
      const ref = db.collection('giftCodes').doc(code);
      batch.set(ref, { 
        code: code,
        used: false, 
        createdAt: new Date() 
      });
    });
    
    await batch.commit();
    console.log('Batch sent: ' + (i + chunk.length) + '/' + codes.length);
  }
  console.log('✅ All codes uploaded successfully.');
}

upload().catch(console.error);
