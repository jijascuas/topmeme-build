const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Initialize Admin SDK to interact with Firestore from the server
admin.initializeApp();

/**
 * Cloud Function to serve dynamic metadata for memes shared to social media.
 * Accessible via https://topmeme-jijascuas.web.app/m/MEME_ID
 */
exports.preRenderMeme = functions.https.onRequest(async (req, res) => {
  // Extract the meme ID from the URL path: /m/ID
  const parts = req.path.split('/');
  const memeId = parts[parts.length - 1];
  
  // Default values for the main site
  let title = "Topmeme - Ranking Global";
  let description = "¡Vota este meme para que llegue al Top! Ayúdanos a elegir los mejores memes del día.";
  let imageUrl = "https://topmeme-jijascuas.web.app/logo.png";
  let author = "Anonymous";

  // If we have a memeId, fetch its direct data from Firestore
  if (memeId && memeId !== 'm') {
    try {
      const memeDoc = await admin.firestore().collection('memes').doc(memeId).get();
      
      if (memeDoc.exists) {
        const meme = memeDoc.data();
        title = `Topmeme - "${meme.title || 'Meme'}"`;
        author = meme.author || 'Anonymous';
        description = `Publicado por ${author} en Topmeme. ¡Entra para votar este meme y verlo en el ranking!`;
        imageUrl = meme.imageUrl || meme.url;
      }
    } catch (e) {
      console.error("Error fetching meme for meta tags:", e);
    }
  }

  // Generate the HTML response. 
  // We include common Open Graph (Facebook/Telegram) and Twitter card tags.
  // The <script> part handles the redirect for real users so they land in the App.
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="utf-8">
    <title>${title}</title>
    
    <!-- Meta tags for Social Media Link Previews -->
    <meta property="og:site_name" content="Topmeme">
    <meta property="og:type" content="article">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${imageUrl}">
    <meta property="og:url" content="https://topmeme-jijascuas.web.app/m/${memeId}">

    <!-- Twitter Card Tags -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${imageUrl}">

    <style>
      body {
        background: #000;
        color: #fff;
        font-family: sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
      }
      .loader {
        text-align: center;
      }
    </style>

    <script>
      // For real users, redirect quickly to the App and open the meme directly
      window.location.href = "/?meme=${memeId}";
    </script>
</head>
<body>
    <div class="loader">
      <h2>Cargando Topmeme...</h2>
      <p>Redirigiendo al ranking...</p>
    </div>
</body>
</html>`;

  res.set('Cache-Control', 'public, max-age=3600, s-maxage=7200');
  res.status(200).send(html);
});
