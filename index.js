// ============================================================
//  DisPLU - Proxy PLU
//  Reçoit lon/lat d'une parcelle -> renvoie zone + texte du règlement PLU
// ============================================================

const express = require('express');
const pdfParse = require('pdf-parse');

const app = express();
app.use(express.json());

// --- CORS : autorise le frontend à appeler ce proxy ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const GPU_BASE = 'https://www.geoportail-urbanisme.gouv.fr';
const DOC_BASE = 'https://data.geopf.fr/annexes/gpu/documents';

// ------------------------------------------------------------
//  Étape 1 : feature-info/du -> extrait document + zone
// ------------------------------------------------------------
async function getPluInfo(lon, lat) {
  const url = `${GPU_BASE}/api/feature-info/du?lon=${lon}&lat=${lat}&zoom=13`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`feature-info HTTP ${r.status}`);
  const data = await r.json();

  const features = data.features || [];

  // Commune (pour le nom + détection RNU)
  const muni = features.find(f => f.id && f.id.startsWith('municipality'));
  const commune = muni?.properties?.name || null;
  const insee = muni?.properties?.insee || null;
  const isRnu = muni?.properties?.is_rnu === true;

  // Document d'urbanisme (contient le hash gpu_doc_id)
  const doc = features.find(f => f.id && f.id.startsWith('document.'));

  // Zone d'urbanisme de la parcelle cliquée (contient nomfic du règlement)
  const zone = features.find(f => f.id && f.id.startsWith('zone_urba.'));

  return { commune, insee, isRnu, doc, zone, rawCount: features.length };
}

// ------------------------------------------------------------
//  Étape 2 : construit l'URL du règlement écrit
// ------------------------------------------------------------
function buildReglementUrl(doc, zone) {
  const partition = doc.properties.partition;   // ex: DU_242600252
  const hash = doc.properties.id;               // ex: 883dd0a1...
  // nomfic du règlement écrit vient du feature zone_urba (jamais des prescriptions)
  const nomfic = zone?.properties?.nomfic;
  if (!partition || !hash || !nomfic) return null;
  return `${DOC_BASE}/${partition}/${hash}/${nomfic}`;
}

// ------------------------------------------------------------
//  Étape 3 : télécharge le PDF et extrait le texte
// ------------------------------------------------------------
async function extractPdfText(pdfUrl) {
  const r = await fetch(pdfUrl);
  if (!r.ok) throw new Error(`PDF HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const parsed = await pdfParse(buf);
  return { text: parsed.text || '', pages: parsed.numpages || 0, sizeKo: Math.round(buf.length / 1024) };
}

// ============================================================
//  ROUTE PRINCIPALE : /plu?lon=&lat=
// ============================================================
app.get('/plu', async (req, res) => {
  const { lon, lat } = req.query;
  if (!lon || !lat) return res.status(400).json({ error: 'lon et lat requis' });

  try {
    const info = await getPluInfo(lon, lat);

    // Cas RNU : pas de PLU
    if (info.isRnu) {
      return res.json({
        found: false,
        rnu: true,
        commune: info.commune,
        message: `${info.commune} n'a pas de PLU : la commune relève du Règlement National d'Urbanisme (RNU).`
      });
    }

    // Pas de document d'urbanisme trouvé
    if (!info.doc) {
      return res.json({
        found: false,
        commune: info.commune,
        message: `Aucun document d'urbanisme trouvé pour cette parcelle sur Géoportail Urbanisme.`
      });
    }

    // Pas de zone (donc pas de nomfic pour identifier le règlement)
    if (!info.zone) {
      return res.json({
        found: false,
        commune: info.commune,
        duType: info.doc.properties.du_type,
        message: `Document trouvé (${info.doc.properties.grid_title}) mais aucune zone d'urbanisme précise sur cette parcelle.`
      });
    }

    const pdfUrl = buildReglementUrl(info.doc, info.zone);
    if (!pdfUrl) {
      return res.json({ found: false, commune: info.commune, message: `Impossible de construire l'URL du règlement.` });
    }

    // Extraction du texte
    const { text, pages, sizeKo } = await extractPdfText(pdfUrl);

    return res.json({
      found: true,
      commune: info.commune,
      insee: info.insee,
      duType: info.doc.properties.du_type,          // PLU / PLUi
      documentTitle: info.doc.properties.grid_title, // ex: PLUI DU VAL DE DROME
      zone: info.zone.properties.libelle,            // ex: Ap
      zoneLibelle: info.zone.properties.libelong,    // ex: Ap : Zone agricole à préserver
      pdfUrl,
      pages,
      sizeKo,
      textLength: text.length,
      text
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------
//  ROUTE DEBUG : /debug?lon=&lat=  (sans télécharger le PDF)
// ------------------------------------------------------------
app.get('/debug', async (req, res) => {
  const { lon, lat } = req.query;
  if (!lon || !lat) return res.status(400).json({ error: 'lon et lat requis' });
  try {
    const info = await getPluInfo(lon, lat);
    const pdfUrl = info.doc && info.zone ? buildReglementUrl(info.doc, info.zone) : null;
    res.json({
      commune: info.commune,
      isRnu: info.isRnu,
      duType: info.doc?.properties?.du_type || null,
      zone: info.zone?.properties?.libelle || null,
      zoneLibelle: info.zone?.properties?.libelong || null,
      nomfic: info.zone?.properties?.nomfic || null,
      partition: info.doc?.properties?.partition || null,
      hash: info.doc?.properties?.id || null,
      pdfUrl,
      featuresCount: info.rawCount
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('DisPLU proxy OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DisPLU proxy on ${PORT}`));

app.get('/', (req, res) => res.send('DisPLU proxy OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DisPLU proxy on ${PORT}`));
