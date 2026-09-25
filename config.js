// Configuration du cockpit. Ce fichier est le seul a modifier apres deploiement.
//
//   sheetApi : URL /exec de l application web Apps Script (voir apps_script.gs).
//              Vide = mode local : les statuts restent dans ce navigateur.
//   token    : doit etre identique a TOKEN dans apps_script.gs.
window.COCKPIT_CONFIG = {
  sheetApi: 'https://script.google.com/macros/s/AKfycbwwa6-meXC5h0ntFKU4sgTzGyh4pudcxxooP6dC8_DGqg59wKgvY06ocUeRqCF-v3To/exec',
  token: 'cockpit-aj-2026',
};
