# PWA Icons – BENÖTIGT

Diese vier PNG-Dateien müssen in diesem Ordner liegen:

- icon-192.png             (192×192 px) – normales Icon für Android-Homescreen
- icon-512.png             (512×512 px) – höher aufgelöstes Icon für Splash-Screen
- icon-maskable-192.png    (192×192 px) – "maskable" Variante (Android adaptive icons)
- icon-maskable-512.png    (512×512 px) – "maskable" Variante in groß

## Was "maskable" bedeutet

Android kann Icons in verschiedenen Formen darstellen (Kreis, Squircle, abgerundetes Quadrat).
"Maskable" Icons sollten ihr Motiv in der inneren 80% Sicherheitszone halten –
der Rand kann abgeschnitten werden, das ist erwartetes Verhalten.

## Empfohlene Tools

- Online: https://maskable.app/ (testet Maskable-Icons live)
- Online: https://realfavicongenerator.net/ (generiert alle Größen aus einem Quell-PNG)
- Lokal: ImageMagick, Photoshop, Figma

## Tipp

Erstelle erst ein 512×512 oder 1024×1024 Master-Icon, dann skaliere herunter.
Hintergrund sollte deine Theme-Farbe (z.B. #FFD700 auf #0a0514) verwenden,
damit der Splash-Screen harmonisch aussieht.
