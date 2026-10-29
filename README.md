# Bad Good

**Bad Good** to sandboxowa gra 2D o złym, mściwym bogu i małej dolinie, w której
żyją ludzie. Kobiety i mężczyźni w różnym wieku rodzą się, dorastają, szukają
towarzystwa, zakładają rodziny, uprawiają pola i umierają ze starości. Ty
patrzysz z góry i masz cztery moce: **piorun**, **deszcz**, który wypełnia
zagłębienia terenu i topi tych, którzy nie zdążą uciec, **wiatr**, który
szarpie drzewa, łamie zboże i potrafi zwiać całe chaty, oraz **trzęsienie
ziemi**, które zapada glebę w lej albo zasypuje pustkę ziemią.

Gra nie ma zewnętrznych zależności ani assetów — cała grafika i dźwięk powstają
proceduralnie w przeglądarce.

## Wygląd

Dolina ma słowiański, ludowy charakter. Chaty są zbudowane z bali i kryte
grubą słomą, z rzeźbionym znakiem słońca na kalenicy i przy drzwiach. Ludzie
noszą lniane koszule, sukienki, zapaski i tkane szarfy z czerwonym haftem;
w wodzie zakładają skromną bieliznę kąpielową z płótna, również obszywaną
ludowym haftem. Miejscem kultu jest rzeźbiony drewniany bożek ze słonecznym
znakiem, twarzą i świecącymi runami, a zmarłych upamiętniają małe kopce
z drewnianym słupkiem przodków. Tło tworzą zamglone słowiańskie wzgórza,
bory świerkowe i korony dębów, brzóz oraz lip.

## Uruchomienie

Gra korzysta z plików JSON wczytywanych przez `fetch`, więc nie otwieraj
`index.html` bezpośrednio z dysku (`file://`). Uruchom lokalny serwer:

```bash
cd badgood
python3 -m http.server 8000
```

Następnie otwórz <http://localhost:8000>.

### Firefox i brak terenu

Jeśli po aktualizacji nie widzisz gruntu, najpierw odśwież stronę z pominięciem
pamięci podręcznej. Teren jest rysowany w kawałkach, a każdy
kawałek jest celowo podpięty do ukrytej warstwy w DOM — Firefox potrafi bowiem
nie namalować canvasu, który nie należy do dokumentu.

Gra sama sprawdza, czy chunki trafiły na główny canvas. Jeśli nie, przełącza się
na rysowanie kafelków bezpośrednio. Domyślnie chunki mają 512×512 px; jeśli
Firefox nadal ma problem, w `config/game.json` można ustawić mniejszy
`terrain.chunkSize` (np. 256). Tryb bezpośredni można też wymusić ręcznie:

```text
http://localhost:8000/?terrain=direct
```

Jeśli w trybie `direct` teren nadal się nie pojawia, problem najprawdopodobniej
leży po stronie sprzętowego canvasu, rozszerzenia blokującego canvas albo
sterownika GPU. Warto wtedy sprawdzić konsolę przeglądarki i wpis
`badgood.renderer.terrainMode`.

## Sterowanie

Gra jest przewidziana na mysz i ekran dotykowy smartfona.

| Wejście | Działanie |
| --- | --- |
| **kliknięcie karty mocy** | uzbrojenie mocy; ponowne kliknięcie rozbraja |
| **kliknięcie / dotknięcie planszy** | rzucenie uzbrojonej mocy we wskazane miejsce |
| **przeciągnięcie planszy** | przesuwanie kamery (domyślne zachowanie) |
| **Zwiń / Moce** (telefon) | zwijanie panelu mocy do cienkiego paska Lush |
| **kółko myszy** | zoom |
| **szczypnięcie dwoma palcami** | zoom na smartfonie |
| **PPM / środkowy przycisk + przeciąganie** | przesuwanie kamery |
| najechanie na człowieka | imię, wiek, płeć, stan |

Moc trzeba najpierw uzbroić, klikając jej kartę. Dopiero wtedy kliknięcie lub
dotknięcie planszy rzuca ją w wybrane miejsce. Po udanym rzucie moc
automatycznie się rozbraja, a plansza wraca do przesuwania mapy. Samo
przeciągnięcie planszy nigdy nie rzuca mocy.

