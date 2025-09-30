/**
 * server.js — Belaynish Telegram Bot (Render-ready)
 *
 * Full merged version:
 * - All premium integrations: Replicate, Hugging Face (Space/API), Runway, Stability, ElevenLabs, Pixabay
 * - Replicate progress polling + throttled editable updates (5% or 15s)
 * - Memory: Upstash/Redis optional -> NodeCache fallback
 * - No-key fallbacks: google-it, DuckDuckGo, Wikipedia, Unsplash, Google Translate TTS, Smmry
 * - All replies prefixed with "Belaynish" (text + media flows)
 * - Render-friendly: process.env.PORT, optional WEBHOOK_URL and secret WEBHOOK_PATH
 *
 * Paste this as server.js (package.json uses "type":"module")
 */

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import compression from 'compression';
import helmet from 'helmet';
import { Telegraf } from 'telegraf';
import Redis from 'ioredis';
import NodeCache from 'node-cache';
import translateLib from '@vitalets/google-translate-api';
import googleIt from 'google-it';

///////////////////////////////////////////////////////////////////////////////
// Basic init
///////////////////////////////////////////////////////////////////////////////
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_TOKEN in environment.');
  throw new Error('Missing TELEGRAM_TOKEN');
}

const WEBHOOK_URL = process.env.WEBHOOK_URL || null; // e.g. https://your-service.onrender.com
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || BOT_TOKEN; // secret path for webhook
const PORT = parseInt(process.env.PORT || '3000', 10);
const MEMORY_TTL = parseInt(process.env.MEMORY_TTL_SECONDS || '10800', 10);

const bot = new Telegraf(BOT_TOKEN);

///////////////////////////////////////////////////////////////////////////////
// Helpers ensuring every outgoing message starts with "Belaynish"
///////////////////////////////////////////////////////////////////////////////
const withPrefix = (txt) => `Belaynish\n\n${txt}`;

async function sendText(ctx, text, extra = {}) {
  try {
    return await ctx.reply(withPrefix(text), extra);
  } catch (e) {
    console.warn('sendText failed', e.message);
    // fallback plain reply
    return await ctx.reply(withPrefix(text));
  }
}

// For media types that support caption, send with caption = withPrefix(...)
async function sendPhotoWithCaption(ctx, photo, caption = '') {
  try {
    return await ctx.replyWithPhoto(photo, { caption: withPrefix(caption) });
  } catch (e) {
    console.warn('sendPhotoWithCaption failed', e.message);
    // fallback: send text then photo
    await ctx.reply(withPrefix(caption));
    return await ctx.replyWithPhoto(photo);
  }
}

async function sendVideoWithCaption(ctx, video, caption = '') {
  try {
    return await ctx.replyWithVideo(video, { caption: withPrefix(caption) });
  } catch (e) {
    console.warn('sendVideoWithCaption failed', e.message);
    await ctx.reply(withPrefix(caption));
    return await ctx.replyWithVideo(video);
  }
}

async function sendDocumentWithCaption(ctx, doc, caption = '') {
  try {
    return await ctx.replyWithDocument(doc, { caption: withPrefix(caption) });
  } catch (e) {
    console.warn('sendDocumentWithCaption failed', e.message);
    await ctx.reply(withPrefix(caption));
    return await ctx.replyWithDocument(doc);
  }
}

// Voice often doesn't accept caption; send prefixed text first then voice
async function sendVoiceWithPrefix(ctx, voiceBufferOrUrl, text = '') {
  if (text) {
    await ctx.reply(withPrefix(text));
  } else {
    await ctx.reply(withPrefix('Sending voice...'));
  }
  try {
    // if buffer
    if (Buffer.isBuffer(voiceBufferOrUrl)) {
      return await ctx.replyWithVoice({ source: voiceBufferOrUrl });
    }
    // if URL or file_id
    return await ctx.replyWithVoice(voiceBufferOrUrl);
  } catch (e) {
    console.warn('sendVoiceWithPrefix failed', e.message);
    return;
  }
}

// Audio (music) supports caption
async function sendAudioWithCaption(ctx, audio, caption = '') {
  try {
    return await ctx.replyWithAudio(audio, { caption: withPrefix(caption) });
  } catch (e) {
    console.warn('sendAudioWithCaption failed', e.message);
    await ctx.reply(withPrefix(caption));
    return await ctx.replyWithAudio(audio);
  }
}

