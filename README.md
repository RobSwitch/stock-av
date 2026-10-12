# Dolce AV

Suivi du stock audiovisuel et planning BEO de l'équipe AV (Dolce La Hulpe).

## Utilisation

- **Application installée (recommandé)** : télécharger `Dolce-AV-Setup-x.y.z.exe` dans les *Releases* du dépôt GitHub et l'installer.
  Au premier lancement, choisir :
  - **Ce PC est le serveur** : un seul PC, qui garde la base (stock, planning, fiches techniques) et reste allumé ;
  - **Se connecter au serveur** : les autres PC (adresse affichée sur le PC serveur, clic droit sur l'icône Dolce AV près de l'horloge).
  
  L'application vérifie à chaque lancement s'il existe une nouvelle version et se met à jour toute seule.
- **Sans installation** : `node server.js` (Node 22 ou plus) puis ouvrir http://localhost:3000.

> Windows peut afficher « Windows a protégé votre ordinateur » (application non signée) : *Informations complémentaires → Exécuter quand même*.

> Le nom technique interne reste « Stock AV » (dossier d'installation, paramètres dans `%APPDATA%\Stock AV`) pour que les PC déjà installés gardent leur configuration.

## Données

Les données ne sont **jamais** dans ce dépôt (voir `.gitignore`) : elles restent dans le dossier des données du PC serveur
(`stock.db` + `fichiers/offres/` pour les PDF des fiches techniques). Pour une sauvegarde, copier ce dossier.

## Publier une nouvelle version

1. Augmenter `"version"` dans `package.json` (ex. `1.0.4` → `1.0.5`).
2. Envoyer les modifications sur GitHub (GitHub Desktop : *Commit* puis *Push origin*).
3. GitHub fabrique l'installateur et le publie dans les *Releases* (onglet *Actions* pour suivre, ~3 min).
4. Les applications installées se mettent à jour au lancement suivant ; les pages ouvertes se rechargent toutes seules.

## Mascotte

L'icône (renard avec casque audio) est dessinée en vectoriel dans `build/mascotte.svg` ; `build/icon.png`, `electron/icon.png`
et `public/icon.png` en sont la version 512×512.

## Développement

```
npm install        # outils (Electron, electron-builder)
npm run server     # serveur seul (http://localhost:3000)
npm run app        # application Electron
npm run dist       # fabrique l'installateur dans dist/ (sans publier)
```
