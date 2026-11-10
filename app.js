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
// 09/11 (audit) : la cle de l API ne vit plus dans le depot public. Avec CFG.cle : lien #cle=...&moi=... ou saisie, une fois par navigateur.
function lireCle() {
  var c = /[#&]cle=([^&]+)/.exec(location.hash), m = /[#&]moi=([^&]+)/.exec(location.hash);
  try {
    if (c) localStorage.setItem('ck-cle', decodeURIComponent(c[1]));
    if (m) localStorage.setItem('ck-moi', JSON.stringify(decodeURIComponent(m[1])));
    if (c || m) history.replaceState(null, '', location.pathname + location.search);
    return localStorage.getItem('ck-cle') || '';
  } catch (e) { return ''; }
}
var TOKEN = CFG.cle ? lireCle() : (CFG.token || '');
var cleAbandonnee = false;
function demanderCle() {
  if (cleAbandonnee) return false;
  var c = window.prompt('Code d acces du cockpit');
  if (!c || !c.trim()) { cleAbandonnee = true; return false; }
  TOKEN = c.trim();
  try { localStorage.setItem('ck-cle', TOKEN); } catch (e) {}
  return true;
}

var STATUTS = ['A traiter', 'Interessant', 'Postule', 'Relance', 'Entretien', 'Refus', 'Ecarte', 'Lien mort'];
var STATUTS_TACHE = ['a faire', 'en cours', 'fait', 'annule'];
var COLONNES = [
  { cle: 'tri',         nom: 'A trier',     statuts: ['A traiter'] },
  { cle: 'interessant', nom: 'Interessant', statuts: ['Interessant'] },
  { cle: 'postule',     nom: 'Postule',     statuts: ['Postule', 'Relance'] },
  { cle: 'entretien',   nom: 'Entretien',   statuts: ['Entretien'] },
  { cle: 'fini',        nom: 'Termine',     statuts: ['Refus', 'Ecarte', 'Lien mort'] },
];
var LIB_CAT = { moteur: 'Candidatures : Claude prepare et depose. Cocher = il agit, annoter = il lit avant',
  linkedin: 'LinkedIn : cocher = envoyer, annoter = Claude relit avant',
  admin: 'Administratif', diplome: 'Diplome ICN', reseau: 'Reseau',
  documents: 'Documents', sante: 'Sante', logement: 'Logement', divers: 'Divers' };
var LIB_EXIG = { ans: 'Experience', langue: 'Langues', diplome: 'Diplome' };
// L arbre (08/11, Anne : « tout ce que je touche sur le cockpit doit declencher quelque chose ») : ce que chaque etape
// declenche pour une offre d Anne, affiche sous le selecteur d etape. Les branches vivent dans moteur.py (a_traiter) et PROMPT_MOTEUR.md.
var ET_ENSUITE = {
  'A traiter': 'rien ne part tant que tu n as pas choisi. Une note ici est lue par Claude au prochain passage.',
  'Interessant': 'Claude lit l annonce et prepare le dossier (CV adapte, lettre, reco), puis pose « Dossier pret : cocher = envoie » dans Taches, ou depose directement s il est sur.',
  'Postule': 'relance proposee automatiquement 7 jours plus tard, tache « Relance prete : cocher = envoyer » dans Taches.',
  'Relance': 'relance partie. Rien d automatique de plus ; une note ici est lue par Claude au prochain passage.',
  'Entretien': 'Claude prepare l entretien : fichier _ENTRETIEN.md dans le dossier et tache « Prepa entretien » dans Taches.',
  'Refus': 'rien de plus. Une note ici est lue par Claude au prochain passage.',
  'Ecarte': 'ecris le motif dans la note, il y reste. Rien d autre ne part.',
  'Lien mort': 'rien de plus.',
};
var TEINTES = ['#C2540A', '#0B7285', '#3A5BC7', '#15803D', '#8E44AD', '#B0306A'];
var HUBS_CIBLES = ['munich', 'francfort', 'berlin', 'hamburg'];

var K = { ui: 'ck-ui-v3', moi: 'ck-moi', theme: 'ck-theme', pending: 'ck-pending-v1',
  cache: 'ck-sheet-v1', visite: 'ck-visite' };

// ------------------------------------------------------------------ etat
var DATA = { offres: [], tachesSeed: [], seed: { offres: {}, taches: {}, tachesSupprimees: [] }, meta: {}, prives: {} };
var SHEET = { statuts: {}, taches: {}, t: '' };
var PENDING = { statuts: {}, taches: {} };
var OFFRES = [], TACHES = [];
var MOI = '';
var vue = 'aujourdhui';
var filtres = { q: '', qui: 'tous', hub: 'tous', contrat: 'tous', tuile: null, col: 'tri' };
var ouverte = null, triId = null, triPassees = {}, selection = {};
var sync = API ? 'chargement' : 'local';
var flushTimer = null, enVol = false, chargeOK = false, derniereFeuille = '';

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
// La feuille renvoie parfois une date au format long JS (« Wed Nov 04 2026 00:00:00 GMT+0100 (...) ») : on la ramene a yyyy-mm-dd.
function normDate(d) {
  d = d == null ? '' : String(d);
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  var t = Date.parse(d.replace(/\s*\(.*\)$/, ''));
  if (isNaN(t)) return d;
  var x = new Date(t);
  return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2);
}
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
function horodatage() {
  var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// Texte echappe, URL cliquables. La ponctuation qui suit un lien n en fait pas partie.
function lienifier(s) {
  return esc(s).replace(/https?:\/\/\S+/g, function (u) {
    var fin = (u.match(/[.,;:!?)]+$/) || [''])[0];
    u = u.slice(0, u.length - fin.length);
    return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>' + fin;
  });
}

