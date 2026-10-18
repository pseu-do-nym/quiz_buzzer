const $ = selector => document.querySelector(selector);

const usernameInput = $("#username");
const buzzerButton = $("#buzzer-button");
const questionButton = $("#question-button");
const correctButton = $("#correct-button");
const incorrectButton = $("#incorrect-button");
const resetQuestionButton = $("#reset-question-button");
const resetAllButton = $("#reset-all");
const resetDialog = $("#confirm-dialog");
const confirmResetButton = $("#confirm-reset");
const createRoomDialog = $("#create-room-dialog");
const confirmCreateRoomButton = $("#confirm-create-room");

const createRoomButton = $("#create-room-button");
const joinRoomButton = $("#join-room-button");
const leaveRoomButton = $("#leave-room-button");
const roomCodeInput = $("#room-code-input");

let supabaseClient = null;
let currentUserId = null;
let authReady = false;

let currentRoomId = localStorage.getItem("quiz-buzzer-room-id");
let currentRoomCode = localStorage.getItem("quiz-buzzer-room-code") || "";

let currentSnapshot = null;
let realtimeChannel = null;
let refreshRunning = false;
let refreshPending = false;

populateSoundSelectors();
render();

function currentUserName() {
  return cleanName(usernameInput.value);
}

function showMessage(message) {
  $("#game-status").textContent = message;
}

function showRoomMessage(message) {
  $("#room-status").textContent = message;
}

function showConnectionMessage(message) {
  $("#connection-status").textContent = message;
}

function setBusy(busy) {
  createRoomButton.disabled = busy || !authReady || Boolean(currentRoomId);
  joinRoomButton.disabled = busy || !authReady || Boolean(currentRoomId);
  leaveRoomButton.disabled = busy || !currentRoomId;
}

// --------------------------------------------------
// Supabase初期化・匿名ログイン
// --------------------------------------------------

async function initialize() {
  if (
    !window.supabase ||
    !window.SUPABASE_URL ||
    !window.SUPABASE_PUBLISHABLE_KEY ||
    window.SUPABASE_URL.includes("ここに") ||
    window.SUPABASE_PUBLISHABLE_KEY.includes("ここに")
  ) {
    showConnectionMessage(
      "接続設定が未完了です。js/supabase-config.js を確認してください。"
    );
    return;
  }

  try {
    supabaseClient = window.supabase.createClient(
      window.SUPABASE_URL,
      window.SUPABASE_PUBLISHABLE_KEY
    );

    const { data: sessionData, error: sessionError } =
      await supabaseClient.auth.getSession();

    if (sessionError) throw sessionError;

    let session = sessionData.session;

    if (!session) {
      const { data, error } =
        await supabaseClient.auth.signInAnonymously();

      if (error) throw error;
      session = data.session;
    }

    if (!session?.user) {
      throw new Error("匿名ログインに失敗しました。");
    }

    currentUserId = session.user.id;
    authReady = true;

    showConnectionMessage("Supabase接続済み（匿名ログイン）");
    setBusy(false);

    if (currentRoomId) {
      $("#room-code-input").value = currentRoomCode;
      $("#room-info").hidden = false;
      usernameInput.disabled = true;
      showRoomMessage("保存されたルームに再接続しています……");
      startRealtime();
      await refreshRoom();
    } else {
      showRoomMessage("ルームを作成するか、参加コードを入力してください。");
      render();
    }
  } catch (error) {
    console.error("初期化エラー:", error);
    showConnectionMessage(`接続エラー：${error.message}`);
    setBusy(false);
  }
}

// --------------------------------------------------
// ルーム作成・参加
// --------------------------------------------------

createRoomButton.addEventListener("click", () => {
  if (!authReady || currentRoomId) return;

  if (typeof createRoomDialog.showModal === "function") {
    createRoomDialog.showModal();
  } else if (window.confirm("新しいルームを作成しますか？")) {
    createRoom();
  }
});

confirmCreateRoomButton.addEventListener("click", async event => {
  event.preventDefault();
  createRoomDialog.close();
  await createRoom();
});