Każda moc ma **siłę 1–3**, ustawianą pipsami na karcie. Siła zwiększa
obfitość efektu (zasięg, czas, liczbę ofiar) i podnosi koszt w Lush.
Domyślnie moc startuje na poziomie 1.

Piorun ma krótki cooldown i kosztuje Lush. Deszcz przywołuje chmurę na
kilkanaście sekund; woda spływa po zboczach i zbiera się w nieckach. Ludzie w
panice próbują uciec na wyższy grunt — ale nie zawsze zdążą.

Deszcz ma trzy oblicza. Poziom 1 to lekki kapuśniak: zostawia płytkie kałuże,
nawilża glebę i przyspiesza wzrost upraw, ale nie robi szkód. Poziom 2 to
ciężka ulewa, która zalewa zagłębienia i może podtopić plony. Poziom 3 to
oberwanie chmury: woda szybko przybiera, topi ludzi, wypłukuje pola i zmywa
domy.

Wiatr na poziomie 1 to lekki wiaterek: kołysze drzewami, gnie zboże i tylko
okazyjnie zrywa komuś ubranie. Poziom 2 to silny wiatr, który strąca dachy i
łamie pola, a poziom 3 — huragan, który wyrywa drzewa z korzeniami i zwiewa
całe domy. Rozebrana osoba staje zawstydzona, a po chwili biegnie do
najbliższej chaty i zakłada nowe ubranie.

## Lush — boska moc

Lush nie odradza się sam. Zbierasz go z życia ludzi:

- **panika** — każda przerażona osoba (ucieczka przed wodą, ogniem, gromem,
  deszczem) sączy Lush przez cały czas trwania paniki. Dzieci dają mniej,
  dorośli najwięcej, starsi nieco więcej niż dorośli.
- **śmierć** — jednorazowe żniwo zależne od przeżytych lat. Dorosły oddaje
  kilkadziesiąt Lush, dziecko tylko kilka, starszy nawet blisko stu.
- **pojemność** — zbiornik rośnie wraz z całym zebranym Lush (do limitu), więc
  dłuższa gra pozwala magazynować więcej mocy.

Nie ma pasywnej regeneracji do 100%. Gdy pasek jest pełny, nadmiar nie
zwiększa od razu zapasu, ale wlicza się w powiększanie pojemności. Zabicie
całej populacji daje szybki zastrzyk, ale odcina dopływ Lush — opłaca się
hodować ludzi, którzy w panice sączą moc powoli. W panelu mocy widać aktualny
Lush, pojemność i tempo zbierania; po najechaniu na człowieka widać jego żniwo
i chwilowy przyrost z paniki.

## Co jest w środku

```
index.html            # szkielet strony i HUD
styles.css            # wygląd interfejsu
config/game.json      # balans, moce, kolory, imiona, legenda kafelków
maps/world.json       # mapa świata (siatka znaków)
tools/generate-map.py # generator startowej mapy
src/
  main.js             # start aplikacji
  config.js           # wczytywanie i walidacja JSON
  game.js             # pętla gry, czas, integracja systemów
  map.js              # siatka terenu i kolizje
  water.js            # symulacja wody i topienie
  person.js           # fizyka, AI i cykl życia człowieka
  population.js       # narodziny, śmierć, dobieranie par
  housing.js          # ścinanie drzew, budowa chat i rodziny
  ladders.js          # drabiny pod zbyt wysokie skarpy
  crops.js            # pola uprawne, zapasy ziarna, głód i gnicie plonów
  memorials.js        # miejsca tragedii, żałoba i kopce z drewnianymi słupkami
  weather.js          # chmury deszczowe
  wind.js             # podmuchy wiatru, zniszczenia i zrywanie ubrań
  vegetation.js       # drzewa, pożary i wzrost po deszczu
  powers.js           # moce boga, Lush, cooldowny
  effects.js          # cząstki, pioruny, ślady
  renderer.js         # cała grafika 2D (teren rysowany w kawałkach)
  camera.js           # kamera, zoom, wstrząsy
  input.js            # klawiatura i mysz
  ui.js               # HUD, karty mocy, dymki, toasty
  audio.js            # proceduralny dźwięk (WebAudio)
```

