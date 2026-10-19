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

const roomModeSelect = $("#room-mode");
const questionNumberDisplay = $("#question-number");
const timerDisplay = $("#timer-display");
const gameFinishedMessage = $("#game-finished-message");
const globalEventMessage = $("#global-event-message");

const gameSettingsPanel = $("#game-settings-panel");

const correctPointsInput = $("#correct-points");
const incorrectPointsInput = $("#incorrect-points");
const buzzGuardSecondsInput = $("#buzz-guard-seconds");
const allowNegativeScoresInput = $("#allow-negative-scores");

const maxQuestionsInput = $("#max-questions");
const maxScoreInput = $("#max-score");
const showQuestionNumberInput = $("#show-question-number");
const saveGameSettingsButton = $("#save-game-settings");

const scoreAdjustmentPanel = $("#score-adjustment-panel");
const scoreTargetSelect = $("#score-target");
const scoreDeltaInput = $("#score-delta");
const applyScoreAdjustmentButton = $("#apply-score-adjustment");

let supabaseClient = null;
let currentUserId = null;
let authReady = false;

let currentRoomId =
  localStorage.getItem("quiz-buzzer-room-id");
let currentRoomCode =
  localStorage.getItem("quiz-buzzer-room-code") || "";

let currentSnapshot = null;
let realtimeChannel = null;
let refreshRunning = false;
let refreshPending = false;
let timerIntervalId = null;

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

function showGlobalEventMessage(message) {
  if (!globalEventMessage) return;

  globalEventMessage.textContent = message || "";
  globalEventMessage.hidden = !message;
}

function setBusy(busy) {
  createRoomButton.disabled =
    busy || !authReady || Boolean(currentRoomId);

  joinRoomButton.disabled =
    busy || !authReady || Boolean(currentRoomId);

  leaveRoomButton.disabled =
    busy || !currentRoomId;
}

// --------------------------------------------------
// 権限・状態判定
// --------------------------------------------------

function getCurrentMember(snapshot = currentSnapshot) {
  if (!snapshot || !currentUserId) return null;

  return snapshot.members.find(
    member => member.user_id === currentUserId
  ) || null;
}

function isRoomCreator(snapshot = currentSnapshot) {
  return Boolean(
    snapshot &&
    currentUserId &&
    snapshot.room.created_by === currentUserId
  );
}

function isSingleSetter(snapshot = currentSnapshot) {
  return snapshot?.room.mode === "single_setter";
}

function canManageGame(snapshot = currentSnapshot) {
  if (!snapshot || !getCurrentMember(snapshot)) return false;

  return isSingleSetter(snapshot)
    ? isRoomCreator(snapshot)
    : true;
}

function canJudge(snapshot = currentSnapshot) {
  if (!snapshot || !getCurrentMember(snapshot)) return false;

  return isSingleSetter(snapshot)
    ? isRoomCreator(snapshot)
    : snapshot.state.host_user_id === currentUserId;
}

function getElapsedMilliseconds(state) {
  if (!state) return 0;

  const accumulated = Math.max(
    0,
    Number(state.elapsed_ms) || 0
  );

  if (!state.timer_resumed_at) {
    return accumulated;
  }

  const resumedAt = new Date(
    state.timer_resumed_at
  ).getTime();

  if (!Number.isFinite(resumedAt)) {
    return accumulated;
  }

  return accumulated + Math.max(0, Date.now() - resumedAt);
}