///////////////////////////////////////////////////////////////////////////////
// Admin / Owner config
///////////////////////////////////////////////////////////////////////////////
const OWNER_ID = process.env.OWNER_ID ? parseInt(process.env.OWNER_ID, 10) : null;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => parseInt(s, 10))
  .filter(Boolean);

function isAdmin(userId) {
  if (!userId) return false;
  if (OWNER_ID && userId === OWNER_ID) return true;
  return ADMIN_IDS.includes(userId);
}

///////////////////////////////////////////////////////////////////////////////
// Memory: Upstash/Redis optional -> NodeCache fallback
///////////////////////////////////////////////////////////////////////////////
let redis = null;
let usingRedis = false;
if (process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL) {
  try {
    const url = process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL;
    const opts = {};
    if (process.env.UPSTASH_REDIS_REST_TOKEN) opts.password = process.env.UPSTASH_REDIS_REST_TOKEN;
    redis = new Redis(url, opts);
    usingRedis = true;
    console.log('Using Redis memory at', url);
  } catch (e) {
    console.warn('Redis init failed, falling back to memory:', e.message);
    usingRedis = false;
  }
}
const memCache = new NodeCache({ stdTTL: MEMORY_TTL, checkperiod: 120 });

async function getMemory(chatId) {
  const key = `memory:${chatId}`;
  if (usingRedis && redis) {
    try {
      const v = await redis.get(key);
      return v ? JSON.parse(v) : [];
    } catch (e) {
      console.warn('Redis get failed:', e.message);
    }
  }
  return memCache.get(key) || [];
}
async function saveMemory(chatId, history) {
  const key = `memory:${chatId}`;
  if (usingRedis && redis) {
    try {
      await redis.set(key, JSON.stringify(history), 'EX', MEMORY_TTL);
      return;
    } catch (e) {
      console.warn('Redis set failed:', e.message);
    }
  }
  memCache.set(key, history);
}
async function clearMemory(chatId) {
  const key = `memory:${chatId}`;
  if (usingRedis && redis) {
    try {
      await redis.del(key);
      return;
    } catch (e) {
      console.warn('Redis del failed:', e.message);
    }
  }
  memCache.del(key);
}

///////////////////////////////////////////////////////////////////////////////
// Utilities: wiki, duckduckgo, google-it, translate
///////////////////////////////////////////////////////////////////////////////
const safeFirst = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);

async function wikiSummary(query) {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
    const r = await axios.get(url, { timeout: 10000 });
    return r.data?.extract || 'No Wikipedia summary found.';
  } catch (e) {
    return 'Wikipedia lookup failed.';
  }
}

async function duckDuck(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const r = await axios.get(url, { timeout: 8000 });
    if (r.data?.AbstractText) return r.data.AbstractText;
    const rt = safeFirst(r.data?.RelatedTopics);
    if (rt?.Text) return rt.Text;
    return 'No DuckDuckGo instant answer.';
  } catch (e) {
    return 'DuckDuckGo lookup failed.';
  }
}

async function googleSearch(query, limit = 3) {
  try {
    const results = await googleIt({ query, limit });
    if (!results || !results.length) return null;
    const lines = results.slice(0, limit).map((r, i) => `${i+1}. ${r.title}\n${r.snippet || r.link}\n${r.link}`);
    return lines.join('\n\n');
  } catch (e) {
    console.warn('googleSearch failed:', e.message);
    return null;
  }
}

async function translateUnofficial(text, to = 'en') {
  try {
    const r = await translateLib(text, { to });
    return r.text;
  } catch (e) {
    return text;
  }
}

///////////////////////////////////////////////////////////////////////////////
// Hugging Face helpers (Space + API)
///////////////////////////////////////////////////////////////////////////////
async function callHfSpace(prompt, spaceUrl = process.env.HF_SPACE_URL) {
  if (!spaceUrl) throw new Error('HF_SPACE_URL not configured');
  const base = spaceUrl.replace(/\/$/, '');
  const candidates = [`${base}/run/predict`, `${base}/api/predict`, base];
  for (const url of candidates) {
    try {
      const resp = await axios.post(url, { data: [prompt] }, { timeout: 120000 });
      if (resp.data?.data && resp.data.data.length) return String(resp.data.data[0]);
      if (resp.data?.generated_text) return String(resp.data.generated_text);
      if (typeof resp.data === 'string' && resp.data.length) return resp.data;
    } catch (e) {
      // try next
    }
  }
  throw new Error('HF Space did not return output');
}

