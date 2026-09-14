# Figur in OBS: Anleitung auf Deutsch

Diese Anleitung zeigt dir, wie du eine animierte Figur in OBS Studio
bringst. Du brauchst dafür keine Programmierkenntnisse.

Es gibt zwei Wege:

| Weg | Wofür | Du brauchst |
|---|---|---|
| **A** Figur über den Server | du arbeitest selbst mit diesem Projekt | Python, dieses Projekt, OBS 28 oder neuer |
| **C** Paket als ZIP | du gibst die Figur an jemanden weiter | nur OBS 28 oder neuer |

Teil B erklärt, wie du so ein Paket baust. Teil D, F und G gelten für beide
Wege. Teil E, der Kamera-Avatar, geht nur über den Server.

Die Befehle in dieser Anleitung laufen in **Windows PowerShell**. Tippe
jeden Befehl einzeln ein und drücke danach Enter.

In OBS stehen die Namen der Knöpfe und Felder hier auf Deutsch. Dahinter
steht in Klammern die englische Beschriftung, falls dein OBS auf Englisch
eingestellt ist.

---

## A Figur über den Server in OBS

Hier lädt OBS die Figur direkt aus diesem Projekt. Das ist der schnellste
Weg, wenn du selbst an der Figur arbeitest.

### 1. Server starten

Öffne PowerShell. Wechsle in den Projektordner:

```
cd C:\Pfad\zu\idle-web-animation
```

Starte den Server:

```
python tools/serve.py
```

Lass dieses Fenster offen, solange du streamst.
Mit `Strg+C` hältst du den Server an.
Der Server ist nur auf deinem eigenen Rechner erreichbar.
Läuft das Studio schon, läuft auch der Server. Dann überspringst du diesen Schritt.

### 2. Browser-Quelle anlegen

1. Klicke in OBS unter **Quellen** (Sources) auf **+**.
2. Wähle **Browser**.
3. Gib einen Namen ein, zum Beispiel `Pedro`.
4. Klicke auf **OK**.

### 3. Quelle einstellen

| Feld | Wert |
|---|---|
| **Lokale Datei** (Local file) | kein Haken |
| **URL** | `http://127.0.0.1:5173/addons/obs/figure.html?figure=pedro` |
| **Breite** (Width) | `1792` |
| **Höhe** (Height) | `1000` |
| **Quelle herunterfahren, wenn nicht sichtbar** (Shutdown source when not visible) | kein Haken |
| **Browser aktualisieren, wenn Szene aktiv wird** (Refresh browser when scene becomes active) | kein Haken |

Klicke danach auf **OK**.

- In der URL steht `pedro`. Ersetze das durch den Ordnernamen deiner Figur
  unter `figures/`.
- 1792 × 1000 ist Pedros eigene Größe. Eine andere Figur hat eine andere
  Größe. Du findest sie in ihrer `figure.json` unter `size`.
- Setzt du bei den zwei Kästchen einen Haken, beginnt die Figur bei jedem
  Szenenwechsel von vorn.
- Den Hintergrund musst du nicht einstellen. Die Seite ist durchsichtig.

---

## B Ein Paket im Studio bauen

Ein Paket ist eine ZIP-Datei. Wer sie bekommt, braucht weder Python noch
dieses Projekt. Er entpackt sie und bindet sie in OBS ein (Teil C).

### 1. Studio öffnen

Starte den Server wie in Teil A, Schritt 1.
Öffne dann diese Adresse in Chrome oder Edge:

```text
http://localhost:5173/studio/
```

### 2. Figur wählen

In der Leiste ganz oben im Studio steht eine Auswahlliste mit den Figuren.
Wähle dort deine Figur aus, zum Beispiel `pedro`.

### 3. Export-Karte öffnen

Klicke in der rechten Spalte auf die Karte **Export**. Sie klappt auf.

Wähle bei **size** die Breite der Figur in Pixeln. Die Höhe folgt im
gleichen Verhältnis:

| size | Wann |
|---|---|
| `master` | volle Auflösung, größte Datei. Pedro: 1792 × 1000 |
| `1500` | sehr große Quelle in OBS |
| `1000` | der übliche Wert. Pedro: 1000 breit, gut 550 hoch |
| `750`, `512` | kleine Figur in einer Ecke |

