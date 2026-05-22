# ⚔ CoC Farming Tracker (PWA)

Progressive Web App zum Tracken von Farming-Sessions in Clash of Clans.

## Projekt-Struktur

```
coc-farming-tracker/
├── index.html              # HTML-Einstiegspunkt mit PWA-Meta-Tags
├── package.json            # npm-Konfiguration
├── vite.config.js          # Build-Tool-Konfiguration
├── .gitignore
├── public/                 # Statische Dateien (kommen 1:1 in den Build)
│   ├── manifest.json       # PWA-Manifest (App-Name, Icons, Farben)
│   ├── sw.js               # Service Worker (Offline-Support)
│   └── icons/              # App-Icons (siehe README dort)
│       └── README.md
└── src/                    # React-Quellcode
    ├── main.jsx            # React-Mountpoint + SW-Registrierung
    └── App.jsx             # Die komplette Tracker-App
```
