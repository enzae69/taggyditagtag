# TaggyTag 🐷🃏

Ein **Multiplayer-only** Browser-Spiel: "Schweinchen in der Mitte" mit gekurvten Kartenwürfen.

Zwei Spieler stehen sich gegenüber und werfen sich eine Karte zu. In der Mitte
jagt ein Schweinchen 🐷 die Karte — und **wird jede Sekunde schneller**. Wen das
Schweinchen mit der Karte erwischt, **der verliert**. Du kannst den Wurf
**kurven** (Touch oder Maus), um das Schweinchen auszutricksen.

## Brauche ich Firebase / Supabase?

**Nein.** Das Spiel braucht einen autoritativen Echtzeit-Game-Loop (30 Ticks/s)
mit Physik und Kollisionserkennung. Firebase/Supabase sind für Daten-Sync
gedacht und für sowas zu langsam/teuer. Stattdessen: ein kleiner **Node.js +
Socket.IO** Server, der das gesamte Spiel rechnet. Clients senden nur ihre
Würfe und zeichnen den vom Server geschickten Zustand.

## Features

- **Server-Auswahl**: EU 1, EU 2, EU 3, EU 4 (wie Region-Server).
- **Multiplayer only**: ein Match startet erst, wenn **2 Spieler** im selben
  Server in der Warteschlange sind (Matchmaking).
- **Touch-Curve-Würfe**: ziehen & loslassen, um die Karte gekurvt zu werfen.
- **Schweinchen** wird sekündlich schneller (`PIG_ACCEL` in `server.js`).
- Autoritativer Server: keine Cheats möglich, der Server entscheidet alles.

## Online spielen (Live-Link für Safari & Co.)

Das Projekt ist deploy-fertig für **Render.com** (kostenlos, WebSockets/Safari):

1. Geh auf <https://render.com> und logge dich mit GitHub ein.
2. **New +** → **Blueprint** → wähle dieses Repo (`taggyditagtag`).
   Render liest `render.yaml` automatisch.
3. **Apply** klicken. Nach ~1–2 Minuten bekommst du eine Adresse wie
   `https://taggytag.onrender.com`.

Diese Adresse kannst du im **Safari** (Handy oder Mac) öffnen und teilen — zwei
Leute wählen denselben Server (z. B. „EU 1"), dann startet das Match.

> Hinweis: Im kostenlosen Render-Tier „schläft" der Server nach Inaktivität —
> der erste Aufruf danach dauert ~30 s, dann läuft alles normal.

## Lokal starten / entwickeln

```bash
npm install
npm start
# -> http://localhost:3000
```

Zum Testen am besten **zwei Browser-Tabs/Geräte** öffnen, in beiden denselben
Server (z. B. "EU 1") wählen — dann startet das Match automatisch.

## Stellschrauben (`server.js`)

| Konstante        | Bedeutung                                   |
|------------------|---------------------------------------------|
| `CARD_SPEED`     | Fluggeschwindigkeit der Karte               |
| `PIG_BASE_SPEED` | Start-Geschwindigkeit des Schweinchens      |
| `PIG_ACCEL`      | Wie viel schneller das Schweinchen pro Sek. |
| `HIT_RADIUS`     | Wie nah das Schweinchen ran muss zum Fangen |
| `SERVER_NAMES`   | Liste der wählbaren Server                  |

## Wie es funktioniert

1. Client verbindet sich → bekommt die Lobby (Serverliste mit Spielerzahlen).
2. Spieler wählt einen Server → kommt in dessen Warteschlange.
3. Sobald 2 Spieler warten → der Server erstellt ein `Game` und startet den Loop.
4. Der Server simuliert Karte (Bézier-Kurve), Schweinchen (verfolgt die Karte)
   und Kollision; er broadcastet 30×/s den Zustand.
5. Berührt das Schweinchen die Karte → der aktuelle Karten-Besitzer verliert.