Diese Größe gilt für **Folder (zip)** und für das OBS-Paket.
Die genauen Zahlen stehen danach in `ANLEITUNG.txt` im Paket.

### 4. Den Block „OBS package" ausfüllen

Unter **Folder (zip)** steht der Block **OBS package**. Die Felder von oben
nach unten:

| Feld im Studio | Was du tust |
|---|---|
| **Logo…** | Klicke darauf und wähle ein Bild: PNG, WebP oder JPEG. Ohne Logo lässt du das Feld leer. |
| **Remove logo** | Nimmt das Logo wieder heraus. Der Knopf erscheint erst, wenn ein Logo gewählt ist. |
| **logo inside figure** | Ohne Haken (so startet das Studio) kommt das Logo nur als eigene Quelle `logo.html` ins Paket. Du verschiebst und skalierst es dann in OBS (Teil C, Schritt 4). Mit Haken steckt das Logo zusätzlich fest in `obs.html`, an der Stelle aus **logo X**, **logo Y** und **logo width**, und erscheint als Vorschau auf der Bühne. |
| **logo X** | Nur mit Haken bei **logo inside figure**, sonst grau. Schiebt das Logo in `obs.html` nach links (0) oder rechts (1). Der Wert ist die Mitte des Logos. |
| **logo Y** | Nur mit Haken bei **logo inside figure**. Schiebt das Logo in `obs.html` nach oben (0) oder unten (1). |
| **logo width** | Nur mit Haken bei **logo inside figure**. Die Breite des Logos in `obs.html` als Anteil der Figurenbreite. 0.34 heißt: ein gutes Drittel. Die Höhe folgt von selbst, das Logo wird nie verzerrt. |
| **wipe-in** | Das Logo wischt beim Start von links nach rechts ins Bild. Ein heller Lichtstreifen läuft auf der Kante mit. Ohne Haken ist das Logo sofort da. |
| **glow** | Das Logo glimmt im Takt des Atems der Figur. Hat die Figur keinen Atem, glimmt es alle 4,2 Sekunden. |
| **gleam** | Alle 9 Sekunden läuft ein Glanzstreifen über das Logo. |
| **start mood** | Die Stimmung, mit der die Figur startet. Sie gilt auch für jede Szene ohne Stimmungswort im Namen (Teil D). |
| **credit** | Wer die Figur gezeichnet hat, zum Beispiel `Max Muster (@maxmuster)`. Das Studio merkt sich den Text auf diesem Rechner. |
| **licence** | `none` oder `CC BY 4.0`. Mit `CC BY 4.0` brauchst du einen Eintrag bei **credit** (Teil F). |
| **guide language** | Die Sprache der Textdateien im Paket. `English` (so startet das Studio) schreibt `README.txt` und eine englische `LICENSE.txt`. `Deutsch` schreibt `ANLEITUNG.txt` und eine `LICENSE.txt` auf Deutsch und Englisch. Das Studio merkt sich die Wahl auf diesem Rechner. Einmal `Deutsch` wählen reicht also. |
| **OBS package (zip)** | Baut das Paket und lädt es herunter. |

Die drei Effekte **wipe-in**, **glow** und **gleam** schaltest du einzeln
ein und aus. Meldet das System „Bewegung reduzieren", zeigt die Seite das
Logo sofort und ohne Effekte.

**credit** und **licence** erscheinen nie im Bild. Sie stehen nur im
Quelltext von `obs.html` und `logo.html` und in den Textdateien des Pakets.

Unter dem Knopf steht eine Zeile mit dem Ergebnis. Fehlt etwas, steht dort,
was.

### 5. Was im Paket liegt

Die Datei heißt `<figur>-obs.zip`, zum Beispiel `pedro-obs.zip`. Darin:

