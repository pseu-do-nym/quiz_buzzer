const GAME_CONFIG = {
  cooldownMs: 500,
  resetTimeoutMs: 30_000,
  maxHistory: 5,
  correctPoints: 1,
  incorrectPoints: 0
};

function cleanName(value) {
  const trimmed = String(value || "").trim().slice(0, 20);
  return trimmed || "名無し";
}