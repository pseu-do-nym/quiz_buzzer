/* ゲームルールと状態管理。通信を追加する際は、この状態更新を共有側へ移します。 */
const GAME_CONFIG = {
  cooldownMs: 500,
  resetTimeoutMs: 30_000,
  maxHistory: 5,
  correctPoints: 1,
  incorrectPoints: 0
};

function createInitialState() {
  return {
    phase: "ready", // ready | active | ended
    host: null,
    currentAnswer: null,
    history: [],
    scores: {},
    questionStartedAt: null,
    lastActionAt: 0
  };
}

const game = {
  state: createInitialState(),

  ensurePlayer(name) {
    const player = cleanName(name);
    if (!(player in this.state.scores)) this.state.scores[player] = 0;
    return player;
  },

  canStart(name) {
    return this.state.phase === "ready" || this.state.phase === "ended";
  },

  startQuestion(name) {
    const player = this.ensurePlayer(name);
    if (!this.canStart(player)) return { ok: false, message: "現在の問題が進行中です。" };
    this.state.phase = "active";
    this.state.host = player;
    this.state.currentAnswer = null;
    this.state.history = [];
    this.state.questionStartedAt = Date.now();
    return { ok: true, message: `${player}さんが出題しました。` };
  },

  canBuzz(name) {
    const player = cleanName(name);
    return this.state.phase === "active" &&
      this.state.currentAnswer === null &&
      player !== this.state.host;
  },

  buzz(name) {
    const player = this.ensurePlayer(name);
    if (!this.canBuzz(player)) {
      return { ok: false, message: player === this.state.host
        ? "出題者は回答できません。"
        : "現在は早押しできません。" };
    }
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: player,
      result: "pending",
      time: new Date()
    };
    this.state.history.unshift(entry);
    this.state.history = this.state.history.slice(0, GAME_CONFIG.maxHistory);
    this.state.currentAnswer = entry.id;
    return { ok: true, message: `${player}さんが回答中です。` };
  },

  canJudge(name) {
    return this.state.phase === "active" &&
      this.state.host === cleanName(name) &&
      this.state.currentAnswer !== null;
  },

  judge(name, result) {
    if (!this.canJudge(name)) return { ok: false, message: "出題者本人が回答中の人を判定してください。" };
    const entry = this.state.history.find(item => item.id === this.state.currentAnswer);
    if (!entry) {
      this.state.currentAnswer = null;
      return { ok: false, message: "回答履歴が見つかりません。状態を確認してください。" };
    }
    entry.result = result;
    if (result === "correct") {
      this.state.scores[entry.name] = (this.state.scores[entry.name] || 0) + GAME_CONFIG.correctPoints;
      this.state.phase = "ended";
    }
    // 不正解の場合は問題を継続し、次の早押しを受け付ける。
    this.state.currentAnswer = null;
    return { ok: true, message: result === "correct"
      ? `${entry.name}さんが正解。問題終了です。`
      : `${entry.name}さんは不正解。次の回答者を受け付けます。` };
  },

  canReset(name) {
    if (this.state.phase !== "active") return false;
    const isHost = this.state.host === cleanName(name);
    const timedOut = this.state.questionStartedAt !== null &&
      Date.now() - this.state.questionStartedAt >= GAME_CONFIG.resetTimeoutMs;
    return isHost || timedOut;
  },

  resetQuestion(name) {
    if (!this.canReset(name)) {
      return { ok: false, message: "問題リセットは出題者、または出題開始から30秒経過後に実行できます。" };
    }
    this.state.phase = "ready";
    this.state.host = null;
    this.state.currentAnswer = null;
    this.state.history = [];
    this.state.questionStartedAt = null;
    return { ok: true, message: "問題をリセットしました。得点は維持されます。" };
  },

  resetAll() {
    this.state = createInitialState();
  }
};

function cleanName(value) {
  const trimmed = String(value || "").trim().slice(0, 20);
  return trimmed || "名無し";
}