| Datei | Inhalt |
|---|---|
| `obs.html` | die Figur. Das Abspielprogramm steckt mit in dieser Datei. |
| `layers/` | die Bilder der Figur, in der gewählten Größe |
| `logo.html` | das Logo als eigene OBS-Quelle mit den gewählten Effekten, nur mit Logo |
| `logo.webp` (oder `.png`, `.jpg`) | dein Logo als Bild, nur wenn du eins gewählt hast |
| `ANLEITUNG.txt` oder `README.txt` | die Kurzanleitung für den Empfänger, mit der echten Breite und Höhe und den Stimmungen dieser Figur. `ANLEITUNG.txt` mit **guide language** `Deutsch`, `README.txt` auf Englisch. |
| `LICENSE.txt` | nur mit Lizenz: wem die Bilder gehören und was CC BY 4.0 erlaubt |

Der Hintergrund der Figur kommt nie mit. Die Seite bleibt durchsichtig.

---

## C Ein Paket weitergeben und in OBS einbinden

Diesen Teil kannst du so an die Person weitergeben, die das Paket bekommt.

### 1. Entpacken

1. Lege die ZIP-Datei an einen festen Platz, zum Beispiel `Dokumente\OBS`.
2. Klicke mit der rechten Maustaste darauf.
3. Wähle **Alle extrahieren…**.
4. Klicke auf **Extrahieren**.

Aus der ZIP-Datei heraus funktioniert es nicht. Entpacke sie immer zuerst.

**Lass den Ordner zusammen.** `obs.html` sucht die Bilder im Ordner `layers`
direkt neben sich. Verschiebst du `obs.html` allein, bleibt die Quelle leer.
Verschiebst du später den ganzen Ordner, stellst du den Pfad in OBS neu ein.

### 2. Browser-Quelle anlegen

1. Klicke in OBS unter **Quellen** (Sources) auf **+**.
2. Wähle **Browser**.
3. Gib einen Namen ein und klicke auf **OK**.

### 3. Quelle einstellen

1. Setze den Haken bei **Lokale Datei** (Local file).
2. Klicke auf **Durchsuchen** (Browse).
3. Wähle `obs.html` im entpackten Ordner.
4. Trage bei **Breite** (Width) und **Höhe** (Height) die Zahlen aus
   `ANLEITUNG.txt` ein. Sie hängen von der gewählten **size** ab.
   Für Pedro in `master` sind das `1792` und `1000`.
5. Kein Haken bei **Quelle herunterfahren, wenn nicht sichtbar**
   (Shutdown source when not visible).
6. Kein Haken bei **Browser aktualisieren, wenn Szene aktiv wird**
   (Refresh browser when scene becomes active).
7. Klicke auf **OK**.

Die Figur steht jetzt durchsichtig in deiner Szene.
Ziehe die Quelle größer oder kleiner wie jede andere Quelle.
Die Figur passt sich an und wird nie verzerrt.

### 4. Das Logo als eigene Quelle

Nur für ein Paket mit Logo. Das Logo liegt als `logo.html` im Ordner. Als
eigene Quelle verschiebst und skalierst du es frei.

Wurde das Paket mit **logo inside figure** gebaut, steckt das Logo schon in
`obs.html`. Dann brauchst du diese Quelle nur, wenn du das Logo getrennt
bewegen willst. `ANLEITUNG.txt` sagt dir, welcher Fall gilt.

1. Klicke in OBS unter **Quellen** (Sources) auf **+**.
2. Wähle **Browser**.
3. Gib den Namen `Logo` ein und klicke auf **OK**.
4. Setze den Haken bei **Lokale Datei** (Local file).
5. Klicke auf **Durchsuchen** (Browse).
6. Wähle `logo.html` im selben Ordner wie `obs.html`.
7. Trage bei **Breite** (Width) und **Höhe** (Height) die Zahlen aus
   `ANLEITUNG.txt` ein. Die lange Seite ist `800`, die andere folgt aus der
   Form des Logos. Für ein Logo im Format 1948 × 1208 sind das `800` und
   `520`.
8. Kein Haken bei **Quelle herunterfahren, wenn nicht sichtbar**
   (Shutdown source when not visible).
9. Kein Haken bei **Browser aktualisieren, wenn Szene aktiv wird**
   (Refresh browser when scene becomes active).
10. Klicke auf **OK**.

So passt du das Logo an:

