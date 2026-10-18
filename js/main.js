const $ = selector => document.querySelector(selector);
let lastBuzzerAt = 0;
let lastHostActionAt = 0;

const usernameInput = $("#username");
const buzzerButton = $("#buzzer-button");
const questionButton = $("#question-button");
const correctButton = $("#correct-button");
const incorrectButton = $("#incorrect-button");
const resetQuestionButton = $("#reset-question-button");
const resetAllButton = $("#reset-all");
const resetDialog = $("#confirm-dialog");
const confirmResetButton = $("#confirm-reset");

populateSoundSelectors();
usernameInput.addEventListener("input", render);
render();

function currentUser() {
  return cleanName(usernameInput.value);
}

function actionAllowed(lastAt) {
  return Date.now() - lastAt >= GAME_CONFIG.cooldownMs;
}

buzzerButton.addEventListener("click", () => {
  if (!actionAllowed(lastBuzzerAt)) return;
  lastBuzzerAt = Date.now();

  const result = game.buzz(currentUser());
  showMessage(result.message);
  if (result.ok) {
    playSound("buzzer");
    buzzerButton.classList.add("is-pressed");
    window.setTimeout(() => buzzerButton.classList.remove("is-pressed"), 140);
  }
  render();
});

questionButton.addEventListener("click", () => {
  if (!actionAllowed(lastHostActionAt)) return;
  lastHostActionAt = Date.now();
  const result = game.startQuestion(currentUser());
  showMessage(result.message);
  if (result.ok) {
    playSound("question");
    // 30秒経過時にリセット権限を再描画して反映する。
    window.setTimeout(render, GAME_CONFIG.resetTimeoutMs + 20);
  }
  render();
});

correctButton.addEventListener("click", () => judge("correct", "correct"));
incorrectButton.addEventListener("click", () => judge("incorrect", "incorrect"));

function judge(result, soundType) {
  if (!actionAllowed(lastHostActionAt)) return;
  lastHostActionAt = Date.now();
  const outcome = game.judge(currentUser(), result);
  showMessage(outcome.message);
  if (outcome.ok) playSound(soundType);
  render();
}

resetQuestionButton.addEventListener("click", () => {
  const outcome = game.resetQuestion(currentUser());
  showMessage(outcome.message);
  render();
});

resetAllButton.addEventListener("click", () => {
  if (typeof resetDialog.showModal === "function") resetDialog.showModal();
  else if (window.confirm("ゲーム全体を初期化しますか？")) resetAll();
});

confirmResetButton.addEventListener("click", event => {
  // dialog の submit より前に、確認ボタンを押した場合だけ初期化する。
  event.preventDefault();
  resetAll();
  resetDialog.close();
});

function resetAll() {
  game.resetAll();
  showMessage("ゲーム全体を初期化しました。");
  render();
}

function showMessage(message) {
  $("#game-status").textContent = message;
}

function render() {
  const state = game.state;
  const user = currentUser();
  const isHost = state.host === user;
  const active = state.phase === "active";
  const hasAnswer = state.currentAnswer !== null;
  const canStart = state.phase === "ready" || state.phase === "ended";
  const canReset = game.canReset(user);

  questionButton.disabled = !canStart;
  correctButton.disabled = !(active && hasAnswer && isHost);
  incorrectButton.disabled = !(active && hasAnswer && isHost);
  resetQuestionButton.disabled = !canReset;
  buzzerButton.disabled = !game.canBuzz(user);

  $("#host-label").textContent = `出題者：${state.host || "未設定"}`;

  if (state.phase === "ready") {
    $("#buzzer-message").textContent = "出題開始後に回答できます";
    if (!$("#game-status").textContent || $("#game-status").textContent.startsWith("出題者")) {
      $("#game-status").textContent = "出題可能です。出題ボタンを押してください。";
    }
  } else if (state.phase === "ended") {
    $("#buzzer-message").textContent = "正解により問題終了。出題者は次の問題を開始できます";
  } else if (hasAnswer) {
    const answer = state.history.find(item => item.id === state.currentAnswer);
    $("#buzzer-message").textContent = answer ? `${answer.name}さんが回答中` : "回答判定待ち";
  } else {
    $("#buzzer-message").textContent = "回答者を受け付けています";
  }

  renderHistory();
  renderScores();
}

function renderHistory() {
  const list = $("#history-list");
  list.replaceChildren();
  if (game.state.history.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = "まだ回答はありません";
    list.append(li);
    return;
  }

  game.state.history.forEach(entry => {
    const li = document.createElement("li");
    li.className = entry.result === "correct" ? "correct"
      : entry.result === "incorrect" ? "incorrect"
      : entry.id === game.state.currentAnswer ? "current" : "";
    const time = entry.time.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    li.append(document.createTextNode(`${entry.name}　${time}`));
    const result = document.createElement("span");
    result.className = "result";
    result.textContent = entry.result === "correct" ? "正解"
      : entry.result === "incorrect" ? "不正解" : "回答中";
    li.append(result);
    list.append(li);
  });
}

function renderScores() {
  const list = $("#score-list");
  list.replaceChildren();
  const entries = Object.entries(game.state.scores)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"));
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = "得点はまだありません";
    list.append(li);
    return;
  }
  entries.forEach(([name, score], index) => {
    const li = document.createElement("li");
    li.append(document.createTextNode(`${index + 1}位　${name}`));
    const value = document.createElement("span");
    value.className = "score-value";
    value.textContent = `${score}点`;
    li.append(value);
    list.append(li);
  });
}

function populateSoundSelectors() {
  document.querySelectorAll("[data-sound-select]").forEach(select => {
    const type = select.dataset.soundSelect;
    select.replaceChildren();

    (SOUND_LIST[type] || []).forEach((item, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = item.name;
      select.append(option);
    });

    select.addEventListener("change", () => {
      audioSettings[type] = Number(select.value);
    });
  });
}