async function callHfApi(prompt, modelUrl = process.env.HF_URL) {
  if (!modelUrl || !process.env.HUGGINGFACE_API_KEY) throw new Error('HF API not configured');
  const resp = await axios.post(modelUrl, { inputs: prompt }, {
    headers: { Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}` },
    timeout: 120000
  });
  if (Array.isArray(resp.data) && resp.data[0]?.generated_text) return resp.data[0].generated_text;
  if (resp.data?.generated_text) return resp.data.generated_text;
  if (resp.data?.data && resp.data.data[0]) return resp.data.data[0];
  return JSON.stringify(resp.data).slice(0, 4000);
}

///////////////////////////////////////////////////////////////////////////////
// Replicate API + polling + progress editor (throttled)
///////////////////////////////////////////////////////////////////////////////
async function callReplicateCreate(versionOrModel, input) {
  if (!process.env.REPLICATE_API_KEY) throw new Error('REPLICATE_API_KEY missing');
  const url = 'https://api.replicate.com/v1/predictions';
  const resp = await axios.post(url, { version: versionOrModel, input }, {
    headers: { Authorization: `Token ${process.env.REPLICATE_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 600000
  });
  return resp.data;
}

async function replicateGet(predictionId) {
  const url = `https://api.replicate.com/v1/predictions/${predictionId}`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Token ${process.env.REPLICATE_API_KEY}` },
    timeout: 600000
  });
  return resp.data;
}

const REPLICATE_POLL_INTERVAL_MS = parseInt(process.env.REPLICATE_POLL_INTERVAL_MS || '3000', 10);
const REPLICATE_POLL_TIMEOUT_SEC = parseInt(process.env.REPLICATE_POLL_TIMEOUT_SEC || '600', 10);

async function pollReplicatePrediction(predictionId, onProgress = null) {
  const start = Date.now();
  while (true) {
    const elapsed = (Date.now() - start) / 1000;
    if (elapsed > REPLICATE_POLL_TIMEOUT_SEC) throw new Error('Replicate polling timed out');
    const res = await replicateGet(predictionId);
    if (onProgress && typeof onProgress === 'function') {
      try { onProgress(res); } catch (e) { /* ignore progress errors */ }
    }
    if (res.status === 'succeeded') return res;
    if (res.status === 'failed') throw new Error('Replicate job failed: ' + JSON.stringify(res));
    await new Promise(r => setTimeout(r, REPLICATE_POLL_INTERVAL_MS));
  }
}

function createReplicateProgressEditorFactory(ctx, sentMessage = null) {
  const chatId = ctx.chat?.id || ctx.from?.id;
  let lastPercent = -1;
  let lastSentTime = 0;
  let progressMsg = null;
  const MIN_DELTA = 5;
  const MIN_INTERVAL_MS = 15000;

  return async function onProgress(res) {
    try {
      let percent = null;
      if (typeof res.progress === 'number') {
        percent = Math.round(res.progress * 100);
      } else if (res.metrics && typeof res.metrics.progress === 'number') {
        percent = Math.round(res.metrics.progress * 100);
      } else if (res.logs && Array.isArray(res.logs)) {
        const lastLog = res.logs[res.logs.length - 1] || '';
        if (typeof lastLog === 'string') {
          const m = lastLog.match(/(\d{1,3})\s?%/);
          if (m) percent = Math.min(100, Math.max(0, parseInt(m[1], 10)));
          else {
            const m2 = lastLog.match(/progress[:=]\s*([0-9.]+)/i);
            if (m2) {
              let p = parseFloat(m2[1]);
              if (p <= 1) p = Math.round(p * 100);
              percent = Math.min(100, Math.max(0, Math.round(p)));
            }
          }
        }
      }

      const now = Date.now();
      const shouldUpdate = (typeof percent === 'number' && (percent - lastPercent) >= MIN_DELTA) || (now - lastSentTime >= MIN_INTERVAL_MS);
      if (!shouldUpdate) return;

      lastSentTime = now;
      const pctText = typeof percent === 'number' ? `${percent}%` : 'processing...';
      const text = withPrefix(`Processing: ${pctText}`);

      if (sentMessage && sentMessage.message_id) {
        try {
          await ctx.telegram.editMessageCaption(ctx.chat.id || ctx.from.id, sentMessage.message_id, undefined, text);
          if (typeof percent === 'number') lastPercent = percent;
          return;
        } catch (e) {
          // fallthrough to editing text message
        }
      }

      if (!progressMsg) {
        const sent = await ctx.reply(text);
        progressMsg = sent;
      } else {
        try {
          await ctx.telegram.editMessageText(ctx.chat.id || ctx.from.id, progressMsg.message_id, undefined, text);
        } catch (e) {
          await ctx.reply(text);
        }
      }

      if (typeof percent === 'number') lastPercent = percent;
    } catch (e) {
      console.warn('onProgress error', e.message);
    }
  };
}

///////////////////////////////////////////////////////////////////////////////
// Runway, Stability, Pixabay, Unsplash, ElevenLabs
///////////////////////////////////////////////////////////////////////////////
async function callRunway(endpoint, model, input) {
  if (!process.env.RUNWAY_API_KEY) throw new Error('RUNWAY_API_KEY missing');
  const url = endpoint.replace(/\/$/, '');
  const r = await axios.post(url, { model, input }, {
    headers: { Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 600000
  });
  return r.data;
}

async function callStabilityImage(prompt, opts = {}) {
  if (!process.env.STABILITY_KEY) throw new Error('STABILITY_KEY missing');
  const url = 'https://api.stability.ai/v1/generation/stable-diffusion-v1-5/text-to-image';
  const payload = {
    text_prompts: [{ text: prompt }],
    cfg_scale: opts.cfg_scale || 7,
    height: opts.height || 512,
    width: opts.width || 512,
    samples: 1
  };
  const r = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${process.env.STABILITY_KEY}`, 'Content-Type': 'application/json' },
    responseType: 'arraybuffer',
    timeout: 180000
  });
  return r.data;
}