- **Verschieben:** Ziehe das Logo in der Vorschau mit der Maus.
- **Größe:** Ziehe an den roten Ecken des Rahmens.
- **Zuschneiden:** Halte **Alt** gedrückt und ziehe an einer roten Kante.
- **Reihenfolge:** `Logo` steht in der Liste **Quellen** über der Figur.
  Sonst verdeckt die Figur das Logo.

Um das Logo ist in `logo.html` ein Rand frei. Dort leuchtet der Schein von
**glow**. Schneide diesen Rand nicht weg, sonst endet der Schein an einer
harten Kante.

**Ohne Animation:** Wähle in Schritt 2 **Bild** (Image) statt **Browser**
und dann die Logo-Datei aus dem Ordner, zum Beispiel `logo.webp`. Das Logo
steht dann still, ohne **wipe-in**, **glow** und **gleam**.

---

## D Stimmungen und Szenennamen

Eine Figur kann mehrere Stimmungen haben. Pedro hat `neutral`, `sad` und
`happy`. Welche Stimmungen deine Figur hat, steht in `ANLEITUNG.txt` im Paket. Im Studio
siehst du sie in der Karte **Mood**.

### Stimmung über den Szenennamen

Steht der Name einer Stimmung als Wort im Namen einer Szene, wechselt die
Figur in diese Stimmung. Der Wechsel geht weich über.

| Szenenname | Stimmung |
|---|---|
| `Pause sad` | `sad` |
| `Just Chatting happy` | `happy` |
| `HAPPY Ende` | `happy`, Groß- und Kleinschreibung ist egal |
| `Game` | die Startstimmung |
| `sad-ish` | kein Treffer, ein Wort mit Bindestrich zählt als ein Wort |

Stehen zwei Stimmungswörter im Namen, gewinnt das erste.

### Die Startstimmung

- **Paket:** Du legst sie im Studio bei **start mood** fest.
- **Server:** Du hängst sie an die URL an, zum Beispiel
  `http://127.0.0.1:5173/addons/obs/figure.html?figure=pedro&state=sad`.

Die Figur startet in dieser Stimmung. Sie kehrt in jeder Szene ohne
Stimmungswort dorthin zurück.

### Seitenberechtigung

Damit die Figur den Szenennamen schon beim Laden kennt, braucht die Quelle
mehr Rechte:

1. Klicke mit der rechten Maustaste auf die Browser-Quelle.
2. Wähle **Eigenschaften** (Properties).
3. Suche **Seitenberechtigungen** (Page permissions).
4. Wähle **Read access to user information** oder eine höhere Stufe.
5. Klicke auf **OK**.

Ohne diese Einstellung wechselt die Stimmung erst beim nächsten
Szenenwechsel.

---

## E Kamera-Avatar

Die Figur kann deinem Gesicht folgen: Sie schaut, wohin du schaust, und
blinzelt, wenn du blinzelst. Das geht **nur über den Server** (Teil A), nicht
mit einem Paket. Ein Browser öffnet die Kamera nur für eine Seite vom
Server.

Du brauchst:

- OBS 31 oder neuer (**Hilfe > Über**, englisch Help > About),
- OBS gestartet mit dem Zusatz `--enable-media-stream`,
- als URL `http://127.0.0.1:5173/addons/obs/avatar.html?figure=pedro&debug=1`.

Diese Seite ist noch nicht mit einer echten Kamera getestet. Die genaue
Einrichtung steht auf Englisch in [README.md](README.md), Abschnitt
„Part B: avatar with camera".

---

## F Credit und Lizenz

### CC BY 4.0 in einfachen Worten

CC BY 4.0 ist eine freie Lizenz für Bilder. Sie erlaubt dir:

- die Figur zu zeigen, auch im Stream mit Einnahmen,
- sie weiterzugeben,
- sie zu verändern.

Dafür gibt es eine Bedingung: **Du nennst den Urheber.** Dazu gehören der
Name, die Lizenz mit Link und ein Hinweis, falls du etwas verändert hast.

Die Lizenz im Wortlaut: https://creativecommons.org/licenses/by/4.0/deed.de

### So nennst du den Urheber im Stream

Die Figur zeigt den Namen nie selbst an. Schreibe ihn an eine dieser Stellen:

- in die Beschreibung des Streams oder des Videos,
- in ein Panel unter dem Kanal,
- als Zeile in den Abspann.

Ein Beispiel zum Kopieren:

```text
Figur: Pedro von Max Muster (@maxmuster), CC BY 4.0
```

Mit Link zur Lizenz, wo Links möglich sind:

```text
Figur: Pedro von Max Muster (@maxmuster), CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)
```

Den passenden Satz für dein Paket findest du fertig in `ANLEITUNG.txt`.

### Das Logo gehört nicht dazu

Die Lizenz gilt nur für die Bilder der Figur. Ein Logo, das du im Studio
dazulegst, bleibt das Zeichen seines Inhabers. Es steht **nicht** unter
CC BY 4.0, außer der Inhaber sagt das ausdrücklich. Wer dein Paket bekommt,
darf das Logo also nicht einfach für eigene Zwecke nutzen.

Das Abspielprogramm in `obs.html` und der Code in `logo.html` stehen unter
der MIT-Lizenz dieses Projekts. `LICENSE.txt` im Paket nennt beides.

---

## G Probleme und Lösungen

| Problem | Lösung |
|---|---|
| Die Quelle bleibt leer (Paket) | Ist die ZIP-Datei entpackt? Liegt der Ordner `layers` neben `obs.html`? Ist der Haken bei **Lokale Datei** gesetzt? |
| Die Quelle bleibt leer (Server) | Läuft `python tools/serve.py` noch? Stimmt der Ordnername in der URL? |
| Die Figur ist abgeschnitten oder sehr klein | Trage **Breite** und **Höhe** wie in `ANLEITUNG.txt` ein. Ziehe dann die Quelle in der Szene auf die gewünschte Größe. |
| Die Figur ist unscharf | Baue das Paket mit einer größeren **size**, zum Beispiel `1500` oder `master`. |
| Die Figur beginnt bei jedem Szenenwechsel von vorn | Entferne die Haken bei **Quelle herunterfahren, wenn nicht sichtbar** und **Browser aktualisieren, wenn Szene aktiv wird**. |
| Die Stimmung wechselt nicht | Steht das Wort genau so im Szenennamen, als eigenes Wort? Prüfe die Seitenberechtigung (Teil D). |
| Die Stimmung wechselt erst bei der nächsten Szene | Stelle die Seitenberechtigung auf **Read access to user information** (Teil D). |
| Das Logo fehlt | Hast du die Quelle `Logo` angelegt (Teil C, Schritt 4)? Steht sie in der Liste **Quellen** über der Figur? Liegt die Logo-Datei neben `logo.html`? Hast du sie umbenannt? Der Name muss genau so bleiben. |
| Das Logo steht falsch | Als eigene Quelle: Verschiebe und skaliere es in OBS. Steckt es in `obs.html` (**logo inside figure**): Baue das Paket neu und ändere **logo X**, **logo Y** und **logo width**. Die Vorschau auf der Bühne zeigt die Stelle. |
| Der Schein um das Logo ist abgeschnitten | Trage **Breite** und **Höhe** aus `ANLEITUNG.txt` ein und schneide den freien Rand um das Logo nicht weg. |
| Das Logo erscheint ohne Animation | Sind **wipe-in**, **glow** und **gleam** angehakt? Wenn ja: Das System meldet vermutlich „Bewegung reduzieren". In Windows heißt das **Animationseffekte** unter **Einstellungen > Barrierefreiheit > Visuelle Effekte**. Die Seite nimmt darauf Rücksicht. |
| Der Knopf **OBS package (zip)** meldet einen Fehler | Lies die Zeile darunter. Oft fehlt bei `CC BY 4.0` der **credit**. |
| Nichts bewegt sich | Prüfe die OBS-Version unter **Hilfe > Über** (Help > About). Du brauchst 28 oder neuer. Öffne die **Eigenschaften** der Quelle und klicke auf **Cache der aktuellen Seite aktualisieren** (Refresh cache of current page). |
| Ein grüner oder schwarzer Kasten statt Durchsichtigkeit | Steht in der URL `&bg=`? Entferne es. Bei einem Paket gibt es diese Einstellung nicht. |
