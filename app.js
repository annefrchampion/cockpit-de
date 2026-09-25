// ===========================================================================
// COCKPIT ALLEMAGNE
//
// Deux sources, fusionnees dans le navigateur :
//   data/offres.json        ce que le scanner a trouve. Pousse par publier_cockpit.cmd.
//   feuille Google          ce qu Anne et Joffrey ont decide. Lue et ecrite via
//                           l API Apps Script (config.js). Partagee, en direct.
//
// Sans API configuree, les decisions restent dans ce navigateur (mode local).
// Toute saisie est d abord ecrite en local, puis envoyee : rien ne se perd si
// le reseau tombe, et l envoi reprend tout seul.
// ===========================================================================
(function () {
'use strict';

var CFG = window.COCKPIT_CONFIG || {};
var API = String(CFG.sheetApi || '').trim();
var TOKEN = CFG.token || '';

var STATUTS = ['A traiter', 'Interessant', 'Postule', 'Relance', 'Entretien', 'Refus', 'Ecarte', 'Lien mort'];
var STATUTS_TACHE = ['a faire', 'en cours', 'fait', 'annule'];
var COLONNES = [
  { cle: 'tri',         nom: 'A trier',     statuts: ['A traiter'] },
  { cle: 'interessant', nom: 'Interessant', statuts: ['Interessant'] },
  { cle: 'postule',     nom: 'Postule',     statuts: ['Postule', 'Relance'] },
  { cle: 'entretien',   nom: 'Entretien',   statuts: ['Entretien'] },
  { cle: 'fini',        nom: 'Termine',     statuts: ['Refus', 'Ecarte', 'Lien mort'] },
];
var LIB_CAT = { admin: 'Administratif', diplome: 'Diplome ICN', reseau: 'Reseau',
  documents: 'Documents', sante: 'Sante', logement: 'Logement', divers: 'Divers' };
var LIB_EXIG = { ans: 'Experience', langue: 'Langues', diplome: 'Diplome' };
var TEINTES = ['#C2540A', '#0B7285', '#3A5BC7', '#15803D', '#8E44AD', '#B0306A'];
var HUBS_CIBLES = ['munich', 'francfort', 'berlin', 'hamburg'];

var K = { ui: 'ck-ui-v3', moi: 'ck-moi', theme: 'ck-theme', pending: 'ck-pending-v1',
  cache: 'ck-sheet-v1', visite: 'ck-visite' };

// ------------------------------------------------------------------ etat
var DATA = { offres: [], tachesSeed: [], seed: { offres: {}, taches: {}, tachesSupprimees: [] }, meta: {} };
var SHEET = { statuts: {}, taches: {}, t: '' };
var PENDING = { statuts: {}, taches: {} };
var OFFRES = [], TACHES = [];
var MOI = '';
var vue = 'aujourdhui';
var filtres = { q: '', qui: 'tous', hub: 'tous', contrat: 'tous', tuile: null, col: 'tri' };
var ouverte = null, triId = null, triPassees = {}, selection = {};
var sync = API ? 'chargement' : 'local';
var flushTimer = null, enVol = false, chargeOK = false;

// --------------------------------------------------------------- outils
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function maintenant() { return new Date().toISOString(); }
function aujourdhui() { return maintenant().slice(0, 10); }
function joursDepuis(d) {
  if (!d) return null;
  var t = Date.parse(d);
  return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}
function joursAvant(d) { var j = joursDepuis(d); return j === null ? null : -j; }
function dateLisible(d) { return /^\d{4}-\d{2}-\d{2}/.test(d || '') ? String(d).slice(0, 10) : ''; }
function lsGet(k, def) {
  try { var v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
}
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function pluriel(n, s) { return n + ' ' + s + (n > 1 ? 's' : ''); }
function flash(msg) {
  var f = $('flash');
  f.textContent = msg;
  f.classList.add('on');
  clearTimeout(flash._t);
  flash._t = setTimeout(function () { f.classList.remove('on'); }, 2600);
}
function monogramme(nom) {
  var n = (nom || '?').trim();
  var mots = n.split(/[\s.\-_]+/).filter(Boolean);
  var ini = mots.length >= 2 ? (mots[0][0] + mots[1][0]) : n.slice(0, 2);
  var h = 0;
  for (var i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return { txt: ini.toUpperCase(), col: TEINTES[h % TEINTES.length] };
}
function lienReseau(ent) {
  return 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(ent)
    + '&network=%5B%22F%22%2C%22S%22%5D&origin=FACETED_SEARCH';
}
function classeStatut(s) { return 's-' + String(s || '').toLowerCase().replace(/\s+/g, '-'); }

// ----------------------------------------------------------- persistance
function sauverUI() {
  lsSet(K.ui, { vue: vue, filtres: filtres, ouverte: ouverte, triId: triId, triPassees: triPassees });
}
function restaurerUI() {
  var u = lsGet(K.ui, null);
  if (!u || typeof u !== 'object') return;
  if (['aujourdhui', 'trier', 'taches', 'offres', 'commandes'].indexOf(u.vue) !== -1) vue = u.vue;
  if (u.filtres && typeof u.filtres === 'object') {
    ['q', 'qui', 'hub', 'contrat', 'col'].forEach(function (k) {
      if (typeof u.filtres[k] === 'string') filtres[k] = u.filtres[k];
    });
    filtres.tuile = u.filtres.tuile || null;
  }
  if (typeof u.ouverte === 'string') ouverte = u.ouverte;
  if (typeof u.triId === 'string') triId = u.triId;
  if (u.triPassees && typeof u.triPassees === 'object') triPassees = u.triPassees;
}
function appliquerTheme(t) {
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  lsSet(K.theme, t || '');
}
function appliquerMoi(nom, bascule) {
  MOI = nom || '';
  document.documentElement.dataset.moi = MOI;
  lsSet(K.moi, MOI);
  document.querySelectorAll('#seg-moi button').forEach(function (b) {
    b.setAttribute('aria-pressed', b.dataset.moi === MOI ? 'true' : 'false');
  });
  if (bascule) filtres.qui = MOI || 'tous';
}

// --------------------------------------------------------------- fusion
function decisionDe(id) { return PENDING.statuts[id] || SHEET.statuts[id] || DATA.seed.offres[id] || null; }

function fusionner() {
  var vus = {};
  OFFRES = DATA.offres.map(function (o) {
    var m = Object.assign({}, o);
    var d = decisionDe(o.id);
    vus[o.id] = 1;
    if (d) {
      m.statut = d.statut || 'A traiter';
      m.note = d.note || '';
      m.par = d.par || '';
      m.maj = d.maj || '';
      if (d.qui) m.qui = d.qui;
    } else {
      m.statut = o.autoStatut || 'A traiter';
      m.note = ''; m.maj = '';
      m.par = o.autoStatut ? 'scanner' : '';
    }
    return m;
  });
  var toutes = {};
  [DATA.seed.offres, SHEET.statuts, PENDING.statuts].forEach(function (src) {
    Object.keys(src).forEach(function (id) { toutes[id] = 1; });
  });
  Object.keys(toutes).forEach(function (id) {
    if (vus[id]) return;
    var d = decisionDe(id);
    if (!d || !d.statut || d.statut === 'A traiter') return;
    OFFRES.push({ id: id, qui: d.qui || 'Anne', entreprise: d.entreprise || '', poste: d.poste || '',
      url: d.url || '', ville: d.ville || '', hub: d.hub || '', contratType: d.contratType || '',
      source: d.source || '', sources: d.source ? [d.source] : [], score: 0,
      statut: d.statut, note: d.note || '', par: d.par || '', maj: d.maj || '', disparue: true });
  });
  OFFRES.sort(function (a, b) {
    return (b.score || 0) - (a.score || 0) || (a.entreprise || '').localeCompare(b.entreprise || '');
  });

  var base = {};
  DATA.tachesSeed.forEach(function (t) { base[t.id] = Object.assign({}, t); });
  Object.keys(DATA.seed.taches).forEach(function (id) { base[id] = Object.assign(base[id] || {}, DATA.seed.taches[id]); });
  [SHEET.taches, PENDING.taches].forEach(function (src) {
    Object.keys(src).forEach(function (id) { base[id] = Object.assign(base[id] || {}, src[id]); });
  });
  var suppr = {};
  (DATA.seed.tachesSupprimees || []).forEach(function (id) { suppr[id] = 1; });
  TACHES = Object.keys(base).map(function (id) { return base[id]; }).filter(function (t) {
    return t.id && t.texte && !suppr[t.id] && String(t.supprimee || '') !== '1';
  });
}

function trouver(id) {
  for (var i = 0; i < OFFRES.length; i++) if (OFFRES[i].id === id) return OFFRES[i];
  return null;
}

// -------------------------------------------------------------- decisions
function ligneStatut(o, patch) {
  var d = decisionDe(o.id) || {};
  return {
    id: o.id,
    qui: patch.qui || d.qui || o.qui || '',
    statut: patch.statut !== undefined ? patch.statut : (d.statut || o.statut || 'A traiter'),
    note: patch.note !== undefined ? patch.note : (d.note || o.note || ''),
    par: MOI || '', maj: aujourdhui(), ts: maintenant(),
    entreprise: o.entreprise || '', poste: o.poste || '', url: o.url || '',
    ville: o.ville || '', hub: o.hub || '', contratType: o.contratType || '',
    source: (o.sources && o.sources[0]) || o.source || '',
  };
}
function decider(id, patch, silencieux) {
  var o = trouver(id);
  if (!o) return;
  PENDING.statuts[id] = ligneStatut(o, patch);
  lsSet(K.pending, PENDING);
  fusionner();
  planifierFlush();
  if (!silencieux) rendre();
}
function deciderLot(champ, valeur) {
  var ids = Object.keys(selection);
  if (!ids.length || !valeur) return;
  ids.forEach(function (id) {
    var o = trouver(id);
    if (!o) return;
    var p = {}; p[champ] = valeur;
    PENDING.statuts[id] = ligneStatut(o, p);
  });
  lsSet(K.pending, PENDING);
  selection = {};
  fusionner(); planifierFlush(); rendre();
  flash(pluriel(ids.length, 'offre') + ' mise' + (ids.length > 1 ? 's' : '') + ' a jour');
}
function ligneTache(t, patch) {
  var r = Object.assign({}, t, patch);
  r.par = MOI || ''; r.maj = aujourdhui(); r.ts = maintenant();
  return { id: r.id, cat: r.cat || 'divers', texte: r.texte || '', date: r.date || '',
    statut: r.statut || 'a faire', notes: r.notes || '', par: r.par, maj: r.maj, ts: r.ts,
    supprimee: r.supprimee ? '1' : '' };
}
function deciderTache(id, patch, silencieux) {
  var t = null;
  for (var i = 0; i < TACHES.length; i++) if (TACHES[i].id === id) t = TACHES[i];
  if (!t) return;
  PENDING.taches[id] = ligneTache(t, patch);
  lsSet(K.pending, PENDING);
  fusionner(); planifierFlush();
  if (!silencieux) rendre();
}
function creerTache(cat, texte, date) {
  var t = { id: 't-' + Date.now().toString(36), cat: cat || 'divers', texte: texte.trim(),
    date: (date || '').trim(), statut: 'a faire', notes: '' };
  PENDING.taches[t.id] = ligneTache(t, {});
  lsSet(K.pending, PENDING);
  fusionner(); planifierFlush(); rendre();
  flash('Tache ajoutee');
}

// ------------------------------------------------------------------ sync
function planifierFlush() {
  if (!API) { majBandeau(); return; }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 700);
}
function nbPending() { return Object.keys(PENDING.statuts).length + Object.keys(PENDING.taches).length; }
function flush() {
  if (!API || enVol) return;
  var items = [];
  Object.keys(PENDING.statuts).forEach(function (id) { items.push({ type: 'statut', data: PENDING.statuts[id] }); });
  Object.keys(PENDING.taches).forEach(function (id) { items.push({ type: 'tache', data: PENDING.taches[id] }); });
  if (!items.length) { sync = 'ok'; majBandeau(); return; }
  enVol = true; sync = 'envoi'; majBandeau();
  fetch(API, { method: 'POST', body: JSON.stringify({ token: TOKEN, items: items }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.erreur) || 'refus');
      items.forEach(function (it) {
        var store = it.type === 'statut' ? PENDING.statuts : PENDING.taches;
        var cible = it.type === 'statut' ? SHEET.statuts : SHEET.taches;
        var cur = store[it.data.id];
        if (cur && cur.ts === it.data.ts) delete store[it.data.id];
        cible[it.data.id] = it.data;
      });
      lsSet(K.pending, PENDING); lsSet(K.cache, SHEET);
      enVol = false; sync = 'ok';
      fusionner(); rendre();
      if (nbPending()) planifierFlush();
    })
    .catch(function () { enVol = false; sync = 'erreur'; majBandeau(); });
}
function rafraichir() {
  if (!API) return Promise.resolve();
  var url = API + (API.indexOf('?') > -1 ? '&' : '?') + 't=' + Date.now();
  return fetch(url).then(function (r) { return r.json(); }).then(function (res) {
    if (!res || !res.ok) throw new Error('refus');
    var s = {}, t = {};
    (res.statuts || []).forEach(function (r) { if (r.id) s[r.id] = r; });
    (res.taches || []).forEach(function (r) { if (r.id) t[r.id] = r; });
    SHEET = { statuts: s, taches: t, t: res.t || '' };
    ['statuts', 'taches'].forEach(function (k) {
      Object.keys(PENDING[k]).forEach(function (id) {
        var sh = SHEET[k][id], pe = PENDING[k][id];
        if (sh && sh.ts && pe.ts && sh.ts > pe.ts) delete PENDING[k][id];
      });
    });
    lsSet(K.cache, SHEET); lsSet(K.pending, PENDING);
    if (sync !== 'envoi') sync = nbPending() ? 'attente' : 'ok';
    fusionner(); rendre();
    if (nbPending()) planifierFlush();
  }).catch(function () {
    if (sync !== 'envoi') sync = 'erreur';
    majBandeau();
  });
}

function majBandeau() {
  var b = $('bandeau');
  var pied = $('pied-sync');
  var n = nbPending();
  var html = '', cls = '';
  if (!API) {
    cls = 'warn';
    html = '<span><b>Mode local.</b> Les statuts restent dans ce navigateur. Configure la feuille Google '
      + '(config.js) pour les partager avec l autre.</span>';
  } else if (sync === 'erreur') {
    cls = 'stop';
    html = '<span><b>Feuille Google injoignable.</b> ' + (n ? pluriel(n, 'modification') + ' en attente, gardee'
      + (n > 1 ? 's' : '') + ' ici. ' : '') + 'Reessai automatique.</span>'
      + '<button class="btn" id="btn-retry">Reessayer</button>';
  } else if (sync === 'envoi' || (sync === 'attente' && n)) {
    cls = 'info';
    html = '<span>Envoi de ' + pluriel(n, 'modification') + '...</span>';
  }
  if (html) { b.className = 'bandeau ' + cls; b.innerHTML = html; b.hidden = false; }
  else b.hidden = true;
  if (pied) {
    pied.textContent = !API ? 'Statuts : ce navigateur seulement.'
      : (sync === 'ok' ? 'Statuts partages via la feuille Google, synchronises ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + '.'
        : '');
  }
}

// ---------------------------------------------------------- classification
function aRelancer(o) {
  if (['Postule', 'Relance'].indexOf(o.statut) === -1) return false;
  var j = joursDepuis(o.maj);
  return j !== null && j >= 10;
}
function expireBientot(o) {
  if (['Refus', 'Ecarte', 'Lien mort'].indexOf(o.statut) !== -1) return false;
  var j = joursAvant(o.expire);
  return j !== null && j >= 0 && j <= 7;
}
function aTrier(o) { return o.statut === 'A traiter'; }
function colonneDe(o) {
  for (var i = 0; i < COLONNES.length; i++) if (COLONNES[i].statuts.indexOf(o.statut) !== -1) return COLONNES[i].cle;
  return 'tri';
}
function passeQui(o) { return filtres.qui === 'tous' || o.qui === filtres.qui; }
function passe(o) {
  if (!passeQui(o)) return false;
  if (filtres.hub !== 'tous' && (o.hub || '').toLowerCase().indexOf(filtres.hub.toLowerCase()) === -1) return false;
  if (filtres.contrat !== 'tous' && (o.contratType || 'CDI') !== filtres.contrat) return false;
  if (filtres.tuile === 'tri' && !aTrier(o)) return false;
  if (filtres.tuile === 'relance' && !aRelancer(o)) return false;
  if (filtres.tuile === 'expire' && !expireBientot(o)) return false;
  if (filtres.q) {
    var s = ((o.entreprise || '') + ' ' + (o.poste || '') + ' ' + (o.ville || '') + ' ' + (o.note || '')).toLowerCase();
    if (s.indexOf(filtres.q.toLowerCase()) === -1) return false;
  }
  return true;
}
function prioriteTri(o) {
  var u = 0;
  var je = joursAvant(o.expire);
  if (je !== null && je >= 0) u += je <= 3 ? 40 : (je <= 7 ? 25 : (je <= 14 ? 10 : 0));
  if (o.nouveau) u += 8;
  if (o.primeDoublon) u += o.primeDoublon;
  if (o.corpsNonLu) u -= 6;
  return (o.score || 0) + u;
}
function fileTri() {
  return OFFRES.filter(function (o) {
    return aTrier(o) && !o.disparue && o.etatLien !== 'morte' && passe(o);
  }).sort(function (a, b) {
    var pa = triPassees[a.id] ? 1 : 0, pb = triPassees[b.id] ? 1 : 0;
    if (pa !== pb) return pa - pb;
    return prioriteTri(b) - prioriteTri(a);
  });
}

// ------------------------------------------------------------------ chips
function chipsDe(o, complet) {
  var c = '';
  var ct = o.contratType || 'CDI';
  c += '<span class="chip contrat c-' + esc(ct.toLowerCase()) + '">' + esc(ct) + '</span>';
  if (o.hub) c += '<span class="chip hub">' + esc(o.hub) + '</span>';
  if (o.nouveau) c += '<span class="chip neuf">nouveau</span>';
  var je = joursAvant(o.expire);
  if (je !== null && je >= 0 && je <= 14) c += '<span class="chip ' + (je <= 7 ? 'urgent' : 'relance') + '">expire J-' + je + '</span>';
  if (aRelancer(o)) c += '<span class="chip relance">a relancer, J+' + joursDepuis(o.maj) + '</span>';
  if (o.etatLien === 'morte') c += '<span class="chip urgent" title="' + esc(o.motifLien || '') + '">offre fermee</span>';
  else if (o.etatLien === 'incertain') c += '<span class="chip relance" title="' + esc(o.motifLien || '') + '">a verifier</span>';
  else if (o.etatLien === 'vivante') c += '<span class="chip ok" title="verifie le ' + esc(o.verifieLe || '') + '">en ligne</span>';
  if (o.langue === 'de' || o.langue === 'de-mais-en') c += '<span class="chip de">annonce en allemand</span>';
  if (o.disparue) c += '<span class="chip">annonce retiree</span>';
  if (o.adjacent) c += '<span class="chip relance" title="Titre hors achats purs : supply chain, contrats, projet, qualite, methodes, produit.">achats elargi</span>';
  if (o.corpsNonLu) c += '<span class="chip relance" title="Le scanner n a pas pu lire la description. A lire en entier avant de postuler.">annonce non lue</span>';
  if (o.diffusionLarge) c += '<span class="chip signal" title="' + esc((o.sources || []).join(', ')) + '. Le besoin est reel et il presse.">diffusee sur ' + o.sources.length + ' plateformes</span>';
  else if (o.republiee > 1) c += '<span class="chip signal" title="Relancee faute de candidats, ou plusieurs postes.">republiee ' + o.republiee + ' fois</span>';
  if (o.sources && o.sources.length) c += '<span class="chip" title="' + esc(o.sources.join(', ')) + '">' + esc(o.sources[0]) + (o.sources.length > 1 ? ' +' + (o.sources.length - 1) : '') + '</span>';
  else if (o.source) c += '<span class="chip">' + esc(o.source) + '</span>';
  if (o.remuneration) c += '<span class="chip mono">' + esc(o.remuneration) + '</span>';
  if (!o.disparue) {
    var s = o.score || 0, niv = s >= 105 ? 'fort' : (s >= 85 ? 'bon' : 'ok');
    c += '<span class="chip pertinence ' + niv + '" title="pertinence ' + s + '">'
      + (niv === 'fort' ? 'tres pertinent' : (niv === 'bon' ? 'pertinent' : 'a voir')) + '</span>';
  }
  return c;
}

// ------------------------------------------------------------------ carte
function carte(o, sansPick) {
  var est = ouverte === o.id;
  var mg = monogramme(o.entreprise || o.poste);
  var html = '<article class="card' + (est ? ' open' : '') + (o.disparue ? ' disparue' : '') + '" data-id="' + esc(o.id) + '" tabindex="0">'
    + '<div class="card-top"><div class="mono-av" style="background:' + mg.col + '">' + esc(mg.txt) + '</div>'
    + '<div class="card-txt"><div class="ent"><span>' + esc(o.entreprise || 'Entreprise inconnue') + '</span>'
    + (filtres.qui === 'tous' ? '<span class="' + (o.qui === 'Anne' ? 'qui-a' : 'qui-j') + '">' + esc(o.qui) + '</span>' : '')
    + '</div><h4>' + esc(o.poste) + '</h4></div>'
    + (sansPick ? '' : '<label class="pick" title="selectionner pour un traitement en lot"><input type="checkbox" class="o-pick" data-id="' + esc(o.id) + '"' + (selection[o.id] ? ' checked' : '') + '></label>')
    + '</div><div class="chips">' + chipsDe(o) + '</div>';
  if (!est && (o.note || '').trim()) {
    html += '<div class="note-apercu">' + esc(o.note.slice(0, 110)) + (o.note.length > 110 ? '...' : '') + '</div>';
  }
  if (est) {
    var rapides = ['Interessant', 'Postule', 'Relance', 'Entretien', 'Ecarte', 'Lien mort'];
    var acts = rapides.map(function (s) {
      return '<button class="act ' + classeStatut(s) + '" data-act="' + esc(s) + '" data-id="' + esc(o.id) + '" aria-pressed="' + (o.statut === s) + '">' + esc(s) + '</button>';
    }).join('');
    var opts = STATUTS.map(function (s) { return '<option value="' + esc(s) + '"' + (o.statut === s ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('');
    var quiOpts = ['Anne', 'Joffrey'].map(function (p) { return '<option value="' + p + '"' + (o.qui === p ? ' selected' : '') + '>' + p + '</option>'; }).join('');
    var exig = '';
    if (o.exigences && o.exigences.length) {
      exig = '<ul class="exig">' + o.exigences.map(function (x) {
        return '<li><span class="fam">' + esc(LIB_EXIG[x.quoi] || x.quoi) + '</span><span>' + esc(x.texte) + '</span></li>';
      }).join('') + '</ul>';
    }
    html += '<div class="detail">'
      + '<div class="actions">' + acts + '</div>'
      + '<div class="rangee"><label>Etape</label><select class="f-statut" data-id="' + esc(o.id) + '">' + opts + '</select>'
      + '<label style="margin-left:6px">Pour</label><select class="f-qui" data-id="' + esc(o.id) + '">' + quiOpts + '</select></div>'
      + exig
      + (o.extrait ? '<p class="extrait">' + esc(o.extrait) + '</p>' : '')
      + '<textarea class="f-note" data-id="' + esc(o.id) + '" placeholder="Contact, date de relance, retour d entretien, ce que l autre doit savoir...">' + esc(o.note || '') + '</textarea>'
      + '<div class="rangee">'
      + (o.url ? '<a class="lien" href="' + esc(o.url) + '" target="_blank" rel="noopener">Ouvrir l annonce</a>' : '')
      + '<a class="lien reseau" href="' + esc(lienReseau(o.entreprise || '')) + '" target="_blank" rel="noopener" title="Relations LinkedIn de 1er et 2e degre chez cet employeur">Qui je connais ici</a>'
      + '</div><div class="sig">' + esc(o.ville || '') + (dateLisible(o.date) ? ' &middot; publiee le ' + dateLisible(o.date) : '')
      + (o.ref ? ' &middot; ' + esc(o.ref) : '') + (o.maj ? ' &middot; modifie par ' + esc(o.par || '?') + ' le ' + esc(o.maj) : '')
      + '</div></div>';
  }
  return html + '</article>';
}

// ----------------------------------------------------------------- taches
function jourEcheance(t) {
  if (!t.date) return null;
  var d = Date.parse(t.date);
  if (isNaN(d)) return null;
  var auj = new Date(); auj.setHours(0, 0, 0, 0);
  return Math.round((d - auj.getTime()) / 86400000);
}
function tacheActive(t) { return t.statut !== 'fait' && t.statut !== 'annule'; }
function enRetard(t) { var j = jourEcheance(t); return tacheActive(t) && j !== null && j < 0; }
function bientot(t) { var j = jourEcheance(t); return tacheActive(t) && j !== null && j >= 0 && j <= 7; }

function carteTache(t) {
  var j = jourEcheance(t), fini = !tacheActive(t);
  var chips = '<span class="chip cat">' + esc(LIB_CAT[t.cat] || t.cat) + '</span>';
  if (t.date) {
    var cls = j === null ? '' : (j < 0 ? ' urgent' : (j <= 7 ? ' relance' : ''));
    var lib = j === null ? esc(t.date) : (j < 0 ? 'en retard de ' + (-j) + ' j' : (j === 0 ? 'aujourd hui' : 'J-' + j));
    chips += '<span class="chip' + cls + '">' + lib + ' &middot; ' + esc(t.date) + '</span>';
  }
  var opts = STATUTS_TACHE.map(function (x) { return '<option value="' + x + '"' + (t.statut === x ? ' selected' : '') + '>' + x + '</option>'; }).join('');
  return '<article class="tache' + (fini ? ' done' : '') + '">'
    + '<label class="coche"><input type="checkbox" class="t-fait" data-id="' + esc(t.id) + '"' + (t.statut === 'fait' ? ' checked' : '') + '></label>'
    + '<div class="t-corps"><div class="t-titre">' + esc(t.texte) + '</div><div class="chips">' + chips + '</div>'
    + '<textarea class="t-note" data-id="' + esc(t.id) + '" placeholder="note, avancement, ce que l autre doit savoir...">' + esc(t.notes || '') + '</textarea>'
    + '<div class="t-pied"><select class="t-statut" data-id="' + esc(t.id) + '">' + opts + '</select>'
    + '<input type="date" class="t-date" data-id="' + esc(t.id) + '" value="' + esc(t.date || '') + '">'
    + '<button class="t-suppr" data-id="' + esc(t.id) + '">supprimer</button>'
    + (t.maj ? '<span class="sig">' + esc(t.par || '') + ' &middot; ' + esc(t.maj) + '</span>' : '')
    + '</div></div></article>';
}

function rendreTaches() {
  var zone = $('vue-taches');
  var groupes = {};
  TACHES.forEach(function (t) { (groupes[t.cat] = groupes[t.cat] || []).push(t); });
  var html = '';
  Object.keys(LIB_CAT).forEach(function (cat) {
    var lot = (groupes[cat] || []).slice().sort(function (a, b) {
      if (tacheActive(a) !== tacheActive(b)) return tacheActive(a) ? -1 : 1;
      return (a.date || '9999').localeCompare(b.date || '9999');
    });
    html += '<section class="grp"><div class="grp-head"><span class="grp-nom">' + esc(LIB_CAT[cat]) + '</span>'
      + '<span class="grp-n">' + lot.filter(tacheActive).length + ' a faire sur ' + lot.length + '</span>'
      + '<button class="btn mini t-ajout" data-cat="' + cat + '">+ tache</button></div>'
      + '<form class="t-form" data-cat="' + cat + '" hidden><input type="text" name="texte" placeholder="Nouvelle tache" required>'
      + '<input type="date" name="date"><button class="btn plein" type="submit">Ajouter</button></form>'
      + (lot.length ? lot.map(carteTache).join('') : '<div class="vide">Rien dans cette categorie.</div>')
      + '</section>';
  });
  zone.innerHTML = html;
}

// ------------------------------------------------------------- aujourd hui
function rendreAujourdhui() {
  var zone = $('vue-aujourdhui');
  var retard = TACHES.filter(enRetard), proche = TACHES.filter(bientot);
  var html = '';
  function bloc(titre, sous, contenu, classe) {
    return '<section class="bloc ' + (classe || '') + '"><h3>' + titre + ' <span class="sous">' + sous + '</span></h3>' + contenu + '</section>';
  }
  var cinq = OFFRES.filter(function (o) { return aTrier(o) && !o.disparue && o.etatLien !== 'morte' && passeQui(o); })
    .map(function (o) { return { o: o, p: prioriteTri(o) }; })
    .sort(function (a, b) { return b.p - a.p; }).slice(0, 5).map(function (x) { return x.o; });
  if (cinq.length) {
    html += bloc('Les cinq du jour', 'a ouvrir avant midi, classees par pertinence et urgence',
      cinq.map(function (o) { return carte(o, true); }).join(''), 'bleu');
  }
  var parEnt = {};
  OFFRES.forEach(function (o) {
    if (['Ecarte', 'Refus', 'Lien mort'].indexOf(o.statut) !== -1 || o.disparue || o.etatLien === 'morte') return;
    var k = (o.entreprise || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!k) return;
    var e = parEnt[k] = parEnt[k] || { nom: o.entreprise, Anne: [], Joffrey: [] };
    if (e[o.qui]) e[o.qui].push(o);
  });
  var couple = Object.keys(parEnt).map(function (k) { return parEnt[k]; })
    .filter(function (e) { return e.Anne.length && e.Joffrey.length; })
    .sort(function (a, b) {
      var m = function (e) { return Math.max.apply(null, e.Anne.concat(e.Joffrey).map(function (o) { return o.score || 0; })); };
      return m(b) - m(a);
    });
  if (couple.length && filtres.qui === 'tous') {
    html += bloc('Employeurs pour vous deux', couple.length + ' entreprise(s) avec une piste pour chacun',
      '<div class="couple">' + couple.slice(0, 12).map(function (e) {
        var a = e.Anne.sort(function (x, y) { return (y.score || 0) - (x.score || 0); })[0];
        var j = e.Joffrey.sort(function (x, y) { return (y.score || 0) - (x.score || 0); })[0];
        return '<div class="couple-ligne"><div class="couple-ent">' + esc(e.nom) + '</div>'
          + '<div class="couple-a"><span class="qui-a">Anne</span>' + esc(a.poste.slice(0, 48)) + (e.Anne.length > 1 ? ' +' + (e.Anne.length - 1) : '') + '</div>'
          + '<div class="couple-j"><span class="qui-j">Joffrey</span>' + esc(j.poste.slice(0, 48)) + (e.Joffrey.length > 1 ? ' +' + (e.Joffrey.length - 1) : '') + '</div></div>';
      }).join('') + '</div>', 'violet');
  }
  html += bloc('En retard', pluriel(retard.length, 'tache'), retard.length ? retard.map(carteTache).join('') : '<div class="vide">Rien en retard.</div>', 'rouge');
  html += bloc('Cette semaine', pluriel(proche.length, 'echeance'), proche.length ? proche.map(carteTache).join('') : '<div class="vide">Aucune echeance dans les 7 jours.</div>', 'ambre');
  var urg = OFFRES.filter(function (o) { return expireBientot(o) && passeQui(o); }).sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  if (urg.length) html += bloc('Annonces qui ferment', pluriel(urg.length, 'offre'), urg.slice(0, 6).map(carte).join(''), 'rouge');
  var rel = OFFRES.filter(function (o) { return aRelancer(o) && passeQui(o); });
  if (rel.length) html += bloc('A relancer', pluriel(rel.length, 'candidature'), rel.slice(0, 6).map(carte).join(''), 'ambre');
  zone.innerHTML = html || '<div class="vide grand">Rien d urgent aujourd hui. Passe a l onglet Trier.</div>';
}

// ------------------------------------------------------------------ trier
function rendreTrier() {
  var zone = $('vue-trier');
  var file = fileTri(), pos = 0;
  if (triId) for (var i = 0; i < file.length; i++) if (file[i].id === triId) { pos = i; break; }
  var o = file[pos];
  var nP = $('n-trier');
  nP.textContent = file.length;
  nP.hidden = !file.length;
  if (!o) {
    triId = null;
    zone.innerHTML = '<div class="tri-fini"><div class="tri-fini-ico">&#10003;</div><h3>File vide</h3>'
      + '<p>Plus rien a juger' + (filtres.qui === 'tous' ? '' : ' pour ' + esc(filtres.qui))
      + '. Les offres jugees sont dans l onglet Offres, le prochain scan remplira celle-ci.</p></div>';
    return;
  }
  triId = o.id;
  var exig;
  if (o.exigences && o.exigences.length) {
    exig = '<div class="tri-bloc"><h4>Ce que l annonce exige</h4><ul class="exig">' + o.exigences.map(function (x) {
      return '<li><span class="fam">' + esc(LIB_EXIG[x.quoi] || x.quoi) + '</span><span>' + esc(x.texte) + '</span></li>';
    }).join('') + '</ul></div>';
  } else if (o.corpsNonLu) {
    exig = '<div class="tri-bloc tri-manque"><h4>Annonce non lue</h4><p>Le scanner n a pas pu recuperer la description : ni les annees exigees ni la langue demandee n ont ete verifiees. Cette offre n a ete jugee que sur son titre, il faut l ouvrir.</p></div>';
  } else {
    exig = '<div class="tri-bloc tri-manque"><h4>Aucune condition chiffree</h4><p>La description a ete lue jusqu en bas : elle ne mentionne ni annees d experience, ni niveau de langue, ni diplome exige.</p></div>';
  }
  var mg = monogramme(o.entreprise || o.poste);
  zone.innerHTML = '<div class="tri-tete"><div class="tri-avance"><span>' + (pos + 1) + ' sur ' + file.length + '</span>'
    + '<div class="tri-jauge"><i style="width:' + Math.round(100 * pos / Math.max(1, file.length)) + '%"></i></div></div>'
    + '<div class="tri-aide"><kbd>J</kbd> interessant <kbd>K</kbd> ecarter <kbd>L</kbd> lien mort <kbd>P</kbd> postule <kbd>&rarr;</kbd> passer <kbd>O</kbd> ouvrir</div></div>'
    + '<article class="tri-carte" data-id="' + esc(o.id) + '"><div class="tri-haut">'
    + '<div class="mono-av grand" style="background:' + mg.col + '">' + esc(mg.txt) + '</div>'
    + '<div class="tri-titres"><div class="tri-ent">' + esc(o.entreprise || 'Entreprise inconnue')
    + '<span class="' + (o.qui === 'Anne' ? 'qui-a' : 'qui-j') + '">' + esc(o.qui) + '</span></div>'
    + '<h2>' + esc(o.poste) + '</h2><div class="tri-lieu">' + esc(o.ville || '')
    + (dateLisible(o.date) ? ' &middot; publiee le ' + dateLisible(o.date) : '')
    + (o.sources && o.sources.length ? ' &middot; ' + esc(o.sources.join(', ')) : '') + '</div></div></div>'
    + '<div class="chips">' + chipsDe(o) + '</div>' + exig
    + (o.extrait ? '<div class="tri-bloc"><h4>L annonce, au debut</h4><p class="extrait">' + esc(o.extrait) + '</p></div>' : '')
    + '<div class="tri-motif" id="tri-motif" hidden><label for="tri-note">Pourquoi tu l ecartes, en une ligne. Cette phrase corrige le scanner.</label>'
    + '<input type="text" id="tri-note" placeholder="allemand C1 exige, 5 ans demandes, diplome ingenieur, poste hors bassin..." autocomplete="off">'
    + '<span class="tri-motif-aide">Entree pour valider, Echap pour annuler</span></div>'
    + '<div class="tri-actions">'
    + '<button class="tri-btn oui" data-tri="Interessant"><b>Interessant</b><span>J</span></button>'
    + '<button class="tri-btn non" data-tri="Ecarte"><b>Ecarter</b><span>K</span></button>'
    + '<button class="tri-btn mort" data-tri="Lien mort"><b>Lien mort</b><span>L</span></button>'
    + '<button class="tri-btn" data-tri="passer"><b>Passer</b><span>&rarr;</span></button>'
    + (o.url ? '<a class="tri-btn lien" href="' + esc(o.url) + '" target="_blank" rel="noopener"><b>Ouvrir l annonce</b><span>O</span></a>' : '')
    + '<a class="tri-btn reseau" href="' + esc(lienReseau(o.entreprise || '')) + '" target="_blank" rel="noopener"><b>Qui je connais ici</b><span>LinkedIn</span></a>'
    + '</div></article>';
}
function decisionTri(statut) {
  var file = fileTri();
  if (!file.length) return;
  var pos = 0;
  for (var i = 0; i < file.length; i++) if (file[i].id === triId) { pos = i; break; }
  var cour = file[pos];
  if (!cour) return;
  var suiv = file[pos + 1] || file[pos - 1] || null;
  if (statut === 'passer') { triPassees[cour.id] = 1; triId = suiv ? suiv.id : null; rendre(); return; }
  var champ = $('tri-note');
  var motif = champ ? champ.value.trim() : '';
  var patch = { statut: statut };
  if (motif) patch.note = motif;
  delete triPassees[cour.id];
  triId = suiv ? suiv.id : null;
  decider(cour.id, patch);
  flash((cour.entreprise || 'offre') + ' : ' + statut.toLowerCase() + (motif ? ', motif enregistre' : ''));
}
function avancerTri(d) {
  var file = fileTri();
  if (!file.length) return;
  var pos = 0;
  for (var i = 0; i < file.length; i++) if (file[i].id === triId) { pos = i; break; }
  var n = Math.max(0, Math.min(file.length - 1, pos + d));
  triId = file[n].id;
  rendreTrier(); sauverUI();
}
function demanderMotif() {
  var z = $('tri-motif'), c = $('tri-note');
  if (!z || !c) { decisionTri('Ecarte'); return; }
  if (z.hidden) { z.hidden = false; c.focus(); return; }
  decisionTri('Ecarte');
}

// ------------------------------------------------------------------ offres
function rendreOffres() {
  var vis = OFFRES.filter(passe);
  var nSel = Object.keys(selection).length;
  var barre = $('barre-sel');
  barre.hidden = !nSel;
  if (nSel) {
    $('n-sel').textContent = nSel + ' selectionnee' + (nSel > 1 ? 's' : '');
    $('sel-statut').value = ''; $('sel-qui').value = '';
  }
  var base = OFFRES.filter(passeQui);
  [['tri', aTrier], ['relance', aRelancer], ['expire', expireBientot]].forEach(function (p) {
    var n = base.filter(p[1]).length;
    $('t-' + p[0]).textContent = n;
    var t = document.querySelector('.tile[data-tuile="' + p[0] + '"]');
    t.classList.toggle('zero', n === 0);
    t.setAttribute('aria-pressed', filtres.tuile === p[0] ? 'true' : 'false');
  });
  var total = 0, parCol = {};
  COLONNES.forEach(function (c) { parCol[c.cle] = base.filter(function (o) { return colonneDe(o) === c.cle; }).length; total += parCol[c.cle]; });
  COLONNES.forEach(function (c) {
    var seg = $('rail-' + c.cle);
    seg.style.flexGrow = parCol[c.cle]; seg.style.display = parCol[c.cle] ? '' : 'none'; seg.title = c.nom + ' : ' + parCol[c.cle];
    $('leg-' + c.cle).textContent = parCol[c.cle];
  });
  $('rail-total').textContent = pluriel(total, 'offre') + (filtres.qui === 'tous' ? '' : ' pour ' + filtres.qui);

  var picker = '<div class="seg">' + COLONNES.map(function (c) {
    var n = vis.filter(function (o) { return colonneDe(o) === c.cle; }).length;
    return '<button data-col="' + c.cle + '" aria-pressed="' + (filtres.col === c.cle) + '">' + c.nom + '<span class="n">' + n + '</span></button>';
  }).join('') + '</div>';
  $('col-picker').innerHTML = picker;

  COLONNES.forEach(function (c) {
    var lot = vis.filter(function (o) { return colonneDe(o) === c.cle; });
    lot.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    $('n-' + c.cle).textContent = lot.length;
    var col = document.querySelector('.col[data-col="' + c.cle + '"]');
    col.classList.toggle('active', filtres.col === c.cle);
    $('col-' + c.cle).innerHTML = lot.length ? lot.map(function (o) { return carte(o); }).join('')
      : '<div class="vide">' + (c.cle === 'tri' ? 'Rien a trier. Tout est classe.' : 'Aucune offre a cette etape.') + '</div>';
  });
}

function exporterCSV() {
  var vis = OFFRES.filter(passe);
  var cols = ['qui', 'statut', 'entreprise', 'poste', 'ville', 'hub', 'contratType', 'score', 'date', 'expire', 'source', 'url', 'note', 'par', 'maj'];
  var lignes = [cols.join(';')].concat(vis.map(function (o) {
    return cols.map(function (c) {
      var v = c === 'source' ? ((o.sources || []).join('|') || o.source || '') : (o[c] == null ? '' : o[c]);
      return '"' + String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
    }).join(';');
  }));
  var blob = new Blob(['﻿' + lignes.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cockpit_' + aujourdhui() + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  flash(pluriel(vis.length, 'offre') + ' exportee' + (vis.length > 1 ? 's' : ''));
}

// ------------------------------------------------------------------ rendu
function refleterFiltres() {
  var q = $('q');
  if (q.value !== filtres.q) q.value = filtres.q || '';
  document.querySelectorAll('.seg[data-groupe] button').forEach(function (b) {
    var g = b.parentNode.dataset.groupe;
    b.setAttribute('aria-pressed', b.dataset.val === filtres[g] ? 'true' : 'false');
  });
}
function rendre() {
  if (!chargeOK) return;
  ['aujourdhui', 'trier', 'taches', 'offres', 'commandes'].forEach(function (v) { $('vue-' + v).hidden = v !== vue; });
  document.querySelectorAll('.nav button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.vue === vue ? 'true' : 'false'); });
  var nRetard = TACHES.filter(enRetard).length, nProche = TACHES.filter(bientot).length;
  var p = $('n-urgent');
  p.textContent = nRetard + nProche; p.hidden = !(nRetard + nProche); p.className = 'pastille' + (nRetard ? ' rouge' : '');
  $('n-taches').textContent = TACHES.filter(tacheActive).length;
  refleterFiltres();
  sauverUI();
  rendreAujourdhui();
  rendreTrier();
  rendreTaches();
  rendreOffres();
  majBandeau();
}

// ------------------------------------------------------------ interactions
document.addEventListener('click', function (e) {
  var t = e.target;
  var q = function (sel) { return t.closest && t.closest(sel); };
  var el;
  if ((el = q('.nav button'))) { vue = el.dataset.vue; rendre(); window.scrollTo({ top: 0 }); return; }
  if ((el = q('#seg-moi button'))) { appliquerMoi(el.dataset.moi === MOI ? '' : el.dataset.moi, true); rendre(); return; }
  if (t.id === 'btn-theme' || q('#btn-theme')) {
    var cur = document.documentElement.getAttribute('data-theme');
    var sys = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var actuel = cur || (sys ? 'dark' : 'light');
    appliquerTheme(actuel === 'dark' ? 'light' : 'dark');
    return;
  }
  if (t.id === 'btn-retry') { flush(); rafraichir(); return; }
  if (t.id === 'btn-csv') { exporterCSV(); return; }
  if ((el = q('.cmd-cell'))) {
    var code = el.querySelector('code');
    if (!code) return;
    var txt = code.textContent;
    var ok = function () { flash('Copie : ' + txt.slice(0, 60)); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(ok).catch(function () { window.getSelection().selectAllChildren(code); });
    else window.getSelection().selectAllChildren(code);
    return;
  }
  if ((el = q('.t-ajout'))) {
    var f = el.closest('.grp').querySelector('.t-form');
    f.hidden = !f.hidden;
    if (!f.hidden) f.querySelector('input[name=texte]').focus();
    return;
  }
  if ((el = q('.t-suppr'))) {
    if (el.dataset.confirme === '1') { deciderTache(el.dataset.id, { supprimee: '1' }); flash('Tache supprimee'); }
    else { el.dataset.confirme = '1'; el.textContent = 'confirmer la suppression'; }
    return;
  }
  if ((el = q('.tile'))) { var v = el.dataset.tuile; filtres.tuile = filtres.tuile === v ? null : v; rendre(); return; }
  if ((el = q('.seg[data-groupe] button'))) { filtres[el.parentNode.dataset.groupe] = el.dataset.val; rendre(); return; }
  if ((el = q('.col-picker button'))) { filtres.col = el.dataset.col; rendre(); return; }
  if ((el = q('.tri-btn[data-tri]'))) { if (el.dataset.tri === 'Ecarte') demanderMotif(); else decisionTri(el.dataset.tri); return; }
  if ((el = q('.act[data-act]'))) {
    var o = trouver(el.dataset.id);
    var nouveau = (o && o.statut === el.dataset.act) ? 'A traiter' : el.dataset.act;
    decider(el.dataset.id, { statut: nouveau });
    flash((o ? o.entreprise : 'offre') + ' : ' + nouveau.toLowerCase());
    return;
  }
  if (q('.pick')) return;
  if (t.id === 'sel-rien') { selection = {}; rendre(); return; }
  if (t.id === 'sel-tout') { OFFRES.filter(passe).forEach(function (o) { selection[o.id] = 1; }); rendre(); return; }
  if (q('.detail') || q('.t-form')) return;
  if ((el = q('.card'))) { ouverte = ouverte === el.dataset.id ? null : el.dataset.id; rendre(); return; }
});

document.addEventListener('submit', function (e) {
  var f = e.target.closest && e.target.closest('.t-form');
  if (!f) return;
  e.preventDefault();
  var texte = f.querySelector('input[name=texte]').value;
  if (!texte.trim()) return;
  creerTache(f.dataset.cat, texte, f.querySelector('input[name=date]').value);
});

document.addEventListener('change', function (e) {
  var t = e.target, el;
  var q = function (sel) { return t.closest && t.closest(sel); };
  if ((el = q('.t-fait'))) { deciderTache(el.dataset.id, { statut: el.checked ? 'fait' : 'a faire' }); return; }
  if ((el = q('.t-statut'))) { deciderTache(el.dataset.id, { statut: el.value }); return; }
  if ((el = q('.t-date'))) { deciderTache(el.dataset.id, { date: el.value }); return; }
  if ((el = q('.t-note'))) { deciderTache(el.dataset.id, { notes: el.value }); return; }
  if ((el = q('.o-pick'))) { if (el.checked) selection[el.dataset.id] = 1; else delete selection[el.dataset.id]; rendre(); return; }
  if (t.id === 'sel-statut') { deciderLot('statut', t.value); return; }
  if (t.id === 'sel-qui') { deciderLot('qui', t.value); return; }
  if ((el = q('select.f-statut'))) { decider(el.dataset.id, { statut: el.value }); return; }
  if ((el = q('select.f-qui'))) { decider(el.dataset.id, { qui: el.value }); return; }
  if ((el = q('textarea.f-note'))) { decider(el.dataset.id, { note: el.value }); return; }
});

document.addEventListener('input', function (e) {
  var t = e.target;
  if (t.id === 'q') { filtres.q = t.value; rendre(); return; }
  var n = t.closest && t.closest('textarea.f-note');
  if (n) { decider(n.dataset.id, { note: n.value }, true); return; }
  var tn = t.closest && t.closest('textarea.t-note');
  if (tn) { deciderTache(tn.dataset.id, { notes: tn.value }, true); }
});

document.addEventListener('keydown', function (e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('card')) {
    e.preventDefault(); ouverte = ouverte === e.target.dataset.id ? null : e.target.dataset.id; rendre(); return;
  }
  if (vue !== 'trier') return;
  var dansChamp = e.target && ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(e.target.tagName) !== -1;
  if (dansChamp) {
    if (e.target.id !== 'tri-note') return;
    if (e.key === 'Enter') { e.preventDefault(); decisionTri('Ecarte'); }
    if (e.key === 'Escape') { e.preventDefault(); e.target.value = ''; $('tri-motif').hidden = true; e.target.blur(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  var k = e.key.toLowerCase();
  if (k === 'j') { e.preventDefault(); decisionTri('Interessant'); return; }
  if (k === 'k') { e.preventDefault(); demanderMotif(); return; }
  if (k === 'l') { e.preventDefault(); decisionTri('Lien mort'); return; }
  if (k === 'p') { e.preventDefault(); decisionTri('Postule'); return; }
  if (k === 'o') {
    var f = fileTri(), cur = null;
    for (var i = 0; i < f.length; i++) if (f[i].id === triId) cur = f[i];
    if (cur && cur.url) { e.preventDefault(); window.open(cur.url, '_blank', 'noopener'); }
    return;
  }
  if (e.key === 'ArrowRight' || k === ' ') { e.preventDefault(); decisionTri('passer'); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); avancerTri(-1); return; }
  if (e.key === 'Escape') { e.preventDefault(); vue = 'offres'; rendre(); }
});

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') { rafraichir(); if (nbPending()) flush(); }
});
window.addEventListener('online', function () { if (nbPending()) flush(); });
setInterval(function () { if (document.visibilityState === 'visible') rafraichir(); }, 90000);
setInterval(function () { if (nbPending() && !enVol) flush(); }, 30000);

// -------------------------------------------------------------- demarrage
function charger(url) {
  return fetch(url + '?v=' + Date.now()).then(function (r) { if (!r.ok) throw new Error(url); return r.json(); });
}
function demarrer() {
  appliquerTheme(lsGet(K.theme, ''));
  restaurerUI();
  var moi = lsGet(K.moi, '');
  var quiChoisi = filtres.qui;
  appliquerMoi(moi, false);
  filtres.qui = quiChoisi;
  PENDING = lsGet(K.pending, PENDING);
  if (!PENDING.statuts) PENDING = { statuts: {}, taches: {} };
  var cache = lsGet(K.cache, null);
  if (cache && cache.statuts) SHEET = cache;

  Promise.all([
    charger('data/offres.json'),
    charger('data/taches_seed.json').catch(function () { return []; }),
    charger('data/decisions_seed.json').catch(function () { return { offres: {}, taches: {}, tachesSupprimees: [] }; }),
    charger('data/meta.json').catch(function () { return {}; }),
  ]).then(function (r) {
    DATA.offres = r[0]; DATA.tachesSeed = r[1]; DATA.seed = r[2]; DATA.meta = r[3];
    chargeOK = true;
    var m = DATA.meta;
    var nA = DATA.offres.filter(function (o) { return o.qui === 'Anne'; }).length;
    var nJ = DATA.offres.length - nA;
    $('scan-meta').innerHTML = 'Quatre bassins &middot; dernier scan <span class="mono">' + esc(m.genere || '?') + '</span>'
      + ' &middot; Anne ' + nA + ', Joffrey ' + nJ + (m.nouveaux ? ' &middot; <b>' + m.nouveaux + ' nouvelles</b>' : '');
    var sel = $('sel-statut');
    STATUTS.forEach(function (s) { var o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); });
    fusionner();
    rendre();
    var visite = lsGet(K.visite, '');
    if (m.nouveaux && m.genere && visite && visite < m.genere) flash(m.nouveaux + ' nouvelles offres depuis ta visite du ' + visite);
    lsSet(K.visite, aujourdhui());
    if (API) rafraichir().then(function () { if (nbPending()) flush(); });
    else majBandeau();
  }).catch(function (err) {
    $('vue-aujourdhui').innerHTML = '<div class="bandeau stop"><span><b>Impossible de charger les offres.</b> '
      + esc(err.message) + '. Verifie que data/offres.json est publie.</span></div>';
  });
}
demarrer();
})();