async function pixabaySearch(query) {
  if (!process.env.PIXABAY_KEY) throw new Error('PIXABAY_KEY missing');
  const url = `https://pixabay.com/api/?key=${process.env.PIXABAY_KEY}&q=${encodeURIComponent(query)}&image_type=photo&per_page=3`;
  const r = await axios.get(url, { timeout: 10000 });
  return r.data.hits || [];
}
function unsplashRandom(query) {
  return `https://source.unsplash.com/1024x768/?${encodeURIComponent(query)}`;
}

async function elevenTTS(text) {
  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) throw new Error('ElevenLabs not configured');
  const url = `${(process.env.ELEVENLABS_API_URL || 'https://api.elevenlabs.io/v1').replace(/\/$/, '')}/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`;
  const resp = await axios.post(url, { text }, {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    responseType: 'arraybuffer',
    timeout: 120000
  });
  return Buffer.from(resp.data);
}

///////////////////////////////////////////////////////////////////////////////
// HF model env map (kept)
///////////////////////////////////////////////////////////////////////////////
const HF_MODEL_MAP = {
  llama2: process.env.MODEL_LLAMA2 || process.env.HF_URL,
  mistral: process.env.MODEL_MISTRAL || process.env.HF_URL,
  flan_t5: process.env.MODEL_FLAN_T5 || process.env.HF_URL,
  falcon: process.env.MODEL_FALCON || process.env.HF_URL,
  gpt2: process.env.MODEL_GPT2 || process.env.HF_URL,
  bloom: process.env.MODEL_BLOOM || process.env.HF_URL,
  default: process.env.MODEL || process.env.HF_URL || process.env.HF_MODEL
};

///////////////////////////////////////////////////////////////////////////////
// Typing helper
///////////////////////////////////////////////////////////////////////////////
async function showTyping(ctx) {
  try {
    await ctx.sendChatAction('typing');
  } catch (e) {}
}