// ------------------------------------------------- annotations dans les notes
// Convention (05/11), lue aussi par moteur.py et par Claude : la colonne notes commence par le
// texte du moteur, puis des blocs, chacun sur une nouvelle ligne :
//   @Anne 2026-11-05 12:10 : ce qu Anne demande
//   @Claude 2026-11-05 15:02 : ce que Claude repond
// Une annotation est non lue tant que le dernier bloc est un @Anne.
var RE_BLOC = /(?:^|\n)@(Anne|Claude) (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) : /;
// annoter_cockpit.py colle ses blocs apres « | » sur la meme ligne (notes d offres) : on les ramene sur une nouvelle ligne.
function decouperNotes(notes) {
  var p = String(notes == null ? '' : notes).replace(/\r\n/g, '\n')
    .replace(/[ \t]*\|[ \t]*(?=@(?:Anne|Claude) \d{4}-\d{2}-\d{2} \d{2}:\d{2} : )/g, '\n').split(RE_BLOC);
  var r = { moteur: p[0].replace(/\s+$/, ''), blocs: [] };
  for (var i = 1; i < p.length; i += 3) r.blocs.push({ qui: p[i], date: p[i + 1], texte: (p[i + 2] || '').replace(/\s+$/, '') });
  return r;
}
function assemblerNotes(d) {
  var s = d.moteur || '';
  (d.blocs || []).forEach(function (b) { s += (s ? '\n' : '') + '@' + b.qui + ' ' + b.date + ' : ' + b.texte; });
  return s;
}
// Tache posee par le moteur ou par Claude : par, ou un identifiant hors t- (creerTache et
// taches_seed donnent t-), ou deja un bloc @. Une coche d Anne remplace par, pas l identifiant.
function tacheClaude(t) {
  return t.par === 'moteur' || t.par === 'claude' || !/^t-/.test(t.id || '') || RE_BLOC.test(t.notes || '');
}
// Fil d annotations (taches de Claude, offres d Anne depuis le 08/11) : texte du moteur en lecture seule, blocs @Anne et
// @Claude, puis le champ d Anne qui ne contient que son dernier bloc non lu. Rend { html, chip }.
function filNotes(notes, classe, id, placeholder) {
  var d = decouperNotes(notes), nb = d.blocs.length, dernier = nb ? d.blocs[nb - 1] : null;
  var nonLue = !!dernier && dernier.qui === 'Anne';
  var html = d.moteur ? '<div class="t-claude">' + lienifier(d.moteur).replace(/CANDIDATURES\/\S+/g, '<span class="mono">$&</span>') + '</div>' : '';
  d.blocs.forEach(function (b, i) {
    if (nonLue && i === nb - 1) return; // le bloc non lu est dans le champ de reponse
    html += '<div class="t-claude ' + (b.qui === 'Anne' ? 't-bloc-anne' : 't-bloc-claude') + '"><b>' + b.qui + ', ' + esc(b.date) + ' :</b> ' + lienifier(b.texte) + '</div>';
  });
  html += '<textarea class="' + classe + '" data-id="' + esc(id) + '" placeholder="' + placeholder + '">' + esc(nonLue ? dernier.texte : '') + '</textarea>';
  var chip = !dernier ? '' : nonLue ? '<span class="chip relance">annotation a lire par Claude</span>'
    : '<span class="chip ok">lue par Claude le ' + esc(dernier.date) + '</span>';
  return { html: html, chip: chip };
}
function autoTestNotes() {
  try {
    var x = decouperNotes('');
    console.assert(x.moteur === '' && x.blocs.length === 0 && assemblerNotes(x) === '', 'notes : vide');
    x = decouperNotes('Cocher = envoyer. https://a.b/c ');
    console.assert(x.moteur === 'Cocher = envoyer. https://a.b/c' && x.blocs.length === 0 && assemblerNotes(x) === x.moteur, 'notes : moteur seul');
    var n = 'V.I.E. probable | 4/5\n@Anne 2026-11-05 12:10 : sans note\n@Claude 2026-11-05 15:02 : fait, envoyee\n@Anne 2026-11-05 16:00 : merci,\nrelance J+7';
    x = decouperNotes(n);
    console.assert(x.moteur === 'V.I.E. probable | 4/5' && x.blocs.length === 3 && x.blocs[0].qui === 'Anne'
      && x.blocs[1].qui === 'Claude' && x.blocs[1].date === '2026-11-05 15:02' && x.blocs[2].texte === 'merci,\nrelance J+7'
      && assemblerNotes(x) === n, 'notes : moteur + Anne + Claude + Anne');
    x = decouperNotes('- 10 ans. | @Claude 2026-11-06 15:02 : Lu, ecartee');
    console.assert(x.moteur === '- 10 ans.' && x.blocs.length === 1 && x.blocs[0].qui === 'Claude' && x.blocs[0].texte === 'Lu, ecartee', 'notes : bloc colle apres |');
    console.assert(/^V\.I\.E\. \| 4\/5\n@Anne \d{4}-\d{2}-\d{2} \d{2}:\d{2} : ok$/.test(blocAnne('V.I.E. | 4/5', 'ok'))
      && /^x\n@Anne \S+ \S+ : b$/.test(blocAnne('x\n@Anne 2026-11-05 12:10 : a', 'b'))
      && blocAnne('x\n@Anne 2026-11-05 12:10 : a', '') === 'x' && blocAnne('x', ' ') === null, 'notes : bloc Anne');
  } catch (e) { console.warn('auto-test notes', e); }
}

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
    var m = Object.assign({}, o, DATA.prives[o.id]);  // 09/11 (audit) : contacts et dossiers viennent de la feuille, plus du fichier public
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
    var manuel = d.source === 'ajout manuel';
    OFFRES.push({ id: id, qui: d.qui || 'Anne', entreprise: d.entreprise || '', poste: d.poste || '',
      url: d.url || '', ville: d.ville || '', hub: d.hub || '', contratType: d.contratType || '',
      source: d.source || '', sources: d.source ? [d.source] : [], score: manuel ? 100 : 0,
      statut: d.statut, note: d.note || '', par: d.par || '', maj: d.maj || '',
      disparue: !manuel, manuel: manuel });
  });
  // 09/11 (audit) : une meme annonce vue sur deux sites, jugee sur l un, sort de la file de l autre (HelloFresh : Ecarte sur XING, a trier sur LinkedIn).
  var cleJumelle = function (o) { return [o.qui, (o.entreprise || '').toLowerCase().split(/\s+/)[0], (o.poste || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 40)].join('|'); };
  var jugees = {};
  OFFRES.forEach(function (o) { if (o.statut !== 'A traiter') jugees[cleJumelle(o)] = 1; });
  OFFRES.forEach(function (o) { o.jumelleJugee = o.statut === 'A traiter' && !!jugees[cleJumelle(o)]; });
  // VIE et CDD d abord, les CDI "VIE proposable" ensuite (27/10) : sans cela
  // le VIE TRANSDEV tombait 9e derriere huit CDI de meme bassin.
  OFFRES.sort(function (a, b) {
    return prioriteTri(b) - prioriteTri(a) || (a.entreprise || '').localeCompare(b.entreprise || '');
  });

  var base = {};
  DATA.tachesSeed.forEach(function (t) { base[t.id] = Object.assign({}, t); });
  Object.keys(DATA.seed.taches).forEach(function (id) { base[id] = Object.assign(base[id] || {}, DATA.seed.taches[id]); });
  [SHEET.taches, PENDING.taches].forEach(function (src) {
    Object.keys(src).forEach(function (id) { base[id] = Object.assign(base[id] || {}, src[id]); });
  });
  var suppr = {};
  (DATA.seed.tachesSupprimees || []).forEach(function (id) { suppr[id] = 1; });
  TACHES = Object.keys(base).map(function (id) { var t = base[id]; t.date = normDate(t.date); t.maj = normDate(t.maj); return t; }).filter(function (t) {
    return t.id && t.texte && !suppr[t.id] && String(t.supprimee || '') !== '1';
  });
  if (MOI === 'Joffrey') TACHES = TACHES.filter(function (t) { return t.par === 'Joffrey'; });  // 09/11 (audit) : les taches sont celles d Anne
}

function trouver(id) {
  for (var i = 0; i < OFFRES.length; i++) if (OFFRES[i].id === id) return OFFRES[i];
  return null;
}