function getHighestScore(scores) {
  return scores.reduce(
    (highest, entry) => Math.max(
      highest,
      Number(entry.score) || 0
    ),
    0
  );
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
      roomCodeInput.value = currentRoomCode;
      $("#room-info").hidden = false;
      usernameInput.disabled = true;

      showRoomMessage("保存されたルームに再接続しています……");

      startRealtime();
      await refreshRoom();
    } else {
      showRoomMessage(
        "ルームを作成するか、参加コードを入力してください。"
      );
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

confirmCreateRoomButton.addEventListener(
  "click",
  async event => {
    event.preventDefault();

    createRoomDialog.close();
    await createRoom();
  }
);

async function createRoom() {
  if (!authReady || currentRoomId) return;

  setBusy(true);

  try {
    const name = currentUserName();
    const mode = roomModeSelect?.value || "everyone";

    const { data, error } = await supabaseClient.rpc(
      "quiz_create_room",
      {
        p_name: name,
        p_mode: mode
      }
    );

    if (error) throw error;

    const room = Array.isArray(data) ? data[0] : data;

    if (!room?.created_room_id || !room?.created_room_code) {
      throw new Error(
        "ルーム作成結果を読み取れませんでした。"
      );
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
    showRoomMessage(
      "参加コードは半角英数字6文字で入力してください。"
    );
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

    // ★ JSONBオブジェクト形式のレスポンスを処理する
    const res = data;
    if (!res || !res.ok) {
      throw new Error(res?.message || "参加に失敗しました。");
    }

    const roomId = res.room_id;
    if (typeof roomId !== "string" || !roomId) {
      throw new Error("参加結果を読み取れませんでした。");
    }

    // 自動で枝番（例: 「 (2)」）が振られた場合は入力欄の名前も更新する
    if (res.assigned_name) {
      usernameInput.value = res.assigned_name;
    }

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

  playFixedSound("entry");

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
    playFixedSound("exit");
    
    const { data, error } = await supabaseClient.rpc(
      "quiz_leave_room",
      { p_room_id: roomId }
    );

    if (error) throw error;

    if (
      data &&
      typeof data === "object" &&
      data.ok === false
    ) {
      throw new Error(
        data.message || "退室できませんでした。"
      );
    }

    await stopRealtime();

    currentRoomId = null;
    currentRoomCode = "";
    currentSnapshot = null;

    localStorage.removeItem("quiz-buzzer-room-id");
    localStorage.removeItem("quiz-buzzer-room-code");

    usernameInput.disabled = false;
    $("#room-info").hidden = true;

    showGlobalEventMessage("");
    showRoomMessage(
      "退室しました。ルームは削除されていません。"
    );
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
        showConnectionMessage(
          "Supabase接続済み・リアルタイム同期中"
        );
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
    showRoomMessage(
      `状態の取得に失敗しました：${error.message}`
    );
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
      .select("id, room_code, created_by, mode")
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

  const previousSnapshot = currentSnapshot;

  if (previousSnapshot && currentRoomId === roomId) {
    handleSnapshotTransitions(previousSnapshot, snapshot);
  }

  updateGameStatus(previousSnapshot, snapshot);

  currentSnapshot = snapshot;

  currentRoomCode = snapshot.room.room_code;

  $("#room-code-display").textContent = currentRoomCode;
  localStorage.setItem("quiz-buzzer-room-code", currentRoomCode);

  showRoomMessage("ルームに接続しました。");
  render();
}

// --------------------------------------------------
// 状態変化・効果音・全員向け通知
// --------------------------------------------------

function handleSnapshotTransitions(previous, next) {
  const oldState = previous.state;
  const newState = next.state;

  // 入退室を検出する。
  const oldMembers = new Map(
    previous.members.map(member => [
      member.user_id,
      member.display_name
    ])
  );

  const newMembers = new Map(
    next.members.map(member => [
      member.user_id,
      member.display_name
    ])
  );

  for (const [userId, name] of newMembers) {
    if (!oldMembers.has(userId)) {
      // ★ 自分自身が参加した場合、または他の人が参加した場合
      playFixedSound("entry");
      if (userId === currentUserId) {
        showGlobalEventMessage("ルームに参加しました。");
      } else {
        showGlobalEventMessage(`${name}さんが参加しました。`);
      }
    }
  }

  for (const [userId, name] of oldMembers) {
    if (!newMembers.has(userId)) {
      // ★ 自分自身が退室した場合、または他の人が退室した場合
      playFixedSound("exit");
      if (userId === currentUserId) {
        showGlobalEventMessage("ルームから退出しました。");
      } else {
        showGlobalEventMessage(`${name}さんが退室しました。`);
      }
    }
  }

  // 設定変更・得点修正を検出する。
  if (
    Number(newState.last_event_id) !==
      Number(oldState.last_event_id) &&
    newState.last_event_message
  ) {
    const eventType = String(
      newState.last_event_type || ""
    );

    if (/setting|config|score|adjust/i.test(eventType)) {
      playFixedSound("config");
      showGlobalEventMessage(newState.last_event_message);
    }
  }

  // 新しい問題の開始。
  if (
    newState.phase === "active" &&
    (
      oldState.phase !== "active" ||
      oldState.host_user_id !== newState.host_user_id
    )
  ) {
    questionActiveTimestamp = Date.now(); // ★ここで出題時刻を記録
    playSound("question");
  }

  // 新しい回答者。
  if (
    newState.current_answer_id &&
    oldState.current_answer_id !== newState.current_answer_id
  ) {
    playSound("buzzer");
  }

  // 問題のリセット。
  if (
    oldState.phase === "active" &&
    newState.phase === "ready" &&
    !newState.current_answer_id
  ) {
    playSound("reset");
  }

  // 正解者なしで問題が終了した場合（かつ、直近の履歴が正解になっていない場合）
  if (
    oldState.phase === "active" &&
    newState.phase === "ended" &&
    !newState.current_answer_id
  ) {
    const latestHistory = next.history[0];
    // 直近の履歴が正解（correct）でなければ「正解者なし」とみなして不正解音を鳴らす
    if (!latestHistory || latestHistory.result !== "correct") {
      playSound("incorrect");
    }
  }

  // 回答の判定。
  const oldResults = new Map(
    previous.history.map(item => [item.id, item.result])
  );

  for (const item of next.history) {
    const oldResult = oldResults.get(item.id);

    if (
      oldResult === "pending" &&
      item.result === "correct"
    ) {
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

  if (state.game_finished) {
    showMessage(
      state.game_end_message || "ゲーム終了です。"
    );
    return;
  }

  if (!previous) {
    if (state.phase === "ready") {
      showMessage(
        "ルームに参加しました。出題開始待ちです。"
      );
    } else if (state.phase === "ended") {
      showMessage(
        "問題終了。次の問題を開始できます。"
      );
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

  const oldResults = new Map(
    previous.history.map(item => [item.id, item.result])
  );

  for (const item of history) {
    const oldResult = oldResults.get(item.id);

    if (
      oldResult === "pending" &&
      item.result === "correct"
    ) {
      showMessage(
        `${item.display_name}さんの回答は正解です。問題終了。`
      );
      return;
    }

    if (
      oldResult === "pending" &&
      item.result === "incorrect"
    ) {
      showMessage(
        `${item.display_name}さんの回答は不正解です。次の回答を受け付けています。`
      );
      return;
    }
  }

  // 正解者なしで問題が終了した場合。
  if (
    oldState.phase === "active" &&
    state.phase === "ended" &&
    !state.current_answer_id
  ) {
    showMessage("正解者なし。問題終了です。");
    return;
  }

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

  if (
    oldState.phase === "active" &&
    state.phase === "ready" &&
    !state.current_answer_id
  ) {
    showMessage("問題がリセットされました。");
  }
}

// --------------------------------------------------
// RPC共通処理
// --------------------------------------------------

async function callGameRpc(
  functionName,
  args,
  fallbackMessage
) {
  if (!currentRoomId || !supabaseClient) {
    showMessage("先にルームへ参加してください。");
    return false;
  }

  try {
    const { data, error } = await supabaseClient.rpc(
      functionName,
      args
    );

    if (error) throw error;

    if (
      data &&
      typeof data === "object" &&
      data.ok === false
    ) {
      throw new Error(
        data.message || "操作できませんでした。"
      );
    }

    const message =
      data &&
      typeof data === "object" &&
      data.message
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

// --------------------------------------------------
// 早押し・出題・判定・リセット
// --------------------------------------------------

// 出題フェーズに切り替わった時刻を保持する変数
let questionActiveTimestamp = 0;

buzzerButton.addEventListener("click", async () => {
  const active = currentSnapshot && currentSnapshot.state.phase === "active";
  const hasAnswer = Boolean(currentSnapshot?.state?.current_answer_id);
  const isHost = currentSnapshot?.state?.host_user_id === currentUserId;
  const isCreator = isRoomCreator(currentSnapshot);
  const singleSetter = isSingleSetter(currentSnapshot);

  // 出題者、部屋主、または誰かが回答中のときは何もしない
  if (hasAnswer || isHost || (singleSetter && isCreator)) {
    return;
  }

  // 1. 出題中以外（ready, ended, ゲーム終了後など）のときは、試し押し（設定された早押し音を鳴らす）
  if (!active) {
    if (typeof triggerBuzzerAnimation === "function") {
      triggerBuzzerAnimation();
    }
    playSound("buzzer"); // ★ playFixedSound ではなく playSound に修正
    return;
  }

  // 2. 出題直後のガード時間（設定値に基づいた判定）
  const guardMs = Number(currentSnapshot?.state?.buzz_guard_seconds ?? 1.0) * 1000;
  if (Date.now() - questionActiveTimestamp < guardMs) {
    return;
  }

  // 3. 通常の早押し処理
  buzzerButton.disabled = true;

  await callGameRpc(
    "quiz_buzz",
    { p_room_id: currentRoomId },
    "早押しを受け付けました。"
  );
});

questionButton.addEventListener("click", async () => {
  questionButton.disabled = true;

  await callGameRpc(
    "quiz_start_question",
    { p_room_id: currentRoomId },
    `${currentUserName()}さんが出題しました。`
  );
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

  const noAnswer =
    currentSnapshot?.state.phase === "active" &&
    !currentSnapshot.state.current_answer_id;

  // 正解者なし、または不正解の判定を送信
  await callGameRpc(
    "quiz_judge_answer",
    {
      p_room_id: currentRoomId,
      p_result: "incorrect"
    },
    noAnswer
      ? "正解者なし。問題終了です。"
      : "不正解として判定しました。"
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

confirmResetButton.addEventListener(
  "click",
  async event => {
    event.preventDefault();
    resetDialog.close();
    await resetAll();
  }
);

async function resetAll() {
  await callGameRpc(
    "quiz_reset_all",
    { p_room_id: currentRoomId },
    "ゲーム全体を初期化しました。"
  );
}

// --------------------------------------------------
// ゲーム設定
// --------------------------------------------------

saveGameSettingsButton.addEventListener(
  "click",
  async () => {
    const snapshot = currentSnapshot;

    if (!snapshot || !canManageGame(snapshot)) {
      showMessage("ゲーム設定を変更する権限がありません。");
      return;
    }

    const correctPoints = Number(correctPointsInput.value);
    const incorrectPoints = Number(incorrectPointsInput.value);
    const buzzGuardSeconds = Number(buzzGuardSecondsInput.value);
    const allowNegativeScores = allowNegativeScoresInput.checked;

    const maxQuestions = maxQuestionsInput.value.trim() === ""
      ? null
      : Number(maxQuestionsInput.value);

    const maxScore = maxScoreInput.value.trim() === ""
      ? null
      : Number(maxScoreInput.value);

    const showQuestionNumber =
      showQuestionNumberInput.checked;

    if (!Number.isInteger(correctPoints) || correctPoints < 0) {
      showMessage("正解時の得点は0以上の整数にしてください。");
      return;
    }

    if (!Number.isInteger(incorrectPoints)) {
      showMessage("不正解時の得点は整数で入力してください（減点の場合は負の値）。");
      return;
    }

    if (!Number.isFinite(buzzGuardSeconds) || buzzGuardSeconds < 0 || buzzGuardSeconds > 5) {
      showMessage("ガード時間は 0〜5秒 の間で設定してください。");
      return;
    }

    if (
      maxQuestions !== null &&
      (!Number.isInteger(maxQuestions) || maxQuestions < 1)
    ) {
      showMessage("最大出題数は1以上の整数にしてください。");
      return;
    }

    if (
      maxScore !== null &&
      (!Number.isInteger(maxScore) || maxScore < 1)
    ) {
      showMessage("最大得点は1以上の整数にしてください。");
      return;
    }

    if (
      maxQuestions !== null &&
      maxQuestions < Number(snapshot.state.question_count)
    ) {
      showMessage(
        `最大出題数は現在の出題数（${snapshot.state.question_count}問）以上にしてください。`
      );
      return;
    }

    const highestScore = getHighestScore(snapshot.scores);

    if (maxScore !== null && maxScore < highestScore) {
      showMessage(
        `最大得点は現在の最高得点（${highestScore}点）以上にしてください。`
      );
      return;
    }

    saveGameSettingsButton.disabled = true;

    await callGameRpc(
      "quiz_update_settings",
      {
        p_room_id: currentRoomId,
        p_correct_points: correctPoints,
        p_incorrect_points: incorrectPoints,
        p_buzz_guard_seconds: buzzGuardSeconds,
        p_allow_negative_scores: allowNegativeScores,
        p_max_questions: maxQuestions,
        p_max_score: maxScore,
        p_show_question_number: showQuestionNumber
      },
      "ゲーム設定を更新しました。"
    );

    render();
  }
);

// --------------------------------------------------
// 得点の手動修正
// --------------------------------------------------

applyScoreAdjustmentButton.addEventListener(
  "click",
  async () => {
    const snapshot = currentSnapshot;

    if (!snapshot || !canManageGame(snapshot)) {
      showMessage("得点を変更する権限がありません。");
      return;
    }

    if (snapshot.state.phase === "active") {
      showMessage("出題中は得点を変更できません。");
      return;
    }

    const targetUserId = scoreTargetSelect.value;
    const delta = Number(scoreDeltaInput.value);

    if (!targetUserId) {
      showMessage("得点を変更するプレイヤーを選択してください。");
      return;
    }

    if (!Number.isInteger(delta) || delta === 0) {
      showMessage("増減する得点は0以外の整数にしてください。");
      return;
    }

    // 「出題者固定」モードで出題者自身を変更しようとしていないかチェック
    if (
      snapshot.room.mode === "single_setter" &&
      targetUserId === snapshot.room.created_by
    ) {
      showMessage("出題者の得点は変更できません。");
      return;
    }

    // 対象プレイヤー表示名の取得（membersまたはscoresから取得）
    const targetInMembers = snapshot.members?.find(m => m.user_id === targetUserId);
    const targetInScores = snapshot.scores?.find(s => s.user_id === targetUserId);
    const displayName = targetInMembers?.display_name || targetInScores?.display_name || "プレイヤー";

    applyScoreAdjustmentButton.disabled = true;

    await callGameRpc(
      "quiz_adjust_score",
      {
        p_room_id: currentRoomId,
        p_user_id: targetUserId,
        p_delta: delta
      },
      `${displayName}さんの得点を変更しました。`
    );

    render();
  }
);

// --------------------------------------------------
// 画面描画
// --------------------------------------------------

function render() {
  const hasRoom = Boolean(
    currentRoomId && currentSnapshot
  );

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

    questionButton.hidden = false;
    correctButton.hidden = false;
    incorrectButton.hidden = false;
    resetQuestionButton.hidden = false;
    resetAllButton.hidden = true;

    gameSettingsPanel.hidden = true;
    scoreAdjustmentPanel.hidden = true;

    questionNumberDisplay.hidden = true;
    gameFinishedMessage.hidden = true;

    timerDisplay.textContent = "0.0秒";

    $("#host-label").textContent = "出題者：未設定";
    $("#buzzer-message").textContent =
      "ルーム参加後、出題開始を待ってください";

    renderMembers([]);
    renderHistory([]);
    renderScores([], []);

    return;
  }

  const state = snapshot.state;
  const members = snapshot.members;
  const history = snapshot.history;
  const scores = snapshot.scores;

  const currentMember = getCurrentMember(snapshot);
  const isMember = Boolean(currentMember);
  const isCreator = isRoomCreator(snapshot);
  const singleSetter = isSingleSetter(snapshot);
  const canManage = canManageGame(snapshot);
  const canJudgeCurrent = canJudge(snapshot);

  if (currentMember) {
    usernameInput.value = currentMember.display_name;
  }

  const isHost = state.host_user_id === currentUserId;
  const active = state.phase === "active";
  const hasAnswer = Boolean(state.current_answer_id);
  const finished = Boolean(state.game_finished);

  const canStart =
    (state.phase === "ready" || state.phase === "ended") &&
    !finished &&
    (!singleSetter || isCreator);

  const elapsed = getElapsedMilliseconds(state);
  const timedOut = elapsed >= GAME_CONFIG.resetTimeoutMs;

  const canReset =
    active &&
    !finished &&
    (
      singleSetter
        ? isCreator
        : isHost || timedOut
    );

  // 早押し
  // ルームに参加していれば、誰かが回答中（hasAnswer）のとき以外はボタンを押せるようにする
  // 出題者、または出題者固定モードの作成者はボタンを押せない
  const isSetterOrHost = isHost || (singleSetter && isCreator);

  // 早押しボタンの disabled 判定
  buzzerButton.disabled = !(isMember && !hasAnswer && !isSetterOrHost);

  // 管理ボタン（出題・正解・不正解・問題リセット）を表示するかどうか
  // 条件：ルームに参加しており、かつ（「全員モード」または「出題者固定モードの作成者」であること）
  const canSeeHostControls = isMember && (!singleSetter || isCreator);

  // 出題ボタン
  questionButton.hidden = !canSeeHostControls;
  questionButton.disabled = !canStart;

  // 正解・不正解ボタンの表示制御
  correctButton.hidden = !canSeeHostControls;
  incorrectButton.hidden = !canSeeHostControls;

  correctButton.disabled = !(
    isMember &&
    active &&
    !finished &&
    hasAnswer &&
    canJudgeCurrent
  );

  // 回答者がいない状態でも「正解者なし」として終了可能。
  incorrectButton.disabled = !(
    isMember &&
    active &&
    !finished &&
    canJudgeCurrent
  );

  incorrectButton.textContent = hasAnswer
    ? "不正解"
    : "正解者なし";

  // 問題リセット（ボタン自体は常に表示し、権限や状態に応じて活性/非活性を切り替える）
  resetQuestionButton.hidden = !canSeeHostControls;
  resetQuestionButton.disabled = !canReset;

  // ゲーム全体の初期化は作成者のみ。
  resetAllButton.hidden = !(
    isMember &&
    isCreator
  );

  resetAllButton.disabled = !(
    isMember &&
    isCreator
  );

  // 設定と得点修正は、ゲーム進行中（出題中）でなければ、終了後も変更可能にする。
  const canEditSettings =
    isMember &&
    canManage &&
    !active;

  // 得点修正は、メンバーであり、かつ管理権限を持つ人（または出題者固定時の出題者）が可能
  const canAdjustScore = isMember && (canManage || snapshot.room.mode === 'single_setter') && !active;

  gameSettingsPanel.hidden = !canEditSettings;
  scoreAdjustmentPanel.hidden = !canEditSettings;

  saveGameSettingsButton.disabled = !canEditSettings;
  applyScoreAdjustmentButton.disabled = !canEditSettings;

  // セレクトボックスの生成は `canAdjustScore` を基準にする
  if (canAdjustScore) {
    const scoreMap = new Map();

    // 1. スコア保持者を登録（退出者含む）
    if (snapshot.scores) {
      snapshot.scores.forEach(s => {
        scoreMap.set(s.user_id, {
          user_id: s.user_id,
          display_name: s.display_name,
          score: s.score
        });
      });
    }

    // 2. 現在の参加者メンバーも登録（初期状態用）
    if (snapshot.members) {
      snapshot.members.forEach(m => {
        if (!scoreMap.has(m.user_id)) {
          scoreMap.set(m.user_id, {
            user_id: m.user_id,
            display_name: m.display_name,
            score: 0
          });
        }
      });
    }

    let targetPlayers = Array.from(scoreMap.values());

    // 「出題者固定」モードのとき、出題者（created_by）本人の画面では、
    // セレクトボックスの選択肢から「自分自身（出題者）」を除外する
    if (snapshot.room.mode === "single_setter" && snapshot.room.created_by === currentUserId) {
      targetPlayers = targetPlayers.filter(
        p => p.user_id !== snapshot.room.created_by
      );
    }

    // セレクトボックスの選択肢更新
    const currentSelectedValue = scoreTargetSelect.value;
    scoreTargetSelect.innerHTML = "";

    if (targetPlayers.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "対象プレイヤーがいません";
      scoreTargetSelect.appendChild(option);
    } else {
      targetPlayers.forEach(p => {
        const option = document.createElement("option");
        option.value = p.user_id;
        option.textContent = `${p.display_name} (${p.score}点)`;
        scoreTargetSelect.appendChild(option);
      });

      if (
        currentSelectedValue &&
        targetPlayers.some(p => p.user_id === currentSelectedValue)
      ) {
        scoreTargetSelect.value = currentSelectedValue;
      }
    }
  }

  // 設定欄は未編集中のときだけサーバー値で更新する。
  if (document.activeElement !== correctPointsInput) {
    correctPointsInput.value =
      String(state.correct_points ?? 1);
  }

  if (document.activeElement !== incorrectPointsInput) {
    incorrectPointsInput.value =
      String(state.incorrect_points ?? 0);
  }

  if (document.activeElement !== allowNegativeScoresInput) {
    allowNegativeScoresInput.checked =
      Boolean(state.allow_negative_scores);
  }

  if (document.activeElement !== maxQuestionsInput) {
    maxQuestionsInput.value =
      state.max_questions == null
        ? ""
        : String(state.max_questions);
  }

  if (document.activeElement !== maxScoreInput) {
    maxScoreInput.value =
      state.max_score == null
        ? ""
        : String(state.max_score);
  }

  if (document.activeElement !== showQuestionNumberInput) {
    showQuestionNumberInput.checked =
      Boolean(state.show_question_number);
  }

  if (document.activeElement !== buzzGuardSecondsInput) {
      buzzGuardSecondsInput.value =
        state.buzz_guard_seconds != null
          ? String(state.buzz_guard_seconds)
          : "1.0";
    }

  // 出題番号
  questionNumberDisplay.hidden = !(
    state.show_question_number &&
    Number(state.question_count) > 0
  );

  questionNumberDisplay.textContent =
    `第${state.question_count}問`;

  // 経過時間
  updateTimerDisplay();

  // ゲーム終了メッセージ
  gameFinishedMessage.hidden = !finished;
  gameFinishedMessage.textContent = finished
    ? state.game_end_message || "ゲーム終了です。"
    : "";

  const host = members.find(
    member => member.user_id === state.host_user_id
  );

  $("#host-label").textContent =
    `出題者：${host ? host.display_name : "未設定"}`;

  if (finished) {
    $("#buzzer-message").textContent =
      "ゲーム終了。新しい問題は開始できません。";
  } else if (state.phase === "ready") {
    $("#buzzer-message").textContent =
      "出題開始後に回答できます";
  } else if (state.phase === "ended") {
    $("#buzzer-message").textContent =
      "問題終了。次の問題を開始できます";
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
  renderScores(scores, members);
}

// --------------------------------------------------
// タイマー表示
// --------------------------------------------------

function updateTimerDisplay() {
  if (!timerDisplay) return;

  const state = currentSnapshot?.state;

  if (!state) {
    timerDisplay.textContent = "0.0秒";
    return;
  }

  const elapsed = getElapsedMilliseconds(state);
  const tenths = Math.floor(elapsed / 100);

  timerDisplay.textContent =
    `${(tenths / 10).toFixed(1)}秒`;
}

function startTimerDisplayLoop() {
  if (timerIntervalId !== null) {
    window.clearInterval(timerIntervalId);
  }

  timerIntervalId = window.setInterval(
    updateTimerDisplay,
    100
  );
}

// --------------------------------------------------
// 参加者一覧
// --------------------------------------------------

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

// --------------------------------------------------
// 回答履歴
// --------------------------------------------------

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

    const elapsedTenths = entry.elapsed_tenths;

    const elapsedText =
      elapsedTenths == null
        ? "—"
        : `${(Number(elapsedTenths) / 10).toFixed(1)}秒`;

    li.append(
      document.createTextNode(
        `${entry.display_name}　${elapsedText}`
      )
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

// --------------------------------------------------
// 得点一覧・得点修正対象
// --------------------------------------------------

function renderScores(scores, members = []) {
  const list = $("#score-list");
  list.replaceChildren();

  const snapshot = currentSnapshot;
  const isSingle = isSingleSetter(snapshot);
  const creatorId = snapshot?.room.created_by;

  // single_setter モードの場合は作成者をランキングから除外する
  const filteredScores = scores.filter(entry => {
    if (isSingle && entry.user_id === creatorId) {
      return false;
    }
    return true;
  });

  const entries = [...filteredScores].sort(
    (a, b) =>
      Number(b.score) - Number(a.score) ||
      a.display_name.localeCompare(b.display_name, "ja")
  );

  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = "得点はまだありません";
    list.append(li);
  } else {
    let currentRank = 1;
    let currentScore = null;
    let sameScoreCount = 0;

    entries.forEach((entry, index) => {
      const score = Number(entry.score) || 0;

      // 順位および同率の判定
      if (index === 0) {
        currentRank = 1;
        currentScore = score;
        sameScoreCount = 1;
      } else {
        if (score === currentScore) {
          sameScoreCount++;
        } else {
          currentRank += sameScoreCount;
          currentScore = score;
          sameScoreCount = 1;
        }
      }

      // 同率の2人目以降かどうか
      const isDuplicateScore = (index > 0 && score === entries[index - 1].score);

      const li = document.createElement("li");
      li.style.display = "flex";
      li.style.justifyContent = "space-between";
      li.style.alignItems = "center";

      // 順位表示部分（インデント/幅を固定して位置を揃える）
      const rankSpan = document.createElement("span");
      rankSpan.style.display = "inline-block";
      rankSpan.style.width = "4em"; // 幅を固定してインデントを揃える
      rankSpan.textContent = isDuplicateScore ? "" : `${currentRank}位`;

      // プレイヤー名
      const nameSpan = document.createElement("span");
      nameSpan.style.flexGrow = "1";
      nameSpan.textContent = entry.display_name;

      // 得点
      const value = document.createElement("span");
      value.className = "score-value";
      value.textContent = `${score}点`;

      li.append(rankSpan, nameSpan, value);
      list.append(li);
    });
  }

  renderScoreTargets(members, scores);
}

function renderScoreTargets(members, scores) {
  if (!scoreTargetSelect) return;

  const previousValue = scoreTargetSelect.value;
  const snapshot = currentSnapshot;
  const isSingle = isSingleSetter(snapshot);
  const creatorId = snapshot?.room.created_by;

  // 1. スコア保持者（退出者含む）をマップ化
  const scoreMap = new Map();
  if (scores) {
    scores.forEach(s => {
      scoreMap.set(s.user_id, {
        user_id: s.user_id,
        display_name: s.display_name,
        score: Number(s.score) || 0
      });
    });
  }

  // 2. 現在のメンバーも追加（まだスコアがない場合用）
  if (members) {
    members.forEach(m => {
      if (!scoreMap.has(m.user_id)) {
        scoreMap.set(m.user_id, {
          user_id: m.user_id,
          display_name: m.display_name,
          score: 0
        });
      }
    });
  }

  let targetPlayers = Array.from(scoreMap.values());

  // 3. 「出題者固定」モードのとき、出題者本人の画面であれば出題者自身を除外する
  if (isSingle && snapshot?.room.created_by === currentUserId) {
    targetPlayers = targetPlayers.filter(
      p => p.user_id !== creatorId
    );
  }

  scoreTargetSelect.replaceChildren();

  if (targetPlayers.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "対象プレイヤーがいません";
    scoreTargetSelect.append(option);
    return;
  }

  targetPlayers.forEach(p => {
    const option = document.createElement("option");
    option.value = p.user_id;
    option.textContent = `${p.display_name}（${p.score}点）`;
    scoreTargetSelect.append(option);
  });

  if (
    previousValue &&
    targetPlayers.some(p => p.user_id === previousValue)
  ) {
    scoreTargetSelect.value = previousValue;
  }
}

// --------------------------------------------------
// 起動
// --------------------------------------------------

startTimerDisplayLoop();
initialize();