const SOUND_LIST = {
  buzzer: [
    { name: "標準", file: "sounds/buzzer/default.wav" },
    { name: "音2", file: "sounds/buzzer/sound2.wav" }
  ],
  question: [
    { name: "標準", file: "sounds/question/default.wav" },
    { name: "無音", file: null }
  ],
  correct: [
    { name: "標準", file: "sounds/correct/default.wav" }
  ],
  incorrect: [
    { name: "標準", file: "sounds/incorrect/default.wav" }
  ]
};

const audioSettings = {
  buzzer: 0,
  question: 0,
  correct: 0,
  incorrect: 0
};

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