// -------------------------------------------------------------- decisions
// 09/11 (audit) : version de la feuille dont part une saisie. Si la ligne a bouge depuis, Apps Script fusionne les notes au lieu d ecraser.
function baseDe(k, id) { var p = PENDING[k][id], s = SHEET[k][id]; return p ? (p.base || '') : ((s && s.ts) || ''); }
function ligneStatut(o, patch) {
  var d = decisionDe(o.id) || {};
  return {
    id: o.id, base: baseDe('statuts', o.id),
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
  return { id: r.id, base: baseDe('taches', r.id), cat: r.cat || 'divers', texte: r.texte || '', date: r.date || '',
    statut: r.statut || 'a faire', notes: r.notes || '', par: r.par, maj: r.maj, ts: r.ts,
    supprimee: r.supprimee ? '1' : '' };
}
function tacheParId(id) {
  for (var i = 0; i < TACHES.length; i++) if (TACHES[i].id === id) return TACHES[i];
  return null;
}
function deciderTache(id, patch, silencieux) {
  var t = tacheParId(id);
  if (!t) return;
  PENDING.taches[id] = ligneTache(t, patch);
  lsSet(K.pending, PENDING);
  fusionner(); planifierFlush();
  if (!silencieux) rendre();
}
// Reponse d Anne pour Claude : le dernier bloc @Anne est remplace tant que Claude ne l a pas lu,
// sinon un nouveau bloc est ajoute. Champ vide = le bloc non lu est retire.
// Rend les notes recomposees, ou null si rien ne change.
function blocAnne(notes, texte) {
  var d = decouperNotes(notes), dernier = d.blocs[d.blocs.length - 1];
  var vide = /^\s*$/.test(texte);
  if (dernier && dernier.qui === 'Anne') {
    if (vide) d.blocs.pop();
    else { dernier.texte = texte; dernier.date = horodatage(); }
  } else if (!vide) {
    d.blocs.push({ qui: 'Anne', date: horodatage(), texte: texte });
  } else return null;
  return assemblerNotes(d);
}
function annoterTache(id, texte, silencieux) {
  var t = tacheParId(id);
  if (!t) return;
  var n = blocAnne(t.notes, texte);
  if (n !== null) deciderTache(id, { notes: n }, silencieux);
}
// Meme fil sur la note d une offre d Anne (08/11) : le moteur la transmet a Claude tant que la derniere main est la sienne,
// Claude repond par un bloc @Claude (annoter_cockpit.py).
function annoterOffre(id, texte, silencieux) {
  var o = trouver(id);
  if (!o) return;
  var n = blocAnne(o.note, texte);
  if (n !== null) decider(id, { note: n }, silencieux);
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
function flush(essai) {
  if (!API || enVol) return;
  essai = essai || 0;
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
        else if (cur) cur.base = it.data.ts;  // saisie faite pendant l envoi : elle part de ce qui vient d etre ecrit
        cible[it.data.id] = it.data;
      });
      lsSet(K.pending, PENDING); lsSet(K.cache, SHEET);
      enVol = false; sync = 'ok';
      fusionner(); rendre();
      if (nbPending()) planifierFlush();
    })
    .catch(function () {
      enVol = false;
      if (essai < 2) { setTimeout(function () { flush(essai + 1); }, 3000); return; }
      sync = 'erreur'; majBandeau();
    });
}
function rafraichir(essai) {
  if (!API) return Promise.resolve();
  essai = essai || 0;
  var url = API + (API.indexOf('?') > -1 ? '&' : '?') + 'k=' + encodeURIComponent(TOKEN) + '&t=' + Date.now();
  return fetch(url).then(function (r) { return r.json(); }).then(function (res) {
    if (res && res.erreur === 'cle') {
      if (demanderCle()) return rafraichir();
      sync = 'cle'; majBandeau(); return;
    }
    if (!res || !res.ok) throw new Error('refus');
    var empreinte = JSON.stringify([res.statuts, res.taches, res.blocs]), change = empreinte !== derniereFeuille;
    derniereFeuille = empreinte;
    (res.blocs || []).forEach(function (b) {
      if (['journal', 'linkedin', 'prives'].indexOf(b.id) === -1) return;
      try { DATA[b.id] = JSON.parse(b.valeur); } catch (e) {}
    });
    var s = {}, t = {};
    (res.statuts || []).forEach(function (r) { if (r.id) s[r.id] = r; });
    (res.taches || []).forEach(function (r) { if (r.id) t[r.id] = r; });
    SHEET = { statuts: s, taches: t, t: res.t || '' };
    ['statuts', 'taches'].forEach(function (k) {
      Object.keys(PENDING[k]).forEach(function (id) {
        var sh = SHEET[k][id], pe = PENDING[k][id];
        // 09/11 (audit) : une saisie non envoyee ne se perd plus quand la ligne a bouge, elle part et Apps Script fusionne les notes.
        if (!CFG.cle && sh && sh.ts && pe.ts && sh.ts > pe.ts) delete PENDING[k][id];
      });
    });
    lsSet(K.cache, SHEET); lsSet(K.pending, PENDING);
    if (sync !== 'envoi') sync = nbPending() ? 'attente' : 'ok';
    // 09/11 (audit) : feuille inchangee = aucun rendu, les blocs deplies restent ouverts.
    if (change) { fusionner(); rendre(); } else majBandeau();
    if (nbPending()) planifierFlush();
  }).catch(function () {
    // Apps Script repond parfois 404 au premier appel apres une pause,
    // puis normalement. On reessaie avant d afficher une erreur.
    if (essai < 2) {
      return new Promise(function (r) { setTimeout(r, 3000); }).then(function () { return rafraichir(essai + 1); });
    }
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
  } else if (sync === 'cle') {
    cls = 'warn';
    html = '<span><b>Code d acces manquant.</b> Tes statuts et tes taches ne s affichent pas sans lui.</span>'
      + '<button class="btn" onclick="location.reload()">Saisir le code</button>';
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
  return j !== null && j >= 7;  // 09/11 (audit) : meme regle que la branche relance du moteur
}
function expireBientot(o) {
  if (['Refus', 'Ecarte', 'Lien mort'].indexOf(o.statut) !== -1) return false;
  var j = joursAvant(o.expire);
  return j !== null && j >= 0 && j <= 7;
}
function aTrier(o) { return o.statut === 'A traiter' && !o.jumelleJugee; }
function colonneDe(o) {
  for (var i = 0; i < COLONNES.length; i++) if (COLONNES[i].statuts.indexOf(o.statut) !== -1) return COLONNES[i].cle;
  return 'tri';
}
function passeQui(o) { return filtres.qui === 'tous' || o.qui === filtres.qui; }
function passe(o) {
  if (!passeQui(o)) return false;
  if (filtres.hub !== 'tous' && (o.hub || '').toLowerCase().indexOf(filtres.hub.toLowerCase()) === -1) return false;
  if (filtres.contrat !== 'tous') {
    if (filtres.contrat === 'VIE proposable') { if (!o.vieProposable) return false; }
    else if (o.vieProposable) return false;
    else if ((o.contratType || 'CDI') !== filtres.contrat) return false;
  }
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
  // 09/11 (audit) : pour Anne, le V.I.E. d abord (regle du 04/11), puis la correspondance sur 5, puis un V.I.E. possible. L ancien malus
  // touchait les CDI ou un V.I.E. est possible : 40 CDI sans V.I.E. passaient devant. Rien n est masque. Joffrey cherche un CDI : score seul.
  if (o.qui === 'Anne') {
    if (o.contratType === 'VIE') u += 1000;
    u += (o.fit || 0) * 100;
    if (o.vie && (o.vie.v === 'oui' || o.vie.v === 'probable')) u += 30;
  }
  return (o.score || 0) + u;
}
function fileTri() {
  return OFFRES.filter(function (o) {
    return aTrier(o) && !o.disparue && o.etatLien !== 'morte' && passeQui(o);  // 09/11 (audit) : un filtre reste dans Offres vidait Trier
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
  // Verdicts du moteur (moteur.py, 04/11) : V.I.E. verifie par SIREN, correspondance sur 5, chemin chaud, dossier.
  if (ct !== 'VIE' && o.vie) {
    var lv = { oui: 'V.I.E. possible', probable: 'V.I.E. probable', non: ct + ', pas de V.I.E.', '?': 'V.I.E. a verifier' }[o.vie.v] || ct;
    c += '<span class="chip contrat ' + (o.vie.v === 'oui' || o.vie.v === 'probable' ? 'c-vie-proposable' : 'c-' + esc(ct.toLowerCase())) + '" title="' + esc(o.vie.r) + '">' + esc(lv) + '</span>';
  } else if (o.vieProposable) {
    c += '<span class="chip contrat c-vie-proposable" title="CDI : proposer un VIE ou CDD dans la LM">VIE proposable</span>';
  } else {
    c += '<span class="chip contrat c-' + esc(ct.toLowerCase()) + '">' + esc(ct) + '</span>';
  }
  if (o.hub) c += '<span class="chip hub">' + esc(o.hub) + '</span>';
  if (o.fit != null) c += '<span class="chip ' + (o.fit >= 4 ? 'ok' : (o.fit === 3 ? 'relance' : '')) + '" title="' + esc(o.fitD || '') + '">' + o.fit + '/5</span>';
  if (o.chaud) c += '<span class="chip signal" title="La personne que tu connais dans l entreprise">' + esc(o.chaud) + '</span>';
  if (o.dossier) c += '<span class="chip ok" title="' + esc(o.dossier) + '">dossier pret</span>';
  var jv = joursDepuis(o.vuLe);
  if (o.nouveau || (jv !== null && jv < 2)) c += '<span class="chip neuf"' + (o.vuLe ? ' title="premiere vue le ' + esc(o.vuLe) + '"' : '') + '>nouveau</span>';
  var je = joursAvant(o.expire);
  if (je !== null && je >= 0 && je <= 14) c += '<span class="chip ' + (je <= 7 ? 'urgent' : 'relance') + '">expire J-' + je + '</span>';
  if (aRelancer(o)) c += '<span class="chip relance">a relancer, J+' + joursDepuis(o.maj) + '</span>';
  if (o.etatLien === 'morte') c += '<span class="chip urgent" title="' + esc(o.motifLien || '') + '">offre fermee</span>';
  else if (o.etatLien === 'incertain') c += '<span class="chip relance" title="' + esc(o.motifLien || '') + '">a verifier</span>';
  else if (o.etatLien === 'vivante') c += '<span class="chip ok" title="verifie le ' + esc(o.verifieLe || '') + '">en ligne</span>';
  if (o.langue === 'de' || o.langue === 'de-mais-en') c += '<span class="chip de">annonce en allemand</span>';
  if (o.disparue) c += '<span class="chip">annonce retiree</span>';
  if (o.manuel) c += '<span class="chip ok" title="Piste entree a la main, hors scanner">ajoutee a la main</span>';
  if (o.adjacent) c += '<span class="chip relance" title="Titre hors achats purs : supply chain, contrats, projet, qualite, methodes, produit.">achats elargi</span>';
  if (o.corpsNonLu) c += '<span class="chip relance" title="Le scanner n a pas pu lire la description. A lire en entier avant de postuler.">annonce non lue</span>';
  if (o.diffusionLarge) c += '<span class="chip signal" title="' + esc((o.sources || []).join(', ')) + '. Le besoin est reel et il presse.">diffusee sur ' + o.sources.length + ' plateformes</span>';
  else if (o.republiee > 1) c += '<span class="chip signal" title="Relancee faute de candidats, ou plusieurs postes.">republiee ' + o.republiee + ' fois</span>';
  if (o.sources && o.sources.length) c += '<span class="chip" title="' + esc(o.sources.join(', ')) + '">' + esc(o.sources[0]) + (o.sources.length > 1 ? ' +' + (o.sources.length - 1) : '') + '</span>';
  else if (o.source) c += '<span class="chip">' + esc(o.source) + '</span>';
  if (o.remuneration) c += '<span class="chip mono">' + esc(o.remuneration) + '</span>';
  if (!o.disparue) {
    // 09/11 (audit) : la correspondance sur 5 d Anne decide, le score seul disait « tres pertinent » pour un 0 sur 5.
    var s = o.score || 0, niv = o.fit != null ? (o.fit >= 4 ? 'fort' : (o.fit === 3 ? 'bon' : 'ok')) : (s >= 105 ? 'fort' : (s >= 85 ? 'bon' : 'ok'));
    c += '<span class="chip pertinence ' + niv + '" title="' + (o.fit != null ? 'correspondance ' + o.fit + ' sur 5, ' : '') + 'pertinence ' + s + '">'
      + (niv === 'fort' ? 'tres pertinent' : (niv === 'bon' ? 'pertinent' : 'a voir')) + '</span>';
  }
  return c;
}

// ------------------------------------------------------------------ carte
function carte(o, sansPick) {
  var est = ouverte === o.id;
  var mg = monogramme(o.entreprise || o.poste);
  // Offre d Anne (08/11) : la note est un fil, comme les taches de Claude. Joffrey garde la note pleine, il colle des notes entieres.
  var fil = o.qui === 'Anne' ? filNotes(o.note, 'f-rep', o.id, 'Ta note ou consigne pour Claude : il la lit au prochain passage et repond ici.') : null;
  var html = '<article class="card' + (est ? ' open' : '') + (o.disparue ? ' disparue' : '') + '" data-id="' + esc(o.id) + '" tabindex="0">'
    + '<div class="card-top"><div class="mono-av" style="background:' + mg.col + '">' + esc(mg.txt) + '</div>'
    + '<div class="card-txt"><div class="ent"><span>' + esc(o.entreprise || 'Entreprise inconnue') + '</span>'
    + (filtres.qui === 'tous' ? '<span class="' + (o.qui === 'Anne' ? 'qui-a' : 'qui-j') + '">' + esc(o.qui) + '</span>' : '')
    + '</div><h4>' + esc(o.poste) + '</h4></div>'
    + (sansPick ? '' : '<label class="pick" title="selectionner pour un traitement en lot"><input type="checkbox" class="o-pick" data-id="' + esc(o.id) + '"' + (selection[o.id] ? ' checked' : '') + '></label>')
    + '</div><div class="chips">' + chipsDe(o) + (fil ? fil.chip : '') + '</div>';
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
      + (o.qui === 'Anne' ? '<div class="ensuite"><b>Et ensuite :</b> ' + (ET_ENSUITE[o.statut] || ET_ENSUITE['A traiter']) + '</div>' : '')
      + exig
      + (o.vie ? '<div class="moteur" style="font-size:12.5px;line-height:1.55;margin:8px 0;padding:8px 10px;border-radius:8px;background:rgba(127,127,127,.10)">'
        + '<div><b>V.I.E. :</b> ' + esc(o.vie.r) + '</div>'
        + '<div><b>' + o.fit + '/5 :</b> ' + esc(o.fitD || '') + '</div>'
        + (o.chaud ? '<div><b>Chemin chaud :</b> ' + esc(o.chaud) + '</div>' : '')
        + (o.dossier ? '<div><b>Dossier :</b> CANDIDATURES/' + esc(o.dossier) + '</div>' : '')
        + '</div>' : '')
      + (o.extrait ? '<p class="extrait">' + esc(o.extrait) + '</p>' : '')
      + (fil ? '<div class="fil">' + fil.html + '</div>'
        : '<textarea class="f-note" data-id="' + esc(o.id) + '" placeholder="Contact, date de relance, retour d entretien, ce que l autre doit savoir...">' + esc(o.note || '') + '</textarea>')
      + '<div class="rangee">'
      + (o.url ? '<a class="lien" href="' + esc(o.url) + '" target="_blank" rel="noopener">Ouvrir l annonce</a>' : '')
      + '<a class="lien reseau" href="' + esc(lienReseau(o.entreprise || '')) + '" target="_blank" rel="noopener" title="Relations LinkedIn de 1er et 2e degre chez cet employeur">Qui je connais ici</a>'
      + '</div><div class="sig">' + esc(o.ville || '') + (dateLisible(o.date) ? ' &middot; publiee le ' + dateLisible(o.date) : '')
      + (o.ref ? ' &middot; ' + esc(o.ref) : '') + (o.maj ? ' &middot; modifie par ' + esc(o.par || '?') + ' le ' + esc(normDate(o.maj)) : '')
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
  var corps;
  if (tacheClaude(t)) {
    // Texte du moteur en lecture seule, fil des blocs, puis le champ de reponse pour Claude.
    var fil = filNotes(t.notes, 't-rep', t.id, 'Ta reponse pour Claude : modification, question, consigne. Il la lit avant d agir.');
    chips += fil.chip;
    corps = fil.html + '<div class="t-aide">Cocher = Claude agit au prochain passage (chaque heure, 8h-19h). Ecris ici d abord s il y a quelque chose a changer.</div>';
  } else {
    corps = '<textarea class="t-note" data-id="' + esc(t.id) + '" placeholder="note, avancement, ce que l autre doit savoir...">' + esc(t.notes || '') + '</textarea>';
  }
  return '<article class="tache' + (fini ? ' done' : '') + '">'
    + '<label class="coche"><input type="checkbox" class="t-fait" data-id="' + esc(t.id) + '"' + (t.statut === 'fait' ? ' checked' : '') + '></label>'
    + '<div class="t-corps"><div class="t-titre">' + esc(t.texte) + '</div><div class="chips">' + chips + '</div>'
    + corps
    + '<div class="t-pied"><select class="t-statut" data-id="' + esc(t.id) + '">' + opts + '</select>'
    + '<input type="date" class="t-date" data-id="' + esc(t.id) + '" value="' + esc(t.date || '') + '">'
    + '<button class="t-suppr" data-id="' + esc(t.id) + '">supprimer</button>'
    + (t.maj ? '<span class="sig">' + esc(t.par || '') + ' &middot; ' + esc(t.maj) + '</span>' : '')
    + '</div></div></article>';
}

// Rien n est supprime (l historique reste dans la feuille Google), mais une tache finie quitte la vue : les 3 derniers
// jours restent depliables sous la categorie, le reste est archive derriere un seul bouton (06/11, Anne : « une fois que
// tout est coche, on supprime rien ? ca fait beaucoup de taches »).
var archivesOuvertes = false;
function rendreTaches() {
  var zone = $('vue-taches');
  var groupes = {};
  TACHES.forEach(function (t) { (groupes[t.cat] = groupes[t.cat] || []).push(t); });
  // L arbre, cote taches (08/11) : ce que cocher, annoter et « + tache » declenchent. Lu par le moteur seulement si la tache est d Anne.
  var html = MOI === 'Anne' ? '<p class="t-intro">Cocher = Claude agit au prochain passage (chaque heure, 8h-19h). Annoter = il lit avant d agir et repond dans la tache. '
    + '+ tache = il lit ta tache et agit si c est pour lui (postuler, relancer, ecrire, modifier le CV) ; une tache personnelle reste a toi.</p>' : '';
  var archives = [];
  var recent = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  Object.keys(LIB_CAT).forEach(function (cat) {
    var lot = (groupes[cat] || []).slice().sort(function (a, b) {
      var cle = function (t) { return t.id === 'plan-linkedin' ? '0000' : (t.date || '9999'); };  // 10/11 : le plan LinkedIn en tete de son groupe
      return cle(a).localeCompare(cle(b));
    });
    var actives = lot.filter(tacheActive);
    var finies = lot.filter(function (t) { return !tacheActive(t); })
      .sort(function (a, b) { return (b.maj || '').localeCompare(a.maj || ''); });
    var recentes = finies.filter(function (t) { return (t.maj || '') >= recent; });
    archives = archives.concat(finies.filter(function (t) { return (t.maj || '') < recent; }));
    html += '<section class="grp"><div class="grp-head"><span class="grp-nom">' + esc(LIB_CAT[cat]) + '</span>'
      + '<span class="grp-n">' + actives.length + ' a faire' + (finies.length ? ', ' + finies.length + ' finie' + (finies.length > 1 ? 's' : '') : '') + '</span>'
      + '<button class="btn mini t-ajout" data-cat="' + cat + '">+ tache</button></div>'
      + '<form class="t-form" data-cat="' + cat + '" hidden><input type="text" name="texte" placeholder="Nouvelle tache" required>'
      + '<input type="date" name="date"><button class="btn plein" type="submit">Ajouter</button></form>'
      + (actives.length ? actives.map(carteTache).join('') : '<div class="vide">Rien a faire dans cette categorie.</div>')
      + (recentes.length ? '<details class="t-finies"><summary>' + recentes.length + ' finie' + (recentes.length > 1 ? 's' : '') + ' ces 3 derniers jours</summary>'
        + recentes.map(carteTache).join('') + '</details>' : '')
      + '</section>';
  });
  if (archives.length) {
    archives.sort(function (a, b) { return (b.maj || '').localeCompare(a.maj || ''); });
    html += '<section class="grp"><div class="grp-head"><span class="grp-nom">Archives</span>'
      + '<span class="grp-n">' + archives.length + ' tache' + (archives.length > 1 ? 's' : '') + ' finie' + (archives.length > 1 ? 's' : '') + ' il y a plus de 3 jours, rien n est supprime</span>'
      + '<button class="btn mini" id="t-archives">' + (archivesOuvertes ? 'masquer' : 'voir') + '</button></div>'
      + (archivesOuvertes ? archives.map(carteTache).join('') : '') + '</section>';
  }
  zone.innerHTML = html;
}

// ------------------------------------------------------------- aujourd hui
// Fil d'activite (06/11, journal.py) : ce que le moteur, le passage Claude, le scan et Telegram ont fait, 48 h glissantes.
var LIB_QUI = { moteur: 'moteur', claude: 'Claude', scan: 'scan', telegram: 'Telegram', linkedin: 'LinkedIn' };
// LinkedIn, ce qu Anne recoit chaque jour, lu pour elle (09/11, scanner/lire_signaux_linkedin.js) : notifications utiles,
// qui a consulte son profil, offres V.I.E. en Allemagne. Les offres entrent dans Trier au scan qui suit la lecture.
function blocLinkedin() {
  var l = DATA.linkedin;
  if (!l || !l.genere) return '';
  var quand = new Date(l.genere), lu = isNaN(quand) ? '' : quand.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  var lib = { candidature_vue: 'Candidature consultee', vue_profil: 'Profil consulte', alerte: 'Alerte emploi', acceptation: 'Invitation acceptee' };
  var lignes = (l.notifications || []).map(function (n) {
    var det = n.type === 'candidature_vue' ? (n.entreprise || '') + ', ' + (n.poste || '')
      : n.type === 'vue_profil' ? (n.nom || (n.entreprise ? (n.poste || '') + ' chez ' + n.entreprise : 'un recruteur (nom reserve a Premium)'))
      : n.type === 'alerte' ? (n.mot || '') + ' : ' + (n.lieu || '') : (n.nom || n.texte || '');
    return '<div class="j-ligne"><span class="mono j-ts">' + esc(n.age || '') + '</span><span class="j-qui">' + esc(lib[n.type] || n.type) + '</span><span class="j-det">' + esc(det) + '</span></div>';
  }).join('');
  var vues = (l.vues_profil || []).filter(function (x) { return /travaille chez|recruteurs?$|Consult/.test(x); }).slice(0, 8);
  var vie = (l.vie || []).map(function (o) {
    var r = o.recruteur; // 09/11 : la ligne de reseau de la carte et la personne qui a publie l offre, si la fiche la montre
    return '<div class="j-ligne"><a href="' + esc(o.lien || '#') + '" target="_blank" rel="noopener" class="j-act">' + esc(o.titre || '') + '</a><span class="j-det">' + esc(o.entreprise || '') + ', ' + esc(o.ville || '') + '</span>'
      + (o.reseau ? '<span class="j-det">' + esc(o.reseau) + '</span>' : '')
      + (r && r.nom ? '<span class="j-det">Recruteur : <a href="' + esc(r.lien || '#') + '" target="_blank" rel="noopener">' + esc(r.nom) + '</a>' + (r.intitule ? ', ' + esc(r.intitule) : '') + '</span>' : '')
      + '</div>';
  }).join('');
  return '<section class="bloc bleu"><h3>LinkedIn, lu pour toi <span class="sous">notifications, vues du profil, alertes et recherche V.I.E. : lecture du ' + esc(lu) + '</span></h3>'
    + '<div class="journal">' + lignes + '</div>'
    + (vues.length ? '<p class="li-vues">Vues du profil (90 jours) : ' + esc(vues.join(' ; ')) + (l.recherches ? ' ; ' + esc(String(l.recherches)) + ' apparitions dans les recherches cette semaine' : '') + '</p>' : '')
    + '<p class="li-vues"><b>' + (l.nb_alertes || 0) + '</b> offres derriere tes alertes Achats et <b>' + (l.nb_vie || 0) + '</b> offres V.I.E. en Allemagne passent par les filtres du scan, celles qui restent arrivent dans Trier.</p>'
    + (vie ? '<details class="t-finies"><summary>Les ' + (l.vie || []).length + ' offres V.I.E. en Allemagne vues sur LinkedIn</summary><div class="journal">' + vie + '</div></details>' : '')
    + '</section>';
}
function blocJournal() {
  var j = (DATA.journal || []).slice().reverse();
  var limite = Date.now() - 48 * 3600000;
  j = j.filter(function (e) { return e && e.ts && new Date(String(e.ts).replace(' ', 'T')) >= limite; });
  var corps = j.length ? '<div class="journal">' + j.slice(0, 40).map(function (e) {
    return '<div class="j-ligne"><span class="mono j-ts">' + esc(String(e.ts).slice(5, 16).replace('T', ' ')) + '</span>'
      + '<span class="j-qui">' + esc(LIB_QUI[e.qui] || e.qui || '') + '</span>'
      + '<span class="j-act">' + esc(e.action || '') + '</span>'
      + (e.detail ? '<span class="j-det">' + esc(String(e.detail).slice(0, 140)) + '</span>' : '') + '</div>';
  }).join('') + '</div>' : '<div class="vide">Aucune action enregistree sur 48 h.</div>';
  return '<section class="bloc"><h3>Ce que le moteur a fait <span class="sous">48 dernieres heures, du plus recent au plus ancien</span></h3>' + corps + '</section>';
}
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
  html += blocLinkedin();
  html += blocJournal();
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
    + '<div class="tri-motif" id="tri-motif" hidden><label for="tri-note">Pourquoi tu l ecartes, en une ligne. Le motif reste dans la note de l offre.</label>'
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
    lot.sort(function (a, b) { return prioriteTri(b) - prioriteTri(a); });
    $('n-' + c.cle).textContent = lot.length;
    var col = document.querySelector('.col[data-col="' + c.cle + '"]');
    col.classList.toggle('active', filtres.col === c.cle);
    $('col-' + c.cle).innerHTML = lot.length ? lot.map(function (o) { return carte(o); }).join('')
      : '<div class="vide">' + (c.cle === 'tri' ? 'Rien a trier. Tout est classe.' : 'Aucune offre a cette etape.') + '</div>';
  });
}

function exporterCSV() {
  var vis = OFFRES.filter(passe);
  var cols = ['qui', 'statut', 'entreprise', 'poste', 'ville', 'hub', 'contratType', 'score', 'date', 'vuLe', 'expire', 'source', 'url', 'etatLien', 'langue', 'extrait', 'note', 'par', 'maj'];  // 09/11 (audit) : Joffrey trie cet export avec ChatGPT
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
function hubDe(ville) {
  var x = (ville || '').toLowerCase();
  if (/m[uü]nch|munich/.test(x)) return 'Munich';
  if (/frankfurt|francfort/.test(x)) return 'Francfort';
  if (/berlin/.test(x)) return 'Berlin';
  if (/hamburg|hambourg/.test(x)) return 'Hamburg';
  return ville || '';
}
function ajouterOffreManuelle(f) {
  var v = function (n) { var e = f.querySelector('[name=' + n + ']'); return e ? (e.value || '').trim() : ''; };
  if (!v('entreprise') || !v('poste')) return;
  var url = v('url');
  var id = url ? url.split('?')[0].replace(/\/$/, '') : ('manuel-' + Date.now().toString(36));
  PENDING.statuts[id] = {
    id: id, qui: v('qui') || MOI || 'Anne', statut: 'Interessant', note: '',
    par: MOI || '', maj: aujourdhui(), ts: maintenant(),
    entreprise: v('entreprise'), poste: v('poste'), url: url, ville: v('ville'),
    hub: hubDe(v('ville')), contratType: v('contrat'), source: 'ajout manuel',
  };
  lsSet(K.pending, PENDING);
  f.reset(); f.hidden = true;
  fusionner(); planifierFlush(); rendre();
  flash(v('entreprise') + ' ajoutee dans Interessant');
}
function refleterFiltres() {
  var q = $('q');
  if (q.value !== filtres.q) q.value = filtres.q || '';
  // VIE proposable visible uniquement pour Anne
  var vpBtn = document.querySelector('.seg[data-groupe="contrat"] button[data-val="VIE proposable"]');
  if (vpBtn) vpBtn.hidden = filtres.qui !== 'tous' && filtres.qui !== 'Anne';
  // CDI masque pour Anne (ses CDI sont tagges VIE proposable)
  var cdi = document.querySelector('.seg[data-groupe="contrat"] button[data-val="CDI"]');
  if (cdi) {
    cdi.hidden = filtres.qui === 'Anne';
    if (cdi.hidden && filtres.contrat === 'CDI') filtres.contrat = 'tous';
  }
  document.querySelectorAll('.seg[data-groupe] button').forEach(function (b) {
    var g = b.parentNode.dataset.groupe;
    b.setAttribute('aria-pressed', b.dataset.val === filtres[g] ? 'true' : 'false');
  });
}
// Anne ecrit (annotation de tache, note d offre, recherche) : aucune reconstruction de la page sous ses doigts.
// Le rafraichissement (flush, rafraichir, fraicheur) est garde en attente et joue quand elle quitte le champ (06/11 :
// « le curseur s enleve, je n ecris plus et la page bouge toute seule »).
var renduEnAttente = false;
function champActif() {
  var a = document.activeElement;
  // 09/11 (audit) : la recherche est hors de ce qui se redessine, elle ne bloque plus le rendu.
  return !!(a && a.closest && a.closest('.app') && a.id !== 'q' && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url)$/.test(a.type || 'text'))));
}
document.addEventListener('focusout', function () {
  if (!renduEnAttente) return;
  setTimeout(function () { if (renduEnAttente && !champActif()) rendre(); }, 200);
});
function rendre() {
  if (!chargeOK) return;
  if (champActif()) { renduEnAttente = true; majBandeau(); return; }
  renduEnAttente = false;
  ['aujourdhui', 'trier', 'taches', 'offres', 'commandes'].forEach(function (v) { $('vue-' + v).hidden = v !== vue; });
  document.querySelectorAll('.nav button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.vue === vue ? 'true' : 'false'); });
  var nRetard = TACHES.filter(enRetard).length, nProche = TACHES.filter(bientot).length;
  var p = $('n-urgent');
  p.textContent = nRetard + nProche; p.hidden = !(nRetard + nProche); p.className = 'pastille' + (nRetard ? ' rouge' : '');
  $('n-taches').textContent = TACHES.filter(tacheActive).length;
  refleterFiltres();
  majScanMeta();
  rendreSources();
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
  if ((el = q('#seg-moi button'))) { appliquerMoi(el.dataset.moi === MOI ? '' : el.dataset.moi, true); fusionner(); rendre(); return; }
  if (t.id === 'btn-theme' || q('#btn-theme')) {
    var cur = document.documentElement.getAttribute('data-theme');
    var sys = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var actuel = cur || (sys ? 'dark' : 'light');
    appliquerTheme(actuel === 'dark' ? 'light' : 'dark');
    return;
  }
  if (t.id === 'btn-retry') { flush(); rafraichir(); return; }
  if (t.id === 'btn-csv') { exporterCSV(); return; }
  if (t.id === 'btn-ajout' || t.id === 'ajout-annuler') {
    var af = $('ajout-form');
    af.hidden = t.id === 'ajout-annuler' ? true : !af.hidden;
    if (!af.hidden) {
      var sq = af.querySelector('[name=qui]');
      if (sq && MOI) sq.value = MOI;
      af.querySelector('[name=entreprise]').focus();
    }
    return;
  }
  if ((el = q('.cmd-cell'))) {
    var code = el.querySelector('code');
    if (!code) return;
    var txt = code.textContent;
    var ok = function () { flash('Copie : ' + txt.slice(0, 60)); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(ok).catch(function () { window.getSelection().selectAllChildren(code); });
    else window.getSelection().selectAllChildren(code);
    return;
  }
  if (q('#t-archives')) { archivesOuvertes = !archivesOuvertes; rendreTaches(); return; }
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
  if (q('.detail') || q('.t-form') || q('.ajout-form')) return;
  if ((el = q('.card'))) { ouverte = ouverte === el.dataset.id ? null : el.dataset.id; rendre(); return; }
});

document.addEventListener('submit', function (e) {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();  // 09/11 (audit) : sinon le formulaire reste et une 2e Entree cree un doublon
  if (e.target.id === 'ajout-form') { e.preventDefault(); ajouterOffreManuelle(e.target); return; }
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
  if ((el = q('.t-rep'))) { annoterTache(el.dataset.id, el.value, true); return; }  // deja sauve a chaque frappe ; le rendu vient au focusout
  if ((el = q('textarea.f-rep'))) { annoterOffre(el.dataset.id, el.value, true); return; }
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
  var nr = t.closest && t.closest('textarea.f-rep');
  if (nr) { annoterOffre(nr.dataset.id, nr.value, true); return; }
  var tn = t.closest && t.closest('textarea.t-note');
  if (tn) { deciderTache(tn.dataset.id, { notes: tn.value }, true); return; }
  var tr = t.closest && t.closest('textarea.t-rep');
  if (tr) { annoterTache(tr.dataset.id, tr.value, true); }
});

document.addEventListener('keydown', function (e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('card')) {
    e.preventDefault(); ouverte = ouverte === e.target.dataset.id ? null : e.target.dataset.id; rendre(); return;
  }
  if (vue !== 'trier') return;
  var dansChamp = e.target && ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(e.target.tagName) !== -1;
  if (dansChamp) {
    if (e.target.id !== 'tri-note') return;
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); decisionTri('Ecarte'); }  // 09/11 (audit) : sans blur la carte ne changeait pas et chaque Entree ecartait l offre suivante
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
  if (document.visibilityState === 'visible') { rafraichir(); verifierFraicheur(); if (nbPending()) flush(); }
});
window.addEventListener('online', function () { if (nbPending()) flush(); });
setInterval(function () { if (document.visibilityState === 'visible') rafraichir(); }, 90000);
setInterval(function () { if (nbPending() && !enVol) flush(); }, 30000);
setInterval(verifierFraicheur, 300000);