Po uruchomieniu w konsoli przeglądarki dostępny jest obiekt `window.badgood`
(np. `badgood.population.people`, `badgood.housing.houses`, `badgood.crops.plots`, `badgood.memorials.sites`, `badgood.water.levels`, `badgood.setSpeed(4)`).

## Konfiguracja — `config/game.json`

Najważniejsze sekcje:

- `world` — rozmiar kafelka, grawitacja, limit ludności, kamera oraz
  `extraGroundRows`: ile dodatkowych warstw gruntu dorysować pod autorską mapą.
  Dzięki nim kamera może zjechać głębiej (przydatne na wąskich ekranach
  telefonów), a fizyka i woda widzą spójny, solidny grunt.
- `time` — długość doby (domyślnie 36 s), ile lat przybywa na dobę, prędkości
  czasu.
- `agents` — prędkości, wiek dorosłości i starości, długość życia, płodność,
  ciąża, szanse na poczęcie, topienie, panika, wiek dorosłego stroju kąpielowego
  oraz rytm doby: `dayStartHour`, `nightStartHour`, szanse na spacer i nocne
  odpoczynki, `nightSleepChance` (szansa na położenie się do snu), a także nocne
  spowolnienie. `maxWalkDropTiles` określa, jak wysokiej skarpy człowiek nie
  zejdzie dobrowolnie — chroni to ludzi przed spadaniem z powrotem do dołu po
  wyjściu po drabinie.
- `memorials` — progi i tempo żałoby: ile zgonów w jednym miejscu tworzy
  miejsce pamięci, jak daleko ludzie je dostrzegają, ile osób może się zebrać,
  jak długo trwa zbiórka i stawianie kopca oraz jakie wymiary ma drewniany słupek.
- `housing` — budowa domów: minimalna wysokość drzewa, ile drewna trzeba na
  chatę, czas ścinania i stawiania, ile osób mieszka w jednym domu, jak daleko
  szukać drzewa i miejsca pod budowę oraz z jakiej odległości nocą opłaca się
  wracać do domu. Tutaj też ustawia się czas palenia się chaty, szansę
  przeskoczenia ognia z lasu i na sąsiednie domy, jak mocna i długa ulewa
  zmywa budynek oraz jak głęboka woda (powódź) i jak szybko niszczy chatę.
- `ladders` — drabiny pod zbyt wysokie skarpy: ile drewna daje drzewo, ile
  kafelków wysokości pokrywa jedna kłoda, czas ścinania i wiązania, minimalna
  wysokość drzewa, maksymalna wysokość przeszkody, ile placów budowy może
  istnieć naraz, jak daleko szukać drzewa, po ilu nieudanych skokach zacząć
  pracę oraz od jakiego wieku i po jakim czasie ponowić próbę.
- `crops` — pola uprawne i głód: ilu mieszkańców przypada na jedno pole, ile pól
  może istnieć, jak szybko rośnie zboże, ile trwa siew i żniwa, ile ziarna daje
  jeden zbiór, jak często wioska zakłada nowe pola, jak szybko ludzie głodnieją
  i jedzą, przy jak niskich zapasach rzucają inne zajęcia, by ratować plony,
  oraz po jakim czasie głodu umierają. Tutaj też ustawia się tempo gnicia upraw
  w wodzie i czas wypalania pola przez ogień.
- `water` — tempo parowania, siła deszczu, szybkość przepływu. Tablice
  `rainVolumePerStrength` i `rainDamagePerStrength` określają, ile wody leje
  każdy poziom i od którego poziomu deszcz zaczyna niszczyć domy.
- `vegetation` — gęstość lasu, promień podpalenia, tempo rozprzestrzeniania
  ognia, czas spalania drzewa, kiełkowanie, tempo wzrostu sadzonek i bujność
  drzew po deszczu.
- `powers.list` — lista mocy. Każda ma `id`, koszt, cooldown, promień,
  ikonę i opis wyświetlany w HUD. Pola `strengthLevels`, `strengthDefault`,
  `costPerStrength`, `radiusPerStrength` i `durationPerStrength` opisują
  poziomy siły i to, jak rosną koszt, zasięg i czas działania.
- `wind` — zachowanie wiatru: napór na ludzi, szansa na panikę i zerwanie
  ubrania, wiek minimalny rozbieranych osób, czas wstydu, tempo niszczenia
  domów, próg zerwania dachu, łamanie upraw, wywracanie drzew i gęstość liści.
