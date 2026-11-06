const preparationStates = new Set([0,1,2,8,9,10,11]);

export function currentCaption(snapshot) {
  if (!snapshot) return {role:'',text:''};
  const messages = snapshot.messages || [];
  const latest = roles => [...messages].reverse().find(message => roles.includes(message.role) && message.text?.trim());
  const dialogue = latest(['user','assistant']);
  const system = latest(['system']);
  if (preparationStates.has(snapshot.state)) {
    const text = snapshot.notification?.trim() || system?.text || snapshot.status?.trim() || '';
    return {role:text ? 'system' : '',text};
  }
  if (dialogue) return {role:dialogue.role,text:dialogue.text};
  if (snapshot.state !== 7) return {role:'',text:''};
  const text = snapshot.notification?.trim() || system?.text || '';
  return {role:text ? 'system' : '',text};
}

export function screenState(snapshot, {connected = false, stale = false, demo = false} = {}) {
  const live = connected && !stale;
  const emotion = snapshot?.emotion || 'neutral';
  const mood = ['happy','laughing','loving','excited','winking','funny'].includes(emotion) ? 'happy'
    : ['sad','crying','fearful','scared','angry','confused'].includes(emotion) ? 'soft' : 'calm';
  return {
    demo,
    realConnection:connected && !demo,
    caption:currentCaption(snapshot),
    mood,
    motion:!live ? 'still' : snapshot?.state === 5 ? 'listening' : [6,7].includes(snapshot?.state) ? 'speaking' : 'idle',
    notice:!connected && snapshot ? '已断开 · 保留上次字幕' : stale ? '状态未更新 · 保留上次字幕' : '',
    activity:live && snapshot?.state === 5 ? '正在聆听' : live && [6,7].includes(snapshot?.state) ? '正在说话' : '',
  };
}
