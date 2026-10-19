const SOUND_LIST = {
  buzzer: [
    { name: "標準1", file: "sounds/buzzer/default1.wav" },
    { name: "標準2", file: "sounds/buzzer/default2.wav" },
    { name: "チャイム", file: "sounds/buzzer/chime.wav" },
    { name: "レトロ", file: "sounds/buzzer/retro.wav" }
  ],
  question: [
    { name: "標準1", file: "sounds/question/default1.wav" },
    { name: "標準2", file: "sounds/question/default2.wav" },
    { name: "無音", file: null }
  ],
  correct: [
    { name: "標準1", file: "sounds/correct/default1.wav" },
    { name: "標準2", file: "sounds/correct/default2.wav" },
    { name: "ファンファーレ", file: "sounds/correct/fanfare.wav" }
  ],
  incorrect: [
    { name: "標準1", file: "sounds/incorrect/default1.wav" },
    { name: "標準2", file: "sounds/incorrect/default2.wav" }
  ],
  reset: [
    { name: "標準1", file: "sounds/reset/default1.wav" },
    { name: "標準2", file: "sounds/reset/default2.wav" },
    { name: "無音", file: null }
  ]
};

const FIXED_SOUND_FILES = {
  entry: "sounds/entry/default.wav",
  exit: "sounds/exit/default.wav",
  config: "sounds/config/default.wav"
};

const fixedAudioCache = {};

function preloadFixedSounds() {
  for (const [type, file] of Object.entries(FIXED_SOUND_FILES)) {
    const audio = new Audio(file);
    audio.preload = "auto";
    audio.load();
    fixedAudioCache[type] = audio;
  }
}

function playFixedSound(type) {
  const audio = fixedAudioCache[type];
  if (!audio) return;

  audio.pause();
  audio.currentTime = 0;

  audio.play().catch(error => {
    console.warn("固定効果音を再生できませんでした:", error);
  });
}

const audioSettings = {
  buzzer: 0,
  question: 0,
  correct: 0,
  incorrect: 0,
  reset: 0
};

// audio.js の該当部分
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
    
    // 既存のイベントリスナーに音のテスト再生を追加
    select.addEventListener("change", () => {
      audioSettings[type] = Number(select.value);
      playSound(type); // ← 変更した瞬間にその音をテスト再生する
    });
  });
}
const audioCache = {};

function preloadSounds() {
  for (const [type, list] of Object.entries(SOUND_LIST)) {
    audioCache[type] = list.map(item => {
      if (!item.file) return null;

      const audio = new Audio(item.file);
      audio.preload = "auto";
      audio.load();

      return audio;
    });
  }
}

function playSound(type) {
  const index = audioSettings[type] || 0;
  const audio = audioCache[type]?.[index];

  if (!audio) return;

  // 同じ音を連続して鳴らせるよう、再生位置を先頭に戻す
  audio.pause();
  audio.currentTime = 0;

  audio.play().catch(error => {
    console.warn("効果音を再生できませんでした:", error);
  });
}

preloadSounds();
preloadFixedSounds();