async function createRoom() {
  if (!authReady || currentRoomId) return;

  setBusy(true);

  try {
    const name = currentUserName();

    const { data, error } = await supabaseClient.rpc(
      "quiz_create_room",
      { p_name: name }
    );

    if (error) throw error;

    const room = Array.isArray(data) ? data[0] : data;

    if (!room?.created_room_id || !room?.created_room_code) {
      throw new Error("ルーム作成結果を読み取れませんでした。");
    }

    usernameInput.value = name;

    await activateRoom(
      room.created_room_id,
      room.created_room_code
    );

    showRoomMessage(
      "ルームを作成しました。参加コードを共有してください。"
    );
  } catch (error) {
    console.error("ルーム作成エラー:", error);
    showRoomMessage(`ルーム作成失敗：${error.message}`);
  } finally {
    setBusy(false);
    render();
  }
}

joinRoomButton.addEventListener("click", async () => {
  if (!authReady || currentRoomId) return;

  const code = roomCodeInput.value.trim().toUpperCase();

  if (!/^[A-Z0-9]{6}$/.test(code)) {
    showRoomMessage("参加コードは半角英数字6文字で入力してください。");
    return;
  }

  setBusy(true);

  try {
    const name = currentUserName();

    const { data, error } = await supabaseClient.rpc(
      "quiz_join_room",
      {
        p_room_code: code,
        p_name: name
      }
    );

    if (error) throw error;

    // このRPCはルームID（UUID）を返す想定。
    const roomId = data;

    if (typeof roomId !== "string" || !roomId) {
      throw new Error("参加結果を読み取れませんでした。");
    }

    usernameInput.value = name;

    await activateRoom(roomId, code);

    showRoomMessage("ルームに参加しました。");
  } catch (error) {
    console.error("ルーム参加エラー:", error);
    showRoomMessage(`ルーム参加失敗：${error.message}`);
  } finally {
    setBusy(false);
    render();
  }
});

async function activateRoom(roomId, roomCode) {
  await stopRealtime();

  currentRoomId = roomId;
  currentRoomCode = String(roomCode).toUpperCase();
  currentSnapshot = null;

  localStorage.setItem("quiz-buzzer-room-id", currentRoomId);
  localStorage.setItem("quiz-buzzer-room-code", currentRoomCode);

  roomCodeInput.value = currentRoomCode;
  usernameInput.disabled = true;
  $("#room-info").hidden = false;
  $("#room-code-display").textContent = currentRoomCode;

  startRealtime();
  await refreshRoom();
}

leaveRoomButton.addEventListener("click", async () => {
  if (!currentRoomId || !authReady) return;

  if (!window.confirm("このルームから退室しますか？")) {
    return;
  }

  const roomId = currentRoomId;
  leaveRoomButton.disabled = true;

  try {
    const { data, error } = await supabaseClient.rpc(
      "quiz_leave_room",
      { p_room_id: roomId }
    );

    if (error) throw error;

    if (data && typeof data === "object" && data.ok === false) {
      throw new Error(data.message || "退室できませんでした。");
    }

    await stopRealtime();

    currentRoomId = null;
    currentRoomCode = "";
    currentSnapshot = null;

    localStorage.removeItem("quiz-buzzer-room-id");
    localStorage.removeItem("quiz-buzzer-room-code");

    usernameInput.disabled = false;
    $("#room-info").hidden = true;

    showRoomMessage("退室しました。ルームは削除されていません。");
    showMessage("ルームに参加してください。");

    render();
  } catch (error) {
    console.error("退室エラー:", error);
    showRoomMessage(`退室失敗：${error.message}`);
    leaveRoomButton.disabled = false;
  }
});

// --------------------------------------------------
// Realtime購読
// --------------------------------------------------

async function stopRealtime() {
  if (!realtimeChannel || !supabaseClient) return;

  const oldChannel = realtimeChannel;
  realtimeChannel = null;

  await supabaseClient.removeChannel(oldChannel);
}

