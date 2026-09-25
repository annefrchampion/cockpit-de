// Configuration du cockpit. Ce fichier est le seul a modifier apres deploiement.
//
//   sheetApi : URL /exec de l application web Apps Script (voir apps_script.gs).
//              Vide = mode local : les statuts restent dans ce navigateur.
//   token    : doit etre identique a TOKEN dans apps_script.gs.
window.COCKPIT_CONFIG = {
  sheetApi: '',
  token: 'cockpit-aj-2026',
};
