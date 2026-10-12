'use strict';
// Pont entre l'écran de paramètres (setup.html) et l'application : seulement ces quelques fonctions
const { contextBridge, ipcRenderer } = require('electron');

// uniquement pour l'écran local (fichier), jamais pour les pages servies par le serveur
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('stockav', {
    get: () => ipcRenderer.invoke('setup:get'),
    chooseFolder: (current) => ipcRenderer.invoke('setup:chooseFolder', current),
    test: (url) => ipcRenderer.invoke('setup:test', url),
    save: (config) => ipcRenderer.invoke('setup:save', config),
  });
}