function startRealtime() {
  if (!supabaseClient || !currentRoomId) return;

  // 同じルームへの重複購読を防ぐ。
  if (realtimeChannel) {
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  const roomId = currentRoomId;

  realtimeChannel = supabaseClient
    .channel(`quiz-room-${roomId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "quiz_rooms",
        filter: `id=eq.${roomId}`
      },
      () => refreshRoom()
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "quiz_members",
        filter: `room_id=eq.${roomId}`
      },
      () => refreshRoom()
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "quiz_game_state",
        filter: `room_id=eq.${roomId}`
      },
      () => refreshRoom()
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "quiz_answer_history",
        filter: `room_id=eq.${roomId}`
      },
      () => refreshRoom()
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "quiz_scores",
        filter: `room_id=eq.${roomId}`
      },
      () => refreshRoom()
    )
    .subscribe(status => {
      if (status === "SUBSCRIBED") {
        showConnectionMessage("Supabase接続済み・リアルタイム同期中");
      } else if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT"
      ) {
        showConnectionMessage(
          `リアルタイム接続に問題があります：${status}`
        );
      }
    });
}

// --------------------------------------------------
// サーバー上の状態を読み込む
// --------------------------------------------------

async function refreshRoom() {
  if (!supabaseClient || !currentRoomId) return;

  if (refreshRunning) {
    refreshPending = true;
    return;
  }

  refreshRunning = true;

  try {
    do {
      refreshPending = false;
      await refreshRoomOnce();
    } while (refreshPending && currentRoomId);
  } catch (error) {
    console.error("状態更新エラー:", error);
    showRoomMessage(`状態の取得に失敗しました：${error.message}`);
  } finally {
    refreshRunning = false;
  }
}

async function refreshRoomOnce() {
  const roomId = currentRoomId;

  const [
    roomResult,
    membersResult,
    stateResult,
    historyResult,
    scoresResult
  ] = await Promise.all([
    supabaseClient
      .from("quiz_rooms")
      .select("id, room_code, created_by")
      .eq("id", roomId)
      .maybeSingle(),

    supabaseClient
      .from("quiz_members")
      .select("room_id, user_id, display_name, joined_at")
      .eq("room_id", roomId)
      .order("joined_at", { ascending: true }),

    supabaseClient
      .from("quiz_game_state")
      .select("*")
      .eq("room_id", roomId)
      .maybeSingle(),

    supabaseClient
      .from("quiz_answer_history")
      .select("*")
      .eq("room_id", roomId)
      .order("created_at", { ascending: false })
      .limit(GAME_CONFIG.maxHistory),

    supabaseClient
      .from("quiz_scores")
      .select("*")
      .eq("room_id", roomId)
  ]);

  for (const result of [
    roomResult,
    membersResult,
    stateResult,
    historyResult,
    scoresResult
  ]) {
    if (result.error) throw result.error;
  }

  // 保存されたルームが存在しない、または現在の匿名ユーザーが
  // 参加者ではない場合、別の認証ユーザーとして再参加する必要がある。
  if (!roomResult.data || !stateResult.data) {
    await stopRealtime();

    currentRoomId = null;
    currentRoomCode = "";
    currentSnapshot = null;

    localStorage.removeItem("quiz-buzzer-room-id");
    localStorage.removeItem("quiz-buzzer-room-code");

    usernameInput.disabled = false;
    $("#room-info").hidden = true;

    showRoomMessage(
      "保存されたルームを参照できません。参加コードから再参加してください。"
    );

    render();
    return;
  }

  const snapshot = {
    room: roomResult.data,
    members: membersResult.data || [],
    state: stateResult.data,
    history: historyResult.data || [],
    scores: scoresResult.data || []
  };

  // 初回取得では効果音を鳴らさない。
  // 2回目以降は、他端末からの状態変化も検出して再生する。
  const previousSnapshot = currentSnapshot;

  if (previousSnapshot && currentRoomId === roomId) {
    playTransitionSounds(previousSnapshot, snapshot);
  }

  updateGameStatus(
    currentRoomId === roomId ? previousSnapshot : null,
    snapshot
  );

  currentSnapshot = snapshot;

  currentRoomCode = snapshot.room.room_code;
  $("#room-code-display").textContent = currentRoomCode;
  localStorage.setItem("quiz-buzzer-room-code", currentRoomCode);

  showRoomMessage("ルームに接続しました。");
  render();
}

function playTransitionSounds(previous, next) {
  const oldState = previous.state;
  const newState = next.state;

  // 新しい問題が開始された。
  if (
    newState.phase === "active" &&
    (
      oldState.phase !== "active" ||
      oldState.host_user_id !== newState.host_user_id
    )
  ) {
    playSound("question");
  }

  // 回答者が新しく確定した。
  if (
    newState.current_answer_id &&
    oldState.current_answer_id !== newState.current_answer_id
  ) {
    playSound("buzzer");
  }

  // 進行中の問題がリセットされ、待機状態に戻った。
  if (
    oldState.phase === "active" &&
    newState.phase === "ready" &&
    !newState.current_answer_id
  ) {
    playSound("reset");
  }

  // pending から正解・不正解に変化した履歴を検出する。
  const oldResults = new Map(
    previous.history.map(item => [item.id, item.result])
  );

  for (const item of next.history) {
    const oldResult = oldResults.get(item.id);

    if (oldResult === "pending" && item.result === "correct") {
      playSound("correct");
    } else if (
      oldResult === "pending" &&
      item.result === "incorrect"
    ) {
      playSound("incorrect");
    }
  }
}


function updateGameStatus(previous, next) {
  const state = next.state;
  const history = next.history;

  // 初回接続・ブラウザ更新後は、現在の状態を表示する。
  if (!previous) {
    if (state.phase === "ready") {
      showMessage("ルームに参加しました。出題開始待ちです。");
    } else if (state.phase === "ended") {
      showMessage("問題終了。出題者は次の問題を開始できます。");
    } else if (state.current_answer_id) {
      const answer = history.find(
        item => item.id === state.current_answer_id
      );

      showMessage(
        answer
          ? `${answer.display_name}さんが回答中です。`
          : "回答判定待ちです。"
      );
    } else {
      showMessage("出題中です。回答者を受け付けています。");
    }

    return;
  }

  const oldState = previous.state;

  // 正解・不正解の判定を検出する。
  const oldResults = new Map(
    previous.history.map(item => [item.id, item.result])
  );

  for (const item of history) {
    const oldResult = oldResults.get(item.id);

    if (oldResult === "pending" && item.result === "correct") {
      showMessage(`${item.display_name}さんの回答は正解です。問題終了。`);
      return;
    }

    if (oldResult === "pending" && item.result === "incorrect") {
      showMessage(`${item.display_name}さんの回答は不正解です。次の回答を受け付けています。`);
      return;
    }
  }

  // 出題開始を検出する。
  if (
    state.phase === "active" &&
    (
      oldState.phase !== "active" ||
      oldState.host_user_id !== state.host_user_id
    )
  ) {
    const host = next.members.find(
      member => member.user_id === state.host_user_id
    );

    showMessage(
      `${host ? host.display_name : "出題者"}さんが出題を開始しました。`
    );
    return;
  }

  // 新しい回答者を検出する。
  if (
    state.current_answer_id &&
    oldState.current_answer_id !== state.current_answer_id
  ) {
    const answer = history.find(
      item => item.id === state.current_answer_id
    );

    showMessage(
      answer
        ? `${answer.display_name}さんが早押ししました。判定待ちです。`
        : "回答判定待ちです。"
    );
    return;
  }

  // 問題のリセットを検出する。
  if (
    oldState.phase === "active" &&
    state.phase === "ready" &&
    !state.current_answer_id
  ) {
    showMessage("問題がリセットされました。");
  }
}

// --------------------------------------------------
// ゲーム操作
// --------------------------------------------------

async function callGameRpc(functionName, args, fallbackMessage) {
  if (!currentRoomId) {
    showMessage("先にルームへ参加してください。");
    return false;
  }

  try {
    const { data, error } = await supabaseClient.rpc(
      functionName,
      args
    );

    if (error) throw error;

    if (data && typeof data === "object" && data.ok === false) {
      throw new Error(data.message || "操作できませんでした。");
    }

    const message =
      data && typeof data === "object" && data.message
        ? data.message
        : fallbackMessage;

    showMessage(message);
    await refreshRoom();

    return true;
  } catch (error) {
    console.error(`${functionName} エラー:`, error);
    showMessage(error.message || "操作に失敗しました。");
    await refreshRoom();
    return false;
  }
}

buzzerButton.addEventListener("click", async () => {
  buzzerButton.disabled = true;

  await callGameRpc(
    "quiz_buzz",
    { p_room_id: currentRoomId },
    "早押しを受け付けました。"
  );
});

questionButton.addEventListener("click", async () => {
  questionButton.disabled = true;

  const ok = await callGameRpc(
    "quiz_start_question",
    { p_room_id: currentRoomId },
    `${currentUserName()}さんが出題しました。`
  );

  if (ok) {
    window.setTimeout(render, GAME_CONFIG.resetTimeoutMs + 100);
  }
});

correctButton.addEventListener("click", async () => {
  correctButton.disabled = true;

  await callGameRpc(
    "quiz_judge_answer",
    {
      p_room_id: currentRoomId,
      p_result: "correct"
    },
    "正解として判定しました。"
  );
});

incorrectButton.addEventListener("click", async () => {
  incorrectButton.disabled = true;

  await callGameRpc(
    "quiz_judge_answer",
    {
      p_room_id: currentRoomId,
      p_result: "incorrect"
    },
    "不正解として判定しました。"
  );
});

resetQuestionButton.addEventListener("click", async () => {
  resetQuestionButton.disabled = true;

  const ok = await callGameRpc(
    "quiz_reset_question",
    { p_room_id: currentRoomId },
    "問題をリセットしました。得点は維持されます。"
  );

  if (ok) {
    const status = $("#game-status");

    status.textContent =
      "問題をリセットしました。得点は維持されています。";
    status.classList.add("reset-notice");

    window.setTimeout(() => {
      status.classList.remove("reset-notice");
    }, 4000);
  }
});

resetAllButton.addEventListener("click", () => {
  if (typeof resetDialog.showModal === "function") {
    resetDialog.showModal();
  } else if (window.confirm("ゲーム全体を初期化しますか？")) {
    resetAll();
  }
});

confirmResetButton.addEventListener("click", async event => {
  event.preventDefault();
  resetDialog.close();
  await resetAll();
});

async function resetAll() {
  await callGameRpc(
    "quiz_reset_all",
    { p_room_id: currentRoomId },
    "ゲーム全体を初期化しました。"
  );
}

// --------------------------------------------------
// 画面描画
// --------------------------------------------------

function render() {
  const hasRoom = Boolean(currentRoomId && currentSnapshot);
  const snapshot = currentSnapshot;

  setBusy(false);

  usernameInput.disabled = Boolean(currentRoomId);
  $("#room-info").hidden = !currentRoomId;
  leaveRoomButton.disabled = !currentRoomId;

  if (!hasRoom) {
    buzzerButton.disabled = true;
    questionButton.disabled = true;
    correctButton.disabled = true;
    incorrectButton.disabled = true;
    resetQuestionButton.disabled = true;
    resetAllButton.disabled = true;

    $("#host-label").textContent = "出題者：未設定";
    $("#buzzer-message").textContent =
      "ルーム参加後、出題開始を待ってください";

    renderMembers([]);
    renderHistory([]);
    renderScores([]);

    return;
  }

  const state = snapshot.state;
  const members = snapshot.members;
  const history = snapshot.history;
  const scores = snapshot.scores;

  const currentMember = members.find(
    member => member.user_id === currentUserId
  );

  if (currentMember) usernameInput.value = currentMember.display_name;

  const isHost = state.host_user_id === currentUserId;
  const active = state.phase === "active";
  const hasAnswer = Boolean(state.current_answer_id);
  const canStart = state.phase === "ready" || state.phase === "ended";

  const startedAt = state.question_started_at
    ? new Date(state.question_started_at).getTime()
    : null;

  const timedOut =
    startedAt !== null &&
    Date.now() - startedAt >= GAME_CONFIG.resetTimeoutMs;

  const canReset = active && (isHost || timedOut);
  const isCreator = snapshot.room.created_by === currentUserId;

  // 現在のルーム参加者であることも確認する。
  const isMember = Boolean(currentMember);

  buzzerButton.disabled = !(
    isMember &&
    active &&
    !hasAnswer &&
    !isHost
  );

  questionButton.disabled = !(
    isMember &&
    canStart
  );

  correctButton.disabled = !(
    isMember &&
    active &&
    hasAnswer &&
    isHost
  );

  incorrectButton.disabled = !(
    isMember &&
    active &&
    hasAnswer &&
    isHost
  );

  resetQuestionButton.disabled = !(
    isMember &&
    canReset
  );

  resetAllButton.disabled = !(
    isMember &&
    isCreator
  );

  const host = members.find(
    member => member.user_id === state.host_user_id
  );

  $("#host-label").textContent =
    `出題者：${host ? host.display_name : "未設定"}`;

  if (state.phase === "ready") {
    $("#buzzer-message").textContent =
      "出題開始後に回答できます";
  } else if (state.phase === "ended") {
    $("#buzzer-message").textContent =
      "正解により問題終了。出題者は次の問題を開始できます";
  } else if (hasAnswer) {
    const answer = history.find(
      item => item.id === state.current_answer_id
    );

    $("#buzzer-message").textContent = answer
      ? `${answer.display_name}さんが回答中`
      : "回答判定待ち";
  } else {
    $("#buzzer-message").textContent =
      "回答者を受け付けています";
  }

  renderMembers(members);
  renderHistory(history, state.current_answer_id);
  renderScores(scores);
}

function renderMembers(members) {
  const list = $("#member-list");
  list.replaceChildren();

  if (members.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = "参加者はいません";
    list.append(li);
    return;
  }

  members.forEach(member => {
    const li = document.createElement("li");
    li.textContent = member.display_name;

    if (member.user_id === currentUserId) {
      const you = document.createElement("span");
      you.className = "result";
      you.textContent = "（自分）";
      li.append(you);
    }

    if (
      currentSnapshot &&
      member.user_id === currentSnapshot.room.created_by
    ) {
      const creator = document.createElement("span");
      creator.className = "result";
      creator.textContent = "（ルーム作成者）";
      li.append(creator);
    }

    list.append(li);
  });
}

function renderHistory(history, currentAnswerId = null) {
  const list = $("#history-list");
  list.replaceChildren();

  if (history.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = "まだ回答はありません";
    list.append(li);
    return;
  }

  history.forEach(entry => {
    const li = document.createElement("li");

    li.className =
      entry.result === "correct" ? "correct" :
      entry.result === "incorrect" ? "incorrect" :
      entry.id === currentAnswerId ? "current" : "";

    const time = new Date(entry.created_at).toLocaleTimeString(
      "ja-JP",
      {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }
    );

    li.append(
      document.createTextNode(`${entry.display_name}　${time}`)
    );

    const result = document.createElement("span");
    result.className = "result";

    result.textContent =
      entry.result === "correct" ? "正解" :
      entry.result === "incorrect" ? "不正解" :
      "回答中";

    li.append(result);
    list.append(li);
  });
}

function renderScores(scores) {
  const list = $("#score-list");
  list.replaceChildren();

  const entries = [...scores].sort(
    (a, b) =>
      b.score - a.score ||
      a.display_name.localeCompare(b.display_name, "ja")
  );

  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = "得点はまだありません";
    list.append(li);
    return;
  }

  entries.forEach((entry, index) => {
    const li = document.createElement("li");

    li.append(
      document.createTextNode(`${index + 1}位　${entry.display_name}`)
    );

    const value = document.createElement("span");
    value.className = "score-value";
    value.textContent = `${entry.score}点`;

    li.append(value);
    list.append(li);
  });
}

// --------------------------------------------------
// 起動
// --------------------------------------------------

initialize();