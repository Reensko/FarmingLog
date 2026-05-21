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

## Lokal entwickeln

Voraussetzung: Node.js 18+ installiert (https://nodejs.org/)

```bash
# Im Projektordner
npm install            # einmalig: Abhängigkeiten installieren
npm run dev            # Entwicklungsserver starten
# Öffne http://localhost:5173
```

Beim Speichern in `App.jsx` lädt der Browser automatisch neu (Hot Reload).

Wenn du auf dem **Handy testen** willst, während der PC den Dev-Server laufen lässt:
1. PC und Handy müssen im gleichen WLAN sein
2. Im PC-Terminal die "Network"-Adresse aus der Vite-Ausgabe nehmen (z.B. http://192.168.1.42:5173)
3. Diese URL auf dem Handy-Browser öffnen

## Produktiv bauen

```bash
npm run build          # erstellt optimierten Build in dist/
npm run preview        # testet den Build lokal vor Deployment
```

Der `dist/`-Ordner enthält dann alle Dateien, die du hochladen musst.

## Vor dem ersten Build

Stelle sicher, dass die vier PWA-Icons in `public/icons/` liegen
(siehe `public/icons/README.md`). Ohne Icons funktioniert die App,
aber die Installation auf dem Homescreen wird scheitern bzw. ein
Generic-Icon zeigen.

## Deployment (kommt in Schritt 6)

Anleitung für GitHub Pages folgt separat.