// -------------------------------------------------------------- demarrage
function charger(url) {
  return fetch(url + '?v=' + Date.now()).then(function (r) { if (!r.ok) throw new Error(url); return r.json(); });
}
function chargerDonnees() {
  return Promise.all([
    charger(CFG.cle ? 'data/offres_pub.json' : 'data/offres.json'),
    charger('data/taches_seed.json').catch(function () { return []; }),
    charger('data/decisions_seed.json').catch(function () { return { offres: {}, taches: {}, tachesSupprimees: [] }; }),
    charger('data/meta.json').catch(function () { return {}; }),
    charger('data/sante.json').catch(function () { return null; }),
    charger('data/journal.json').catch(function () { return []; }),
    charger('data/linkedin.json').catch(function () { return null; }),
  ]).then(function (r) {
    DATA.offres = r[0]; DATA.tachesSeed = r[1]; DATA.seed = r[2]; DATA.meta = r[3]; DATA.sante = r[4];
    if (!CFG.cle) { DATA.journal = r[5] || []; DATA.linkedin = r[6]; }  // 09/11 (audit) : avec la cle, ces blocs viennent de la feuille
  });
}
// Liste des sources (05/11, Anne : « dresse la liste de tous les sites que tu scrappes pour la publier sur le cockpit »).
// Une ligne par source, une colonne par profil, depuis data/sante.json (sante_sources.py, a chaque scan complet).
var ORDRE_SOURCES = ['StepStone', 'XING', 'LinkedIn', 'Arbeitsagentur', 'EURES', 'englishjobs.de', 'HeyJobs', 'kimeta', 'Monster.de', 'Glassdoor',
  'Welcome to the Jungle', 'LinkedIn alertes Achats', 'LinkedIn V.I.E.', 'Business France (VIE)', 'Business France (veille)', 'Engagement Jeunes', 'Connexion-Emploi', 'CCFA Jobboerse',
  'Personio', 'ATS', 'Indeed.de'];