///////////////////////////////////////////////////////////////////////////////
// /ai master command (complete)
///////////////////////////////////////////////////////////////////////////////
bot.command('ai', async (ctx) => {
  await showTyping(ctx);

  const raw = (ctx.message?.text || '').trim();
  const parts = raw.split(' ').slice(1);
  if (!parts.length) return sendText(ctx, 'Usage: /ai <mode> <input>\nType /ai help for modes.');

  const mode = parts[0].toLowerCase();
  const rest = parts.slice(1).join(' ').trim();

  async function withTyping(fn) {
    const typingInterval = setInterval(() => { try { ctx.sendChatAction('typing'); } catch (e) {} }, 2500);
    try {
      return await fn();
    } finally {
      clearInterval(typingInterval);
    }
  }

  try {
    if (mode === 'help') {
      const help = `
/ai <mode> <input>

Chat:
  /ai chat [model] <prompt>     -> models: llama2, mistral, flan_t5, falcon (default llama2)

Search:
  /ai wiki <topic>
  /ai duck <query>
  /ai google <query>            (no API key, scraped results)

Translate:
  /ai translate [lang] <text>   -> default 'en' (use 'am' for Amharic)

Media:
  /ai media <mode> <input>
    modes: t2i t2v i2v v2v upscale act (Runway)
           flux fixface caption burncaption recon3d (Replicate)

TTS:
  /ai tts <text>

Replicate direct:
  /ai replicate <ENV_VAR_NAME> <prompt>

Admin:
  /ai post <@channel_or_channel_username> <message>     (admin only)
  /ai clear_memory <chatId>                              (admin only)
  /ai export_memory <chatId>                             (admin only)

Type /ai help for this message.
`;
      return sendText(ctx, help);
    }

    /* CHAT */
    if (mode === 'chat') {
      if (!rest) return sendText(ctx, 'Provide prompt: /ai chat [model] <prompt>');
      let modelKey = 'llama2';
      let prompt = rest;
      const tokens = rest.split(' ');
      if (tokens.length > 1 && HF_MODEL_MAP[tokens[0].toLowerCase()]) {
        modelKey = tokens[0].toLowerCase();
        prompt = tokens.slice(1).join(' ');
      }
      if (!prompt) return sendText(ctx, 'Provide prompt after model name.');

      const mem = await getMemory(ctx.from.id);
      mem.push({ role: 'user', content: prompt });
      const context = mem.map(m => `${m.role}: ${m.content}`).join('\n');

      let answer = null;

      if (process.env.HF_SPACE_URL) {
        try { answer = await withTyping(() => callHfSpace(context, process.env.HF_SPACE_URL)); } catch (e) { console.warn('HF Space error', e.message); }
      }

      if (!answer && process.env.HUGGINGFACE_API_KEY) {
        const hfModelUrl = HF_MODEL_MAP[modelKey] || HF_MODEL_MAP.default;
        if (hfModelUrl) {
          try { answer = await withTyping(() => callHfApi(context, hfModelUrl)); } catch (e) { console.warn('HF API error', e.message); }
        }
      }

      if (!answer && process.env.REPLICATE_API_KEY) {
        try {
          const repKey = {
            llama2: 'REPLICATE_CHAT_MODEL_LLAMA2',
            mistral: 'REPLICATE_CHAT_MODEL_MISTRAL',
            gpt5: 'REPLICATE_CHAT_MODEL_GPT5',
            gpt4: 'REPLICATE_CHAT_MODEL_GPT4',
            gpt35: 'REPLICATE_CHAT_MODEL_GPT35'
          }[modelKey] || 'REPLICATE_CHAT_MODEL_GPT5';
          const repModel = process.env[repKey];
          if (repModel) {
            const created = await withTyping(() => callReplicateCreate(repModel, { prompt }));
            if (created?.id) {
              const progressEditor = createReplicateProgressEditorFactory(ctx);
              const polled = await pollReplicatePrediction(created.id, progressEditor);
              const out = safeFirst(polled.output) || JSON.stringify(polled);
              answer = String(out);
            } else if (created?.output && created.output.length) {
              answer = String(created.output[0]);
            } else {
              answer = 'Replicate job started (no immediate output).';
            }
          }
        } catch (e) { console.warn('Replicate chat error:', e.message); }
      }

      if (!answer) {
        const g = await googleSearch(prompt, 3);
        if (g) answer = `Google quick results:\n\n${g}`;
        else {
          const w = await wikiSummary(prompt);
          const d = await duckDuck(prompt);
          answer = `${w}\n\nDuck summary:\n${d}`;
        }
      }

      mem.push({ role: 'assistant', content: answer });
      await saveMemory(ctx.from.id, mem);
      return sendText(ctx, answer);
    }

    /* WIKI */
    if (mode === 'wiki') {
      if (!rest) return sendText(ctx, 'Usage: /ai wiki <topic>');
      const out = await withTyping(() => wikiSummary(rest));
      return sendText(ctx, out);
    }

    /* DUCK */
    if (mode === 'duck') {
      if (!rest) return sendText(ctx, 'Usage: /ai duck <query>');
      const out = await withTyping(() => duckDuck(rest));
      return sendText(ctx, out);
    }

    /* GOOGLE (no key, scraped) */
    if (mode === 'google') {
      if (!rest) return sendText(ctx, 'Usage: /ai google <query>');
      const out = await withTyping(() => googleSearch(rest, 4));
      if (!out) return sendText(ctx, 'No google results found (or failed).');
      return sendText(ctx, out);
    }

    /* TRANSLATE */
    if (mode === 'translate') {
      if (!rest) return sendText(ctx, 'Usage: /ai translate [lang] <text>');
      const toks = rest.split(' ');
      let to = 'en';
      let text = rest;
      if (toks.length > 1 && toks[0].length <= 3) {
        to = toks[0];
        text = toks.slice(1).join(' ');
      }
      const t = await withTyping(() => translateUnofficial(text, to));
      return sendText(ctx, t);
    }

    /* TTS */
    if (mode === 'tts' || mode === 'voice') {
      if (!rest) return sendText(ctx, 'Usage: /ai tts <text>');
      // ElevenLabs first
      if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
        try {
          const audio = await withTyping(() => elevenTTS(rest));
          return sendVoiceWithPrefix(ctx, audio, rest);
        } catch (e) { console.warn('ElevenLabs TTS failed:', e.message); }
      }
      // Replicate TTS fallback
      if (process.env.REPLICATE_API_KEY && process.env.REPLICATE_TTS_MODEL) {
        try {
          const created = await withTyping(() => callReplicateCreate(process.env.REPLICATE_TTS_MODEL, { text: rest }));
          if (created?.id) {
            const progressEditor = createReplicateProgressEditorFactory(ctx);
            const polled = await pollReplicatePrediction(created.id, progressEditor);
            const out = safeFirst(polled.output) || null;
            if (out) return sendVoiceWithPrefix(ctx, out, rest);
          } else if (created?.output?.[0]) {
            return sendVoiceWithPrefix(ctx, created.output[0], rest);
          }
        } catch (e) { console.warn('Replicate TTS error:', e.message); }
      }
      // Google Translate TTS fallback (sends a URL that Telegram will fetch)
      try {
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${process.env.TTS_LANG || 'en'}&client=tw-ob&q=${encodeURIComponent(rest)}`;
        return sendAudioWithCaption(ctx, ttsUrl, rest);
      } catch (e) {
        return sendText(ctx, 'No TTS provider configured.');
      }
    }

    /* MEDIA unified */
    if (mode === 'media') {
      const sub = parts[1] ? parts[1].toLowerCase() : null;
      const payload = parts.slice(2).join(' ');
      if (!sub || !payload) return sendText(ctx, 'Usage: /ai media <mode> <input>. Type /ai help for modes.');

      const runwayModes = ['t2i','t2v','i2v','v2v','upscale','act'];
      const repModes = ['flux','fixface','caption','burncaption','recon3d'];

      // Runway branch
      if (runwayModes.includes(sub) && process.env.RUNWAY_API_KEY) {
        try {
          let endpoint, model;
          switch (sub) {
            case 't2i': endpoint = process.env.RUNWAY_URL_TEXT_TO_IMAGE; model = process.env.RUNWAY_MODEL_TEXT_TO_IMAGE; break;
            case 't2v': endpoint = process.env.RUNWAY_URL_TEXT_TO_VIDEO; model = process.env.RUNWAY_MODEL_TEXT_TO_VIDEO; break;
            case 'i2v': endpoint = process.env.RUNWAY_URL_IMAGE_TO_VIDEO; model = process.env.RUNWAY_MODEL_IMAGE_TO_VIDEO; break;
            case 'v2v': endpoint = process.env.RUNWAY_URL_VIDEO_TO_VIDEO; model = process.env.RUNWAY_MODEL_VIDEO_TO_VIDEO; break;
            case 'upscale': endpoint = process.env.RUNWAY_URL_VIDEO_UPSCALE; model = process.env.RUNWAY_MODEL_VIDEO_UPSCALE; break;
            case 'act': endpoint = process.env.RUNWAY_URL_CHARACTER_PERFORMANCE; model = process.env.RUNWAY_MODEL_CHARACTER_PERFORMANCE; break;
          }
          const res = await withTyping(() => callRunway(endpoint, model, (sub==='t2i' || sub==='t2v') ? { prompt: payload } : (sub==='i2v' ? { image_url: payload } : { video_url: payload })));
          const out = safeFirst(res.output) || res.output;
          if (!out) return sendText(ctx, 'Runway returned no output yet.');
          if (sub === 't2i') return sendPhotoWithCaption(ctx, out, payload);
          return sendVideoWithCaption(ctx, out, payload);
        } catch (e) {
          return sendText(ctx, 'Runway media error: ' + e.message);
        }
      }

      // Replicate branch
      if (repModes.includes(sub) && process.env.REPLICATE_API_KEY) {
        try {
          let repModel;
          switch (sub) {
            case 'flux': repModel = process.env.REPLICATE_IMAGE_MODEL; break;
            case 'fixface': repModel = process.env.REPLICATE_UPSCALE_MODEL; break;
            case 'caption': repModel = process.env.REPLICATE_VIDEO_CAPTION_MODEL; break;
            case 'burncaption': repModel = process.env.REPLICATE_VIDEO_CAPTIONED_MODEL; break;
            case 'recon3d': repModel = process.env.REPLICATE_3D_MODEL; break;
          }
          if (!repModel) return sendText(ctx, 'Replicate model not set for this mode.');

          // placeholder to allow caption edits
          let placeholder = null;
          try {
            if (sub === 'flux' || sub === 'fixface') {
              placeholder = await ctx.replyWithPhoto('https://placehold.co/512x512?text=Processing', { caption: withPrefix('Processing...') });
            } else {
              placeholder = await ctx.reply(withPrefix('Replicate job started, processing...'));
            }
          } catch (e) {
            placeholder = null;
          }

          const created = await withTyping(() => callReplicateCreate(repModel, (sub==='flux') ? { prompt: payload } : (sub==='fixface' ? { image: payload } : { video: payload })));
          if (created?.id) {
            const progressEditor = createReplicateProgressEditorFactory(ctx, placeholder);
            const polled = await pollReplicatePrediction(created.id, progressEditor);
            const out = safeFirst(polled.output) || null;
            if (!out) return sendText(ctx, 'Replicate finished but produced no output.');
            if (sub === 'flux' || sub === 'fixface') {
              if (placeholder && placeholder.message_id) {
                try {
                  await ctx.telegram.editMessageMedia(ctx.chat.id, placeholder.message_id, undefined, { type: 'photo', media: out });
                  await ctx.telegram.editMessageCaption(ctx.chat.id, placeholder.message_id, undefined, withPrefix(payload));
                  return;
                } catch (e) {
                  return sendPhotoWithCaption(ctx, out, payload);
                }
              } else {
                return sendPhotoWithCaption(ctx, out, payload);
              }
            }
            if (sub === 'recon3d') return sendDocumentWithCaption(ctx, out, payload);
            if (sub === 'caption') return sendText(ctx, out);
            return sendVideoWithCaption(ctx, out, payload);
          } else if (created?.output?.[0]) {
            const out = created.output[0];
            if (sub === 'flux' || sub === 'fixface') return sendPhotoWithCaption(ctx, out, payload);
            if (sub === 'recon3d') return sendDocumentWithCaption(ctx, out, payload);
            if (sub === 'caption') return sendText(ctx, out);
            return sendVideoWithCaption(ctx, out, payload);
          } else {
            return sendText(ctx, 'Replicate started job; check dashboard.');
          }
        } catch (e) {
          return sendText(ctx, 'Replicate media error: ' + e.message);
        }
      }

      // t2i fallback: Stability -> Pixabay -> Unsplash
      if (sub === 't2i') {
        if (process.env.STABILITY_KEY) {
          try {
            const buff = await withTyping(() => callStabilityImage(payload));
            return sendPhotoWithCaption(ctx, { source: Buffer.from(buff) }, payload);
          } catch (e) { console.warn('Stability error', e.message); }
        }
        if (process.env.PIXABAY_KEY) {
          try {
            const hits = await withTyping(() => pixabaySearch(payload));
            if (hits.length) return sendPhotoWithCaption(ctx, hits[0].largeImageURL, payload);
          } catch (e) { console.warn('Pixabay error', e.message); }
        }
        // Unsplash public fallback
        try {
          return sendPhotoWithCaption(ctx, unsplashRandom(payload), payload + ' (Unsplash fallback)');
        } catch (e) { console.warn('Unsplash fallback failed:', e.message); }
      }

      return sendText(ctx, 'No provider configured for that media mode or provider returned no output.');
    }

    /* Replicate direct */
    if (mode === 'replicate') {
      const repEnv = parts[1];
      const promptText = parts.slice(2).join(' ');
      if (!repEnv || !promptText) return sendText(ctx, 'Usage: /ai replicate <ENV_VAR_NAME> <prompt>');
      const repModel = process.env[repEnv];
      if (!repModel) return sendText(ctx, `No replicate model found in env as ${repEnv}`);
      try {
        const placeholder = await ctx.reply(withPrefix('Replicate job started, polling until done...'));
        const created = await withTyping(() => callReplicateCreate(repModel, { prompt: promptText }));
        if (created?.id) {
          const progressEditor = createReplicateProgressEditorFactory(ctx, placeholder);
          const polled = await pollReplicatePrediction(created.id, progressEditor);
          const out = safeFirst(polled.output) || JSON.stringify(polled);
          return sendText(ctx, String(out));
        } else if (created?.output?.[0]) {
          return sendText(ctx, String(created.output[0]));
        } else {
          return sendText(ctx, 'Replicate responded: ' + JSON.stringify(created).slice(0, 3000));
        }
      } catch (e) {
        return sendText(ctx, 'Replicate error: ' + e.message);
      }
    }

    /* ADMIN: post / clear_memory / export_memory */
    if (mode === 'post') {
      const userId = ctx.from.id;
      if (!isAdmin(userId)) return sendText(ctx, 'Admin only command.');
      const channel = parts[1];
      const message = parts.slice(2).join(' ');
      if (!channel || !message) return sendText(ctx, 'Usage: /ai post <@channel_or_channelusername> <message>');
      try {
        await bot.telegram.sendMessage(channel, withPrefix(message), { parse_mode: 'HTML' });
        return sendText(ctx, 'Posted to ' + channel);
      } catch (e) {
        return sendText(ctx, 'Failed to post: ' + e.message);
      }
    }

    if (mode === 'clear_memory') {
      const userId = ctx.from.id;
      if (!isAdmin(userId)) return sendText(ctx, 'Admin only command.');
      const target = parts[1] || String(ctx.from.id);
      await clearMemory(target);
      return sendText(ctx, `Cleared memory for ${target}`);
    }

    if (mode === 'export_memory') {
      const userId = ctx.from.id;
      if (!isAdmin(userId)) return sendText(ctx, 'Admin only command.');
      const target = parts[1] || String(ctx.from.id);
      const mem = await getMemory(target);
      return sendText(ctx, `Memory for ${target}:\n${JSON.stringify(mem).slice(0, 4000)}`);
    }

    return sendText(ctx, 'Unknown mode. Type /ai help for usage.');
  } catch (err) {
    console.error('AI handler error', err);
    return sendText(ctx, 'Error: ' + (err && err.message ? err.message : String(err)));
  }
});

///////////////////////////////////////////////////////////////////////////////
// Express + webhook route (Render)
///////////////////////////////////////////////////////////////////////////////
const app = express();
app.use(compression());
app.use(helmet());
app.use(express.json());

app.get('/', (req, res) => res.send('Belaynish bot is alive (Render)'));
app.get('/health', (req, res) => res.send('ok'));

// webhook endpoint is secret: /webhook/<WEBHOOK_PATH>
app.post(`/webhook/${WEBHOOK_PATH}`, async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook handling error', e);
    res.sendStatus(500);
  }
});

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  if (WEBHOOK_URL) {
    try {
      const webhookFull = `${WEBHOOK_URL.replace(/\/$/, '')}/webhook/${WEBHOOK_PATH}`;
      console.log('Attempting to set Telegram webhook to:', webhookFull);
      await bot.telegram.setWebhook(webhookFull);
      console.log('Webhook set successfully.');
    } catch (e) {
      console.warn('Failed to set webhook automatically:', e.message);
    }
  } else {
    console.log('WEBHOOK_URL not set. Register manually:');
    console.log(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=<YOUR_RENDER_URL>/webhook/${WEBHOOK_PATH}`);
  }
});
