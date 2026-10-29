import { loadGameData } from "./config.js?v=20261046-1";
import { Game } from "./game.js?v=20261046-1";

// Błędy poza pętlą gry (np. w obsłudze zdarzeń) nie mogą kończyć się tylko
// wpisem w konsoli. Pokazujemy ten sam pasek, co dla błędów klatek.
function reportRuntimeError(error) {
  const game = window.badgood;
  if (!game?.ui?.showRuntimeError) return;
  try {
    game.ui.showRuntimeError(error instanceof Error ? error : new Error(String(error)));
  } catch (uiError) {
    console.error(uiError);
  }
}

window.addEventListener("error", (event) => {
  // Zasoby (skrypty, obrazy) mają własną obsługę w index.html.
  if (!event.error && event.target && event.target !== window) return;
  reportRuntimeError(event.error || new Error(event.message || "Nieznany błąd"));
});
window.addEventListener("unhandledrejection", (event) => {
  reportRuntimeError(event.reason ?? new Error("Nieobsłużone odrzucenie obietnicy"));
});

async function boot() {
  const canvas = document.getElementById("game");
  try {
    const { config, map } = await loadGameData();
    const game = new Game(canvas, config, map);
    game.startLoop();
    window.badgood = game;
    window.__badgoodReady?.();
  } catch (error) {
    console.error(error);
    const isFile = location.protocol === "file:";
    const message = isFile
      ? "Pliki JSON są blokowane przy otwieraniu z dysku. Uruchom lokalny serwer: <code>python3 -m http.server</code>, a potem otwórz <code>http://localhost:8000</code>."
      : `Nie udało się wczytać świata: ${error.message}`;
    if (window.__badgoodError) {
      window.__badgoodError(message);
      return;
    }
    const intro = document.getElementById("intro");
    const fatal = document.getElementById("fatal");
    const messageEl = document.getElementById("fatal-message");
    if (intro) intro.classList.add("hidden");
    if (fatal) fatal.classList.remove("hidden");
    if (messageEl) messageEl.innerHTML = message;
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