- `powers.lush` — ekonomia boskiej mocy: start, przyrost pojemności za zebrany
  Lush, limit zbiornika, tempo sączenia w panice oraz żniwo po śmierci
  (bazowe, za rok życia i mnożniki dla dzieci/starszych).
- `names` — imiona męskie i żeńskie.
- `theme` — palety terenu, lnianych ubrań i bielizny kąpielowej, haftu, skóry,
  nieba, wody oraz słomy i drewna chat. Deszcz korzysta z palety wody, więc
  krople, kałuże i jeziora mają wspólne kolory.
- `terrain.chunkSize` — rozmiar kawałka prerenderowanego terenu (domyślnie 512).
- `terrain.legend` — znaczenie znaków mapy i to, czy są solidne.

Zmiany w JSON są widoczne po odświeżeniu strony.

## Mapa — `maps/world.json`

Mapa to tablica `rows`; każdy znak to jeden kafelek, a wiersze idą z góry na dół.
Puste miejsce (`" "`) to niebo. Grunt rysuje się na podstawie pierwszego
solidnego kafelka w kolumnie.

Domyślne znaki:

| Znak | Znaczenie | Solidny |
| --- | --- | --- |
| ` ` | niebo | nie |
| `#` | ziemia / trawa | tak |
| `f` | las (ściółka + drzewa) | tak |
| `m` | skała / zbocze góry | tak |
| `s` | śnieżny szczyt | tak |
| `~` | woda (stałe jezioro) | nie |

Przykładowy fragment:

```json
"rows": [
  "        ",
  "   f    ",
  "  ###   ",
  " #####  ",
  "####### "
]
```

`spawn` wskazuje miejsce startu populacji:

```json
"spawn": { "x": 136, "y": 48, "radius": 12 }
```

- `x` — kolumna (w kafelkach),
- `radius` — rozrzut ludzi wokół kolumny.

### Nowe typy terenu

1. Dodaj znak do `terrain.legend` w `config/game.json`, np.:

   ```json
   "p": { "solid": true, "label": "piasek", "surface": "sand" }
   ```

2. Użyj go w `maps/world.json`.
3. W `renderer.js` w `_paintSurface` obsłuż nowy `surface` (albo użyj
   istniejącego: `grass`, `forest`, `rock`, `snow`).

Stała woda z mapy (`~`) jest oznaczona jako `fixedWater` i nie paruje.

### Generator mapy

Startowa mapa została wygenerowana skryptem (bez zależności):

```bash
python3 tools/generate-map.py --seed 20261023 --preview
```

Możesz zmienić parametry w `tools/generate-map.py` albo po prostu ręcznie
edytować `maps/world.json` — to zwykły, czytelny plik JSON.

## Jak działa symulacja

- **Stały krok** 1/60 s; prędkość czasu (1×/2×/4×) mnoży liczbę kroków.
- **Teren** jest prerenderowany do chunków 512×512 (rozmiar zmienia
  `terrain.chunkSize`) i podpięty do ukrytej warstwy w DOM (Firefox potrafi nie
  namalować odłączonego canvasu). Renderer sprawdza pierwszy piksel terenu i w
  razie problemu przełącza się na rysowanie kafelków bezpośrednio.
- **Ludzie** mają prostą fizykę AABB z grawitacją, wskakiwaniem na krawędź
  jednego kafelka i skokiem. AI przełącza stany: odpoczynek, sen, spacer,
  ucieczka, rozmowa i żałoba. Dzieci trzymają się matki, dorośli szukają
  partnerów, starsi zwalniają.
  Po panice ludzie schodzą z wysokiego gruntu, unikają tłoku i czasem wybierają
  dalszy cel, więc nie osiadają na stałe na jednym szczycie czy skraju mapy.
- **Rytm doby**: doba trwa 36 sekund, więc ludzie mają więcej czasu na
  wędrówki i pracę. W dzień chętniej spacerują i szybciej wybierają nowe cele.
  Nocą zwalniają, kładą się i śpią na ziemi (albo w domu), a tylko wyjątkowo
  wychodzą na krótki spacer. Zmierzch kończy dłuższe wędrówki i przerywa
  budowę, a świt budzi śpiących.
