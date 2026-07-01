export const EMOTE_SKIN_ENABLED_KEY = 'blobio.emoteSkin.enabled';
export const EMOTE_SKIN_CUSTOM_KEY = 'blobio.emoteSkin.customEmotes';

export const EMOTE_SKIN_EMOJIS = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '☺️', '😊', '😇', '🙂',
  '🙃', '😉', '😌', '😍', '😘', '😝',
  '🤑', '🤗', '🤓', '😎', '🤡', '🤠', '😏', '😒', '😣', '😭', '😱', '😴',
  '😡', '🥶', '💀', '👽', '👾', '🤖', '🎃', '😺', '😹', '👍', '👎', '🔥',
  '💙', '⚽️',
];

export const EMOTE_SKIN_TRIGGERS = [
  { id: 'cool', emoji: '😎', aliases: ['😎'], assetKey: 'cool', label: 'Cool' },
  { id: 'nice', emoji: '☺️', aliases: ['☺️', '☺'], assetKey: 'nice', label: 'Nice' },
  { id: 'hi', emoji: '🙂', aliases: ['🙂'], assetKey: 'hi', label: 'Hi' },
  { id: 'yo', emoji: '👽', aliases: ['👽'], assetKey: 'yo', label: 'Yo' },
  { id: 'thx', emoji: '👍', aliases: ['👍'], assetKey: 'thx', label: 'Thanks' },
  { id: 'why', emoji: '😣', aliases: ['😣'], assetKey: 'why', label: 'Why' },
  { id: 'pop', emoji: '⚽️', aliases: ['⚽️', '⚽'], assetKey: 'pop', label: 'Pop' },
  { id: 'wink-pop', emoji: '😉', aliases: ['😉'], assetKey: 'pop', label: 'Wink pop' },
];

const CUSTOM_IMAGE_URL_MATCH = /^https?:\/\/.+\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i;

export function normalizeCustomEmoteTrigger(value) {
  const trigger = String(value || '').replace(/\s+/g, '').trim();
  return trigger.slice(0, 18);
}

export function normalizeCustomEmoteUrl(value) {
  const url = String(value || '').trim();
  if (!CUSTOM_IMAGE_URL_MATCH.test(url)) {
    return '';
  }

  try {
    return new URL(url).toString();
  } catch {
    return '';
  }
}

function customEmoteId(trigger, index) {
  const slug = String(trigger || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  return `custom-${slug || index}`;
}

export function parseCustomEmotes(value) {
  let entries = [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    entries = [];
  }

  const usedTriggers = new Set();
  const emotes = [];
  for (const entry of entries) {
    const trigger = normalizeCustomEmoteTrigger(entry?.trigger ?? entry?.emoji);
    const url = normalizeCustomEmoteUrl(entry?.url);
    if (!trigger || !url || usedTriggers.has(trigger.toLowerCase())) {
      continue;
    }

    usedTriggers.add(trigger.toLowerCase());
    const id = customEmoteId(trigger, emotes.length + 1);
    emotes.push({
      id,
      emoji: trigger,
      aliases: [trigger],
      assetKey: id,
      label: String(entry?.label || trigger).trim().slice(0, 24) || trigger,
      url,
      custom: true,
    });
  }

  return emotes.slice(0, 18);
}

export function readCustomEmotes(storage) {
  try {
    return parseCustomEmotes(storage?.getItem?.(EMOTE_SKIN_CUSTOM_KEY));
  } catch {
    return [];
  }
}

export function saveCustomEmotes(storage, emotes) {
  const clean = parseCustomEmotes(emotes);
  try {
    storage?.setItem?.(EMOTE_SKIN_CUSTOM_KEY, JSON.stringify(clean.map((emote) => ({
      trigger: emote.emoji,
      label: emote.label,
      url: emote.url,
    }))));
  } catch {}
  return clean;
}

export function getEmoteSkinTriggers(customEmotes = []) {
  return EMOTE_SKIN_TRIGGERS.concat(parseCustomEmotes(customEmotes));
}

export function isEmoteSkinEnabled(storage) {
  try {
    const value = storage?.getItem?.(EMOTE_SKIN_ENABLED_KEY);
    return value === '1' || value === true || String(value).toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export function setEmoteSkinEnabled(storage, enabled) {
  try {
    storage?.setItem?.(EMOTE_SKIN_ENABLED_KEY, enabled ? '1' : '0');
  } catch {}
  return Boolean(enabled);
}

export function findEmoteTrigger(text, customEmotes = []) {
  const value = String(text || '');
  return getEmoteSkinTriggers(customEmotes).find((trigger) => (
    trigger.aliases.some((emoji) => value.includes(emoji))
  )) || null;
}