var URL_SOURCE = { 'StepStone': 'https://www.stepstone.de', 'XING': 'https://www.xing.com/jobs', 'LinkedIn': 'https://www.linkedin.com/jobs',
  'Arbeitsagentur': 'https://www.arbeitsagentur.de/jobsuche/', 'EURES': 'https://europa.eu/eures/portal/jv-se/home', 'englishjobs.de': 'https://www.englishjobs.de',
  'HeyJobs': 'https://www.heyjobs.co/de-de', 'kimeta': 'https://www.kimeta.de', 'Monster.de': 'https://www.monster.de', 'Glassdoor': 'https://www.glassdoor.de/Job/index.htm',
  'Welcome to the Jungle': 'https://www.welcometothejungle.com/fr/jobs?refinementList%5Boffices.country_code%5D%5B%5D=DE',
  'Business France (VIE)': 'https://mon-vie-via.businessfrance.fr/offres', 'Business France (veille)': 'https://mon-vie-via.businessfrance.fr/offres',
  'Engagement Jeunes': 'https://www.engagement-jeunes.com/fr/offres-emploi.html', 'Connexion-Emploi': 'https://www.connexion-emploi.com/fr/offres-emploi-franco-allemandes',
  'CCFA Jobboerse': 'https://cci22.tzportal.io/fr/jobs', 'LinkedIn alertes Achats': 'https://www.linkedin.com/notifications/', 'LinkedIn V.I.E.': 'https://www.linkedin.com/jobs/search-results/?keywords=V.I.E&geoId=101282230',
  'Indeed.de': 'https://de.indeed.com', 'Personio': 'https://www.personio.com' };