- **Domy**: bezdomni dorośli wybierają się do lasu i ścinają drzewa. Drzewo
  musi być odpowiednio wysokie — zbyt młode sadzonki się nie nadają. Po
  zebraniu drewna budowniczy wybiera losowy, równy skrawek ziemi, karczuje plac
  i stawia chatę. Gotowy dom dostaje rodzinę: budowniczego, partnera, dzieci
  oraz kilku najbliższych bezdomnych. Ludzie z domem nocą wracają do środka,
  chyba że zapuścili się zbyt daleko — wtedy śpią tam, gdzie zastanie ich noc.
  Dzieci dziedziczą dom po matce, a bezdomni partnerzy i młodzi dorośli
  wprowadzają się do rodziny, jeśli jest miejsce.
- **Ogień, ulewa i powódź**: piorun albo ogień z lasu potrafi podpalić chatę.
  Płonący dom ogarniają płomienie, a mieszkańcy budzą się i w panice wybiegają
  na zewnątrz; po wypaleniu zostają tylko zgliszcza. Mocna ulewa stopniowo
  podmywa dom — chata przechyla się, nasiąka wodą, aż w końcu znika, a jej
  mieszkańcy znów są bezdomni. Gdy woda z deszczu zbierze się przy domu na
  tyle wysoko, że tworzy powódź, budynek niszczeje jeszcze szybciej. Ogień może
  przeskoczyć na sąsiednie chaty, więc gęsta zabudowa jest ryzykowna.
- **Drabiny**: czasem ktoś trafi na zbyt wysoką skarpę i skacze pod nią bez
  skutku. Po kilku nieudanych próbach idzie do najbliższego wysokiego drzewa
  (na tym samym poziomie, bez głębokiej wody), ścina je i znosi drewno pod
  ścianę. Im wyższa przeszkoda, tym więcej drewna i dłuższa drabina, ale
  jedno ścięte drzewo daje dość drewna na krótszą drabinę. Gdy w zasięgu nie
  ma żadnego odpowiedniego drzewa, drabina powstaje z gałęzi i korzeni —
  trwa to dłużej (około trzech razy), ale nigdy nie przepada, więc utknięty
  człowiek w końcu i tak ją zbuduje. Gotowa drabina zostaje w terenie i może
  jej użyć każdy inny człowiek, także dziecko, w dzień i w nocy, i to w obie
  strony: do wejścia na skarpę i do zejścia z niej. Praca nocą czeka do
  świtu, ale korzystanie z już stojącej drabiny nie jest niczym ograniczone.
- **Uprawy i głód**: wioska zakłada pola zbóż w pobliżu chat — im więcej
  mieszkańców, tym więcej pól i rąk do pracy. Ludzie sieją, czekają na wzrost
  i zbierają plony do wspólnych zapasów ziarna. Nadwyżka pozwala przetrwać
  gorsze dni, a każdy głodny mieszkaniec zjada porcję ze spichlerza. Gdy ogień
  (piorun albo pożar lasu) wypala pole, a woda zalewa i gnije uprawy, pola
  znikają, ale skrawek ziemi pozostaje — wioska obsiewa go od nowa, więc
  jedna wichura nie odbiera jej pól na zawsze. Gdy zapasy spadną poniżej progu
  `urgentFood`, wszystkie wolne ręce idą ratować dojrzałe zboże, nawet ponad
  zwykły limit pracowników. Jeśli zapasy mimo to się wyczerpią, ludzie
  głodnieją, a po dłuższym czasie bez jedzenia zaczynają umierać z głodu.
- **Miejsca pamięci**: gdy w krótkim czasie w jednym miejscu ginie kilka osób,
  ocalali czekają, aż opadnie panika (i wstanie dzień). Wtedy schodzą się przy
  miejscu tragedii, stoją tam chwilę w milczeniu i usypują mały kopiec z
  drewnianym słupkiem przodków. Kopiec zostaje w dolinie i upamiętnia to
  miejsce.
