// Cockpit Allemagne : API Google Sheets.
//
// Installation, une seule fois :
//   1. Ouvrir la feuille Google > Extensions > Apps Script
//   2. Coller ce fichier, remplacer TOKEN par la valeur de config.js
//   3. Deployer > Nouveau deploiement > Application web
//        Executer en tant que : Moi
//        Qui a acces : Tout le monde
//   4. Copier l URL /exec dans cockpit/config.js (sheetApi)
//
// Les onglets "statuts" et "taches" sont crees au premier appel.

var TOKEN = 'cockpit-aj-2026';

var ONGLETS = {
  statuts: ['id', 'qui', 'statut', 'note', 'par', 'maj', 'ts',
            'entreprise', 'poste', 'url', 'ville', 'hub', 'contratType', 'source'],
  taches:  ['id', 'cat', 'texte', 'date', 'statut', 'notes', 'par', 'maj', 'ts', 'supprimee'],
};

function feuille_(nom) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var f = ss.getSheetByName(nom);
  if (!f) {
    f = ss.insertSheet(nom);
    f.appendRow(ONGLETS[nom]);
    f.setFrozenRows(1);
    f.getRange(1, 1, 1, ONGLETS[nom].length).setFontWeight('bold');
  }
  return f;
}

function lireTout_(nom) {
  var f = feuille_(nom);
  var v = f.getDataRange().getValues();
  var cols = ONGLETS[nom];
  var out = [];
  for (var i = 1; i < v.length; i++) {
    var o = {};
    for (var j = 0; j < cols.length; j++) {
      var x = v[i][j];
      if (x instanceof Date) x = Utilities.formatDate(x, 'Europe/Paris', 'yyyy-MM-dd');
      o[cols[j]] = (x === undefined || x === null) ? '' : String(x);
    }
    if (o.id) out.push(o);
  }
  return out;
}

function indexIds_(f) {
  var n = Math.max(f.getLastRow(), 1);
  var ids = f.getRange(1, 1, n, 1).getValues();
  var idx = {};
  for (var i = 1; i < ids.length; i++) idx[String(ids[i][0])] = i + 1;
  return idx;
}

function upsertLot_(nom, objets) {
  var f = feuille_(nom);
  var cols = ONGLETS[nom];
  var idx = indexIds_(f);
  var nouvelles = [];
  objets.forEach(function (obj) {
    var row = cols.map(function (c) {
      var x = obj[c];
      return (x === undefined || x === null) ? '' : String(x);
    });
    var ligne = idx[String(obj.id)];
    if (ligne) {
      f.getRange(ligne, 1, 1, cols.length).setValues([row]);
    } else {
      nouvelles.push(row);
      idx[String(obj.id)] = f.getLastRow() + nouvelles.length;
    }
  });
  if (nouvelles.length) {
    f.getRange(f.getLastRow() + 1, 1, nouvelles.length, cols.length).setValues(nouvelles);
  }
}

function reponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return reponse_({
    ok: true,
    statuts: lireTout_('statuts'),
    taches: lireTout_('taches'),
    t: new Date().toISOString(),
  });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var corps = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (corps.token !== TOKEN) return reponse_({ ok: false, erreur: 'token' });
    var statuts = [], taches = [];
    (corps.items || []).forEach(function (it) {
      if (it.type === 'statut' && it.data && it.data.id) statuts.push(it.data);
      else if (it.type === 'tache' && it.data && it.data.id) taches.push(it.data);
    });
    if (statuts.length) upsertLot_('statuts', statuts);
    if (taches.length) upsertLot_('taches', taches);
    return reponse_({ ok: true, statuts: statuts.length, taches: taches.length,
                      t: new Date().toISOString() });
  } catch (err) {
    return reponse_({ ok: false, erreur: String(err) });
  } finally {
    lock.releaseLock();
  }
}