var LIB_ETAT_SOURCE = { ok: 'lue', zero: '0 annonce', bloquee: 'bloquee', ecartee: 'ecartee', absente: 'absente', baisse: 'en baisse', inutile: 'lue, rien de garde', partielle: 'lue en partie' };
function celluleSource(e) {
  if (!e) return '<td style="color:var(--ink-3)">pas pour ce profil</td>';
  var coul = e.etat === 'ok' ? 'var(--ok)' : e.etat === 'ecartee' ? 'var(--ink-3)' : 'var(--warn)';
  var chiffres = e.etat === 'ecartee' || e.vues == null ? '' : ' <span class="mono">' + e.vues + (e.retenues != null ? ' &rarr; ' + e.retenues : '') + '</span>';
  var det = e.detail && e.etat !== 'ok' ? '<div style="color:var(--ink-3);font-size:11px">' + esc(e.detail) + '</div>' : '';
  return '<td><b style="color:' + coul + '">' + (LIB_ETAT_SOURCE[e.etat] || esc(e.etat || '?')) + '</b>' + chiffres + det + '</td>';
}
function rendreSources() {
  var el = $('sources'), s = DATA.sante;
  if (!el) return;
  if (!s || !s.sources || !s.sources.length) { el.innerHTML = '<p>sante des sources pas encore publiee</p>'; return; }
  var par = {};
  s.sources.forEach(function (e) { (par[e.source] = par[e.source] || {})[e.profil] = e; });
  var noms = Object.keys(par).sort(function (a, b) {
    var ia = ORDRE_SOURCES.indexOf(a), ib = ORDRE_SOURCES.indexOf(b);
    if (ia === -1) ia = 99; if (ib === -1) ib = 99;
    return ia - ib || a.localeCompare(b);
  });
  var estFlux = function (n) { return /^(Site carriere |Workday |ATS )/.test(n); };
  function ligne(n) {
    var u = URL_SOURCE[n], p = par[n];
    return '<tr><td>' + (u ? '<a href="' + u + '" target="_blank" rel="noopener">' + esc(n) + '</a>' : esc(n)) + '</td>'
      + celluleSource(p.Anne || p.veille) + celluleSource(p.Joffrey) + '</tr>';
  }
  var tete = '<thead><tr><th>Source</th><th>Anne (vues &rarr; retenues)</th><th>Joffrey (vues &rarr; retenues)</th></tr></thead>';
  var principales = noms.filter(function (n) { return !estFlux(n); }), flux = noms.filter(estFlux);
  el.innerHTML = '<div class="cmd-wrap"><table class="cmd-table">' + tete + '<tbody>' + principales.map(ligne).join('') + '</tbody></table></div>'
    + (flux.length ? '<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px;color:var(--ink-2)">Flux ATS, Workday et sites carriere lus un par un (' + flux.length + ')</summary>'
      + '<div class="cmd-wrap"><table class="cmd-table">' + tete + '<tbody>' + flux.map(ligne).join('') + '</tbody></table></div></details>' : '')
    + '<p style="margin-top:8px">Scan du <span class="mono">' + esc(String(s.date || '?').slice(0, 16)) + '</span> : ' + (s.ok || 0) + ' lues sur ' + (s.total || 0)
    + (s.pannes && s.pannes.length ? ', en panne : ' + esc(s.pannes.map(function (x) { return x.source + ' (' + x.profil + ')'; }).join(', ')) : ', aucune panne') + '.</p>';
}
// Battement du moteur horaire (06/11) : meta.moteur = dernier passage de moteur.py quotidien. En heures de bureau, un
// passage vieux de plus de 2 h 15 = le moteur ne tourne pas, et Anne doit le voir sans ouvrir un journal.
function texteMoteur() {
  var mo = DATA.meta && DATA.meta.moteur;
  if (!mo || !mo.fin) return ' &middot; <span style="color:var(--warn)">moteur : aucun passage</span>';
  var fin = new Date(String(mo.fin).replace(' ', 'T')), now = new Date();
  var age = (now - fin) / 60000, h = now.getHours(), jour = now.getDay();
  var bureau = jour >= 1 && jour <= 5 && h >= 8 && h < 20;
  var tard = bureau && age > 135 && h * 60 + now.getMinutes() > 8 * 60 + 135;  // 09/11 (audit) : le premier passage du matin n est pas un retard
  var det = (mo.validations ? ', ' + mo.validations + ' case(s) lue(s)' : '') + (mo.envoyes ? ', ' + mo.envoyes + ' envoi(s)' : '')
    + (mo.aTraiter ? ', ' + mo.aTraiter + ' pour Claude' : '');
  return ' &middot; <span style="color:' + (tard ? 'var(--warn)' : 'var(--ok)') + '" title="dernier passage du moteur horaire' + esc(det) + '">moteur '
    + esc(String(mo.fin).slice(11, 16)) + (tard ? ' (en retard)' : '') + '</span>';
}
// Sante des sources (05/11, sante_sources.py) : chaque site a-t-il ete lu au dernier scan ?
function texteSante() {
  var s = DATA.sante;
  if (!s || !s.pannes) return '';
  if (!s.pannes.length) {
    var utiles = (s.sources || []).filter(function (e) { return e.etat === 'inutile'; }).length;  // 09/11 (audit) : lue ne veut pas dire utile
    return ' &middot; <span style="color:var(--ok)">' + (s.total || 0) + ' sources lues</span>' + (utiles ? ', dont ' + utiles + ' sans offre gardee' : '');
  }
  var noms = [], grave = false;
  s.pannes.forEach(function (p) {
    if (noms.indexOf(p.source) === -1) noms.push(p.source);
    if (p.etat !== 'baisse') grave = true;
  });
  var liste = noms.slice(0, 4).join(', ') + (noms.length > 4 ? ' +' + (noms.length - 4) : '');
  return ' &middot; <span style="color:var(--' + (grave ? 'stop' : 'warn') + ')">' + noms.length
    + (noms.length > 1 ? ' sources en panne : ' : ' source en panne : ') + esc(liste) + '</span>';
}
// Nouvelles offres sur la periode (meta.nouveaux24h / nouveaux7j, par profil), selon le filtre Anne / Joffrey.
function nbNouveaux(cle) {
  var n = (DATA.meta || {})[cle] || {};
  return filtres.qui === 'tous' ? (n.Anne || 0) + (n.Joffrey || 0) : (n[filtres.qui] || 0);
}
function majScanMeta() {
  var m = DATA.meta || {};
  var nA = DATA.offres.filter(function (o) { return o.qui === 'Anne'; }).length;
  var nJ = DATA.offres.length - nA;
  // 09/11 (audit) : la date du scan, pas celle de la publication horaire, sinon un scan manque ne se voit pas.
  var dateScan = DATA.sante && DATA.sante.date ? String(DATA.sante.date).slice(0, 16).replace('T', ' ') : (m.genere || '?');
  $('scan-meta').innerHTML = 'dernier scan <span class="mono">' + esc(dateScan) + '</span>'
    + ' &middot; Anne ' + nA + ', Joffrey ' + nJ + ' &middot; <b>' + nbNouveaux('nouveaux7j') + '</b> nouvelles sur 7 jours'
    + texteSante() + texteMoteur();
}
// Le cockpit vit : toutes les 5 minutes, page visible, si meta.publie a change les donnees du scan
// sont rechargees et refusionnees. PENDING et SHEET ne bougent pas, la vue, les filtres et la
// carte ouverte non plus. Le flash compte les offres absentes de la version precedente.
function verifierFraicheur() {
  if (!chargeOK || document.visibilityState !== 'visible') return;
  // Un onglet reste ouvert des jours : quand une nouvelle version du cockpit est publiee, il se recharge seul, jamais pendant
  // qu Anne ecrit (ce qu elle tape est deja garde dans le navigateur).
  if (!champActif()) fetch('index.html?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (h) {
    var m = h.match(/app\.js\?v=([0-9a-z]+)/), el = document.querySelector('script[src*="app.js"]');
    if (m && el && el.src.indexOf('v=' + m[1]) === -1 && !champActif()) location.reload();
  }).catch(function () {});
  charger('data/meta.json').then(function (m) {
    if (!m || !m.publie || m.publie === (DATA.meta || {}).publie) return;
    var avant = {};
    DATA.offres.forEach(function (o) { avant[o.id] = 1; });
    return chargerDonnees().then(function () {
      fusionner(); rendre();
      var n = DATA.offres.filter(function (o) { return !avant[o.id]; }).length;
      if (n) flash('Cockpit mis a jour : ' + n + (n > 1 ? ' nouvelles offres' : ' nouvelle offre'));
    });
  }).catch(function () {});
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

  chargerDonnees().then(function () {
    chargeOK = true;
    var m = DATA.meta;
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
autoTestNotes();
demarrer();
})();