- **Bożki i kult**: gdy w krótkim czasie ludzie oddają dużo Lush, z ziemi
  wyrasta rzeźbiony drewniany bożek. Słup wynurza się wśród pyłu, a najbliżsi
  dorośli idą do niego i klękają w półkolu. Modlą się z rytmicznym pokłonem,
  złożonymi dłońmi i złotym błyskiem między rękami; bożka zdobią świecące runy,
  słoneczny znak, rzeźbiona twarz i unoszące się iskry. Po obrzędzie bożek
  zostaje w dolinie. Jeśli w tym regionie znów nagromadzi się Lush, nie
  powstaje drugi słup — ludzie gromadzą się przy istniejącym. Nowy bożek może
  stanąć dopiero poza promieniem `monoliths.minSpacingTiles`. Pojedynczy
  ludzie odwiedzają go także w ciągu dnia, a nocą kult ustaje.
- **Koniec gry**: gdy zginie ostatni mieszkaniec, nie zostaje nikt, kto czciłby
  boga. Symulacja zatrzymuje się, a na ekranie pojawia się podsumowanie
  (dni w dolinie, liczba zmarłych, zebrany Lush oraz zbudowanych drabin) oraz
  przycisk rozpoczęcia od nowa.
- **Woda** to siatka poziomów 0..1. Deszcz dolewa wodę do najwyższych kafelków
  w kolumnie, woda spada w dół i wyrównuje poziom w poziomie. Paruje, więc
  jeziora z deszczu są czasowe. Gdy lustro wody znajdzie się nad głową,
  człowiek tonie po kilku sekundach. Po wejściu do wody ludzie przebierają się
  w stroje kąpielowe: dorosłe kobiety w bikini, dorośli mężczyźni w slipy,
  dzieci w kostium jednoczęściowy lub kąpielówki.
- **Piorun** zabija ludzi w promieniu uderzenia, zostawia wypalony ślad,
  wywołuje panikę w okolicy, podpala drzewa i pola uprawne. Ogień może przenieść
  się na sąsiednie korony, a spalone drzewa i zboża zamieniają się w popiół
  i wypaloną ziemię.
- **Deszcz** to chmura o ograniczonym czasie życia; jej woda realnie zasila
  symulację, a nie jest tylko efektem wizualnym. Drzewa w zasięgu chmury stają
  się bujniejsze, a w wolnych miejscach kiełkują nowe sadzonki. Zalane pola
  gniją i po chwili znikają, więc ulewa potrafi zniszczyć całe tegoroczne plony.
- **Wiatr** niesie liście i pył, ugina drzewa, gnie łodygi zbóż i napiera na
  ludzi. Silniejsze podmuchy strącają dachy, łamią pola i mogą zwiać całą
  chatę. Lekki wiaterek potrafi zerwać ubranie dorosłej osobie: ta staje
  zawstydzona, a potem biegnie do najbliższego domu po nowe. Jeśli drogę
  zamyka skarpa, korzysta z gotowej drabiny albo buduje ją po drodze.
  Gdy w wiosce nie ma jeszcze żadnego domu, pozostaje bez ubrania i szuka,
  aż jakiś powstanie.

## Rozbudowa

Miejsca, w których najłatwiej dodać kolejne funkcje:

- **Nowa moc boga** — dopisz wpis do `powers.list`, obsłuż jej `id` w
  `Powers.cast()` (nowy efekt w `effects.js` lub `weather.js`) i dodaj ikonę.
  HUD zbuduje kartę automatycznie.
- **Nowe zachowanie ludzi** — rozszerz `Person._think()` o nowy stan, np.
  pracę, kult, modlitwę, ucieczkę do domu.
- **Nowe obiekty świata** — dodaj warstwę obiektów do `maps/world.json`
  (ołtarze, plony, studnie) i wczytuj ją w `WorldMap`.
- **Religia i moralność** — ludzie mogą zacząć czcić złego boga albo próbować
  go przebłagać; strach i śmierć już zasilają Lush, więc kult mógłby zmieniać
  jego tempo.
- **Zapis stanu** — serializacja `population.people`, `water.levels`, czasu i
  Lush do `localStorage`.

## Pomysły na dalszy rozwój

- susza, trzęsienia ziemi, zaraza;
- rozbudowa ognia: wiatr, dym, ucieczka ludzi przed pożarem;
- ofiary, kapliczki, kapłani;
- rozbudowa wsi: studnie, płoty, warsztaty, spichlerze i młyny;
- drapieżniki, zwierzęta hodowlane;
- zmienne pory roku i wpływ pogody na plony;
- tryb „dobry bóg” z błogosławieństwami i uzdrowieniami;
- edytor mapy w przeglądarce.
