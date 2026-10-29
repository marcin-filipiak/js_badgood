const CONFIG_PATH = "config/game.json";
const MAP_PATH = "maps/world.json";

async function loadJson(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function validate(config, map) {
  if (!config.world || !config.agents || !config.powers || !config.terrain) {
    throw new Error("config/game.json nie zawiera wymaganych sekcji.");
  }
  if (!Array.isArray(map.rows) || map.rows.length === 0) {
    throw new Error("maps/world.json nie zawiera siatki 'rows'.");
  }
  if (!Array.isArray(config.powers.list) || config.powers.list.length === 0) {
    throw new Error("Brak zdefiniowanych mocy w config/game.json.");
  }
  const legend = config.terrain.legend;
  const unknown = new Set();
  for (const row of map.rows) {
    for (const ch of row) {
      if (!legend[ch]) unknown.add(ch);
    }
  }
  if (unknown.size) {
    console.warn(
      `Unknown map tiles: ${[...unknown].join(", ")} — treated as empty space.`
    );
  }
  return { config, map };
}

export async function loadGameData() {
  const [config, map] = await Promise.all([loadJson(CONFIG_PATH), loadJson(MAP_PATH)]);
  return validate(config, map);
}