// Filet du curseur (08/11) : une case de texte qui perd le curseur sans clic, toucher ni Tab d Anne le recupere aussitot,
// au meme endroit et sans faire bouger la page, quelle que soit la cause.
(function () {
  var geste = 0;
  ['pointerdown', 'mousedown', 'touchstart'].forEach(function (n) { document.addEventListener(n, function () { geste = Date.now(); }, true); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Tab' || e.key === 'Escape') geste = Date.now(); }, true);
  document.addEventListener('focusout', function (e) {
    var el = e.target;
    if (!el.matches || !el.matches('textarea.t-rep, textarea.t-note, textarea.f-note, textarea.f-rep')) return;
    if (e.relatedTarget || Date.now() - geste < 500 || !document.hasFocus()) return;
    var deb = el.selectionStart, fin = el.selectionEnd, classe = el.className.split(' ')[0], id = el.dataset.id;
    setTimeout(function () {
      if (document.activeElement && document.activeElement !== document.body) return;
      var cible = el.isConnected && el.offsetParent ? el : [].slice.call(document.querySelectorAll('textarea.' + classe)).filter(function (t) { return t.dataset.id === id && t.offsetParent; })[0];
      if (!cible) return;
      cible.focus({ preventScroll: true });
      cible.setSelectionRange(deb, fin);
      console.log('curseur rendu a la case', id);
    }, 0);
  }, true);
})();
