'use strict';
// Application installable « Dolce AV » (Electron)
// Nom affiché partout : « Dolce AV » (installateur, menu Démarrer, Dolce AV.exe). L'identifiant (appId be.dolce.stockav)
// ne change pas : la mise à jour remplace l'ancienne installation « Stock AV » au lieu d'en créer une deuxième.
// Les paramètres restent dans %APPDATA%\Stock AV (dossier des premières versions) : config, thème, imprimante.
// - Mode « serveur » : ce PC garde la base et fait tourner le serveur (les autres PC s'y connectent)
// - Mode « client » : se connecte au serveur d'un autre PC (adresse saisie au premier lancement)
// - Mise à jour automatique depuis les « Releases » GitHub, vérifiée à chaque lancement
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, clipboard, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { autoUpdater } = require('electron-updater');

app.setPath('userData', path.join(app.getPath('appData'), 'Stock AV')); // avant tout le reste (verrou d'instance, config)

const ICON = path.join(__dirname, 'icon.png');
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; } };
const saveConfig = (c) => { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); };

// Dossier des données proposé : celui de l'ancienne installation (Documents\stock-av) s'il contient déjà une base
function suggestedDataDir() {
  const old = path.join(os.homedir(), 'Documents', 'stock-av');
  if (fs.existsSync(path.join(old, 'stock.db'))) return old;
  return path.join(app.getPath('documents'), 'Dolce AV'); // nouveau serveur uniquement (un serveur existant garde son dossier)
}
// Adresses de ce PC sur le réseau (à donner aux autres PC)
const lanUrls = (port) => Object.values(os.networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254'))
  .map((n) => `http://${n.address}:${port}`);

let win = null, tray = null, config = null, appUrl = null, quitting = false;
const startHidden = process.argv.includes('--hidden'); // lancé au démarrage de Windows (mode serveur) : seulement l'icône près de l'horloge

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600, show: false, icon: ICON, title: 'Dolce AV',
    autoHideMenuBar: true, backgroundColor: '#141b30',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.once('ready-to-show', () => { if (!startHidden) { win.maximize(); win.show(); } });
  // liens externes (PDF des offres…) : dans une fenêtre de l'app ; autres sites : navigateur
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (appUrl && url.startsWith(appUrl)) return { action: 'allow', overrideBrowserWindowOptions: { icon: ICON, autoHideMenuBar: true, width: 1300, height: 900,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } } }; // fiche du jour : « Enregistrer en PDF »
    shell.openExternal(url); return { action: 'deny' };
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3 || !url.startsWith('http')) return; // -3 = chargement annulé (normal)
    openSetup(`Impossible de joindre le serveur (${appUrl}) : ${desc}. Vérifie que le PC serveur est allumé et que l'application y tourne, ou change l'adresse.`);
  });
  win.on('close', (e) => {
    // mode serveur : fermer la fenêtre ne coupe pas le serveur (il reste près de l'horloge)
    if (config?.mode === 'server' && !quitting) {
      e.preventDefault(); win.hide();
      if (tray && !config.trayHintShown) {
        tray.displayBalloon?.({ title: 'Dolce AV continue de tourner', content: 'Le serveur reste actif pour les autres PC. Clic droit sur l\'icône près de l\'horloge pour quitter.', iconType: 'info' });
        config.trayHintShown = true; saveConfig(config);
      }
    }
  });
  buildMenu();
}
// Écran de démarrage : le renard s'impatiente pendant que le serveur démarre / que l'app s'y connecte
function splashUrl() {
  let fox = '';
  try { fox = fs.readFileSync(path.join(__dirname, '..', 'public', 'mascotte', 'impatient.svg'), 'utf8'); } catch {}
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;color:#fff;
      background:radial-gradient(circle at 50% 38%,#34447a,#141b30 70%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;overflow:hidden}
    .fox{width:150px;animation:sway 1.1s ease-in-out infinite;transform-origin:50% 90%;filter:drop-shadow(0 10px 18px rgba(0,0,0,.4))}
    .fox svg{width:100%;height:auto;display:block;overflow:visible}
    b{font-size:26px} .bar{width:180px;height:4px;border-radius:4px;background:rgba(255,255,255,.18);overflow:hidden}
    .bar i{display:block;height:100%;width:40%;border-radius:4px;background:#e8384f;animation:load 1.4s ease-in-out infinite}
    span{font-size:14px;opacity:.7}
    @keyframes sway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}
    @keyframes load{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
    .fx-drop{animation:drop 2.2s ease-in infinite;transform-box:fill-box}
    @keyframes drop{0%,40%{transform:translateY(0);opacity:1}90%{transform:translateY(26px);opacity:0}100%{opacity:0}}
    .fx-d1,.fx-d2,.fx-d3{animation:dot 1.2s infinite}.fx-d2{animation-delay:.2s}.fx-d3{animation-delay:.4s}
    @keyframes dot{0%,60%,100%{opacity:.2}30%{opacity:1}}
  </style></head><body><div class="fox">${fox}</div><b>Dolce AV</b><div class="bar"><i></i></div>
  <span>${config?.mode === 'server' ? 'Démarrage du serveur…' : 'Connexion au serveur…'}</span></body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function showWindow() { if (!win) return; if (win.isMinimized()) win.restore(); if (!win.isVisible()) { win.maximize(); win.show(); } win.focus(); }

function openSetup(error) {
  win.loadFile(path.join(__dirname, 'setup.html'), { query: error ? { error } : {} });
  win.show();
}

function buildMenu() {
  const items = [
    { label: 'Recharger', accelerator: 'F5', click: () => (appUrl ? win.loadURL(appUrl) : openSetup()) },
    { label: 'Paramètres de connexion…', click: () => openSetup() },
  ];
  if (config?.mode === 'server') items.push({ label: 'Ouvrir le dossier des données', click: () => shell.openPath(config.dataDir) });
  items.push({ type: 'separator' }, { label: `Version ${app.getVersion()}`, enabled: false },
    { label: 'Rechercher une mise à jour', click: () => checkUpdates(true) },
    { label: 'Outils de développement', accelerator: 'F12', click: () => win.webContents.toggleDevTools() },
    { type: 'separator' }, { label: 'Quitter', click: () => { quitting = true; app.quit(); } });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Dolce AV', submenu: items }]));
}

function createTray(port) {
  tray = new Tray(ICON);
  tray.setToolTip('Dolce AV — serveur actif');
  const urls = lanUrls(port);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir Dolce AV', click: showWindow },
    { type: 'separator' },
    { label: 'Adresse pour les autres PC :', enabled: false },
    ...(urls.length ? urls.map((u) => ({ label: `   ${u}  (copier)`, click: () => clipboard.writeText(u) })) : [{ label: '   (pas de réseau)', enabled: false }]),
    { type: 'separator' },
    { label: 'Paramètres…', click: () => { showWindow(); openSetup(); } },
    { label: 'Quitter (arrête le serveur)', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', showWindow);
}

// ---- Mises à jour (GitHub Releases) : téléchargée en arrière-plan, installée au redémarrage
let manualCheck = false;
function checkUpdates(manual = false) {
  if (!app.isPackaged) { if (manual) dialog.showMessageBox(win, { message: 'Les mises à jour ne fonctionnent que dans la version installée.' }); return; }
  manualCheck = manual;
  autoUpdater.checkForUpdates().catch(() => {});
}
autoUpdater.autoDownload = true;
autoUpdater.on('update-not-available', () => { if (manualCheck) dialog.showMessageBox(win, { message: `Dolce AV est à jour (version ${app.getVersion()}).` }); manualCheck = false; });
autoUpdater.on('error', (e) => { if (manualCheck) dialog.showMessageBox(win, { type: 'warning', message: 'Impossible de vérifier les mises à jour.', detail: String(e?.message || e) }); manualCheck = false; });
autoUpdater.on('update-downloaded', async (info) => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'info', buttons: ['Redémarrer maintenant', 'Plus tard'], defaultId: 0, cancelId: 1,
    message: `Nouvelle version ${info.version} prête`,
    detail: config?.mode === 'server' ? 'Le serveur sera coupé quelques secondes pendant le redémarrage.' : 'Elle sera installée au prochain lancement si tu choisis « Plus tard ».',
  });
  if (response === 0) { quitting = true; autoUpdater.quitAndInstall(); }
});

// ---- Fiche du jour : la page affichée est enregistrée en PDF (A4 paysage) puis ouverte
ipcMain.handle('page:savePdf', async (e, name) => {
  const data = await e.sender.printToPDF({ landscape: true, pageSize: 'A4', printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' } });
  const dir = path.join(app.getPath('documents'), 'Dolce AV - Fiches du jour');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(name).replace(/[<>:"/\\|?*]/g, '_').replace(/(\.pdf)?$/i, '.pdf'));
  fs.writeFileSync(file, data);
  shell.openPath(file);
  return file;
});

// ---- Aperçu avant impression : imprimantes du PC + impression directe (sans la boîte de dialogue de Windows)
ipcMain.handle('print:printers', async (e) => (await e.sender.getPrintersAsync())
  .map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault })));
ipcMain.handle('print:page', (e, o) => new Promise((resolve, reject) => {
  e.sender.print({
    silent: true, printBackground: true, deviceName: String(o.deviceName || ''), copies: Math.max(1, Math.min(99, Number(o.copies) || 1)),
    color: o.color !== false, landscape: !!o.landscape, duplexMode: o.duplex ? 'longEdge' : 'simplex', margins: { marginType: 'none' },
  }, (ok, reason) => (ok ? resolve(true) : reject(new Error(reason || 'impression annulée'))));
}));

// ---- Apparence : la barre de titre de Windows suit le thème choisi dans l'app (Auto = celui de Windows)
const themeSource = (t) => (t === 'dark' || t === 'light' ? t : 'system');
ipcMain.on('theme:set', (_e, t) => {
  nativeTheme.themeSource = themeSource(t);
  if (config) config.theme = t; // config en mémoire : réécrite par d'autres réglages
  const c = readConfig();
  if (c && c.theme !== t) saveConfig({ ...c, theme: t }); // retenu pour le prochain lancement (pas de barre claire au démarrage)
});

// ---- Écran de premier lancement / paramètres (electron/setup.html)
ipcMain.handle('setup:get', () => ({ config: readConfig(), suggestedDataDir: suggestedDataDir(), version: app.getVersion() }));
ipcMain.handle('setup:chooseFolder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, { title: 'Dossier des données', defaultPath: current || suggestedDataDir(), properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('setup:test', async (_e, url) => {
  try {
    const r = await fetch(new URL('/api/version', url), { signal: AbortSignal.timeout(4000) });
    const v = await r.json();
    return { ok: true, build: v.build };
  } catch (e) { return { ok: false, error: String(e?.cause?.code || e?.message || e) }; }
});
ipcMain.handle('setup:save', (_e, c) => {
  saveConfig({ ...readConfig(), ...c });
  if (c.mode === 'server') app.setLoginItemSettings({ openAtLogin: !!c.autostart, args: ['--hidden'] });
  else app.setLoginItemSettings({ openAtLogin: false });
  quitting = true; app.relaunch(); app.exit(0);
});

app.whenReady().then(async () => {
  config = readConfig();
  nativeTheme.themeSource = themeSource(config?.theme);
  // démarrage avec Windows : réinscrit à chaque lancement (le programme s'appelle désormais Dolce AV.exe)
  if (app.isPackaged && config?.mode === 'server' && config.autostart) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  createWindow();
  if (!config?.mode) return openSetup();
  await win.loadURL(splashUrl()).catch(() => {}); // écran d'attente, remplacé dès que l'app est prête
  try {
    if (config.mode === 'server') {
      process.env.STOCKAV_DATA = config.dataDir || suggestedDataDir(); // lu par server.js au chargement
      const port = Number(config.port) || 3000;
      await require('../server.js').start(port);
      appUrl = `http://localhost:${port}`;
      createTray(port);
    } else {
      appUrl = String(config.serverUrl || '').replace(/\/+$/, '');
    }
    win.loadURL(appUrl);
  } catch (e) {
    const msg = e.code === 'EADDRINUSE'
      ? `Le port ${config.port || 3000} est déjà utilisé : l'ancien serveur (fenêtre noire « node server.js ») tourne sans doute encore. Ferme-le, puis relance Dolce AV.`
      : `Le serveur n'a pas pu démarrer : ${e.message}`;
    openSetup(msg);
  }
  checkUpdates();
  setInterval(() => checkUpdates(), 6 * 3600e3); // le PC serveur reste allumé longtemps : on revérifie toutes les 6 h
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (config?.mode !== 'server') app.quit(); });
