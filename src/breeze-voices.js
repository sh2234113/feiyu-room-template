// BreezeBlue 音色目录：只放「用户已选定 / 官方公开」的音色 ID。
// 新增音色请同时更新 roles/小蓝鱼-语音.md 里的说明，避免两处漂移。
export const BREEZE_DEFAULT_BASE = 'https://api.breeze.blue';

export const BREEZE_VOICES = Object.freeze({
  clever: 'voc_u3nxkd5578wc', // 小蓝鱼（机灵版）
  dreamy: 'voc_8yud7hz7c9q2' // 小蓝鱼（迷糊版）
});

export const BREEZE_VOICE_LABELS = Object.freeze({
  clever: '小蓝鱼（机灵版）',
  dreamy: '小蓝鱼（迷糊版）'
});
