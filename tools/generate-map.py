#!/usr/bin/env python3
"""Generator startowej mapy Bad Good.

Mapa jest zwykłym plikiem JSON z siatką znaków. Po wygenerowaniu można ją
swobodnie ręcznie edytować w maps/world.json -- generator służy tylko jako
wygodny punkt startowy.

Użycie:
    python3 tools/generate-map.py [--seed 20261023] [--out maps/world.json]
"""

import argparse
import json
import math
import random

WIDTH = 260
HEIGHT = 64
SEED = 20261023


def smooth_noise(rng, n, octaves=3):
    """Gładki szum 1D złożony z losowych sinusów (deterministyczny dla seeda)."""
    waves = []
    for o in range(octaves):
        freq = rng.uniform(0.02, 0.06) * (1.8 ** o)
        phase = rng.uniform(0, math.tau)
        amp = rng.uniform(0.4, 1.0) / (1.5 ** o)
        waves.append((freq, phase, amp))

    def sample(x):
        return sum(a * math.sin(x * f + p) for f, p, a in waves)

    return sample


def build_map(seed=SEED):
    rng = random.Random(seed)
    noise = smooth_noise(rng, WIDTH, octaves=4)
    mid_noise = smooth_noise(rng, WIDTH, octaves=2)

    surface = []
    for x in range(WIDTH):
        y = 48.0
        y += noise(x) * 3.2
        y += mid_noise(x * 1.7) * 1.8
        # dwa pasma górskie
        y -= 17.0 * math.exp(-((x - 42) / 21.0) ** 2)
        y -= 15.0 * math.exp(-((x - 226) / 24.0) ** 2)
        # łagodne wzgórza po bokach, żeby świat nie był płaski
        y -= 5.0 * math.exp(-((x - 15) / 15.0) ** 2)
        y -= 4.0 * math.exp(-((x - 175) / 26.0) ** 2)
        surface.append(int(round(y)))

    # --- Dolina wioski: płaski, bezpieczny plac --------------------------
    village_x = 136
    for x in range(village_x - 14, village_x + 15):
        t = abs(x - village_x) / 15.0
        # wygładzenie do poziomu 48
        surface[x] = int(round(48 + (surface[x] - 48) * (t ** 1.4)))

    # --- Miska na deszczowe jezioro (płytka, po lewej) -------------------
    for x in range(78, 101):
        t = abs(x - 89.5) / 11.5
        carve = int(round(7.5 * (1 - t ** 2)))
        surface[x] += carve

    # --- Głęboka miska z wysokim brzegiem (pułapka na deszcz) -----------
    for x in range(188, 215):
        t = abs(x - 201.5) / 13.5
        carve = int(round(10.5 * (1 - t ** 2)))
        surface[x] += carve
    # podnieś brzegi, by woda miała gdzie się zbierać
    for x in range(183, 189):
        surface[x] -= 2
    for x in range(215, 221):
        surface[x] -= 2

    # --- Stałe jezioro w zagłębieniu (ręcznie ukształtowana niecka) ------
    lake_center = 62
    lake_level = 50
    for x in range(lake_center - 10, lake_center + 11):
        t = abs(x - lake_center) / 11.0
        surface[x] = int(round(54 + 3 * (1 - t ** 2) - 7 * (t ** 1.7)))
        surface[x] = max(surface[x], 49)
    # woda wypełni wszystkie pola poniżej poziomu jeziora
    lake_cols = set(range(lake_center - 8, lake_center + 9))

    # --- Lasy ------------------------------------------------------------
    forest = [False] * WIDTH
    forest_noise = smooth_noise(rng, WIDTH, octaves=3)
    for x in range(WIDTH):
        if surface[x] > 30:  # tylko niżej niż skalne szczyty
            near_village = abs(x - village_x) < 16
            lake_shore = x in lake_cols
            forest[x] = (not near_village and not lake_shore and
                         forest_noise(x * 0.9) + 0.35 >
                         0.25 + 0.15 * math.sin(x * 0.07))

    # --- Siatka znaków ---------------------------------------------------
    grid = [[" " for _ in range(WIDTH)] for _ in range(HEIGHT)]
    for x in range(WIDTH):
        s = surface[x]
        for y in range(s, HEIGHT):
            if y < 29 and s <= 32:
                char = "m"  # skalne wnętrze góry
            else:
                char = "#"
            grid[y][x] = char
        # powierzchnia
        if s <= 24:
            grid[s][x] = "s"  # śnieżny szczyt
        elif s <= 33:
            grid[s][x] = "m"  # naga skała
        elif forest[x]:
            grid[s][x] = "f"  # ściółka leśna
        else:
            grid[s][x] = "#"

        # stałe jezioro
        if x in lake_cols:
            for y in range(lake_level, s):
                grid[y][x] = "~"

    # --- Mała wysepka i kamienie dla uroku -------------------------------
    # (dekoracje są rysowane proceduralnie na podstawie terenu)

    rows = ["".join(row) for row in grid]

    # Upewnij się, że krawędzie świata są skalne (miękkie ściany).
    for y in range(HEIGHT):
        for x in list(range(0, 3)) + list(range(WIDTH - 3, WIDTH)):
            if rows[y][x] == " " and y > 22:
                rows[y] = rows[y][:x] + "m" + rows[y][x + 1:]

    return {
        "name": "Dolina Zapomnianych",
        "_edit": (
            "Mapa: każdy znak to kafelek. ' ' niebo, '#' ziemia/trawa, "
            "'f' las, 'm' skała, 's' śnieg, '~' woda. "
            "Opisy i kolory kafelków znajdują się w config/game.json."
        ),
        "tileSize": 18,
        "spawn": {"x": village_x, "y": surface[village_x], "radius": 12},
        "rows": rows,
        "meta": {"generator": "tools/generate-map.py", "seed": seed},
    }


def preview(rows, step_x=3, step_y=2):
    for y in range(0, len(rows), step_y):
        line = "".join(rows[y][x] for x in range(0, len(rows[0]), step_x))
        print(line.rstrip())


def main():
    parser = argparse.ArgumentParser(description="Generuje maps/world.json")
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--out", default="maps/world.json")
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()

    data = build_map(args.seed)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"Zapisano {args.out}: {len(data['rows'][0])} x {len(data['rows'])} kafelków")
    if args.preview:
        preview(data["rows"])


if __name__ == "__main__":
    main()
