import 'dotenv/config';
import http from 'http';
import express from 'express';
import { XMLBuilder } from 'fast-xml-parser';
import { WebSocketServer, WebSocket, WebSocket as WSClient } from 'ws';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

// Safe URL pathname helper (WHATWG)
const pathOf = (req) => {
  try { return new URL(req.url, 'https://placeholder.local').pathname; }
  catch { return '/'; }
};

const {
  PORT = 10000,
  PUBLIC_BASE_URL,
  OPENAI_API_KEY,
  DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY,      // not used while FORCE_TTS_OPENAI=1
  ELEVENLABS_VOICE_ID,     // not used while FORCE_TTS_OPENAI=1
  BUSINESS_NAME = 'Your Business',
  LOG_LEVEL = 'debug',
  // Keep OpenAI-only TTS while we verify audio path
  FORCE_TTS_OPENAI = '1'
} = process.env;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const log = (level, msg, extra = {}) => {
  const levels = ['error','warn','info','debug'];
  if (levels.indexOf(level) <= levels.indexOf(LOG_LEVEL)) {
    const ts = new Date().toISOString();
    console.log(`${ts} ${level.toUpperCase()} ${msg}`, Object.keys(extra).length ? extra : '');
  }
};

const xml = (obj) => new XMLBuilder({ ignoreAttributes: false }).build(obj);

// ---------------- Health
app.get('/healthz', (_, res) => res.status(200).send('ok'));

// ---------------- Twilio Voice webhook → <Connect><Stream>
app.post('/twilio/voice', (req, res) => {
  log('info', 'HTTP_POST /twilio/voice', { from: req.body?.From, to: req.body?.To });
  if (!PUBLIC_BASE_URL) return res.status(500).send('Missing PUBLIC_BASE_URL');

  const root = PUBLIC_BASE_URL.replace(/\/+$/, '');
  const wssRoot = root.replace(/^http/i, 'ws');
  const streamUrl = `${wssRoot}/stream`;

  // Valid per Twilio for <Connect><Stream>
  const twimlObj = {
    Response: {
      Connect: {
        Stream: { '@_url': streamUrl, '@_track': 'inbound_track' }
      }
    }
  };

  const twiml = xml(twimlObj);
  log('info', 'Responding with <Stream>', { url: streamUrl });
  res.type('application/xml').status(200).send(twiml);
});

// ---------------- HTTP + single WS server
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  if (pathOf(request) === '/stream') {
    log('info', 'WS_UPGRADE /stream');
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } else {
    socket.destroy();
  }
});

// ---------------- μ-law helpers
const ULawSilence = 0xFF;          // μ-law silence byte
const FRAME_BYTES = 160;            // 20ms @ 8000 Hz μ-law mono

const buildSilence = (frames = 3) => Buffer.alloc(FRAME_BYTES * frames, ULawSilence);

const padToFrame = (buf) => {
  const rem = buf.length % FRAME_BYTES;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(FRAME_BYTES - rem, ULawSilence)]);
};

const toFrames = (buf) => {
  const p = padToFrame(buf);
  const out = [];
  for (let i = 0; i < p.length; i += FRAME_BYTES) out.push(p.subarray(i, i + FRAME_BYTES));
  return out;
};

// PCM16LE → μ-law (G.711) encoder
const pcm16ToUlaw = (pcmBuf) => {
  const BIAS = 0x84, CLIP = 32635;
  const out = Buffer.alloc(Math.floor(pcmBuf.length / 2));
  for (let i = 0, j = 0; i < pcmBuf.length; i += 2, j++) {
    let s = pcmBuf.readInt16LE(i);
    if (s > CLIP) s = CLIP; else if (s < -CLIP) s = -CLIP;
    const sign = s < 0 ? 0x80 : 0x00;
    if (s < 0) s = -s;
    s += BIAS;
    let exp = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
    const mant = (s >> ((exp === 0) ? 4 : (exp + 3))) & 0x0F;
    out[j] = ~(sign | (exp << 4) | mant) & 0xFF;
  }
  return out;
};

// Crude decimator 24k → 8k (good enough for TTS Voice)
const downsamplePCM16LE = (pcmBuf, srcRate, dstRate) => {
  if (srcRate === dstRate) return pcmBuf;
  const ratio = srcRate / dstRate;
  const out = Buffer.alloc(Math.floor(pcmBuf.length / 2 / ratio) * 2);
  let o = 0;
  for (let i = 0; i + 2 <= pcmBuf.length; i += 2 * ratio) {
    const s = pcmBuf.readInt16LE(Math.floor(i));
    out.writeInt16LE(s, o); o += 2;
  }
  return out.subarray(0, o);
};

// ---------------- Deepgram (inbound μ-law@8k)
const connectDeepgram = () => {
  const u = 'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2-general&punctuate=true&smart_format=true';
  return new WSClient(u, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
};

// ---------------- TTS (OpenAI-only while we debug)
const synthesizeUlaw8000 = async (text) => {
  try {
    if (!OPENAI_API_KEY) throw new Error('No OPENAI_API_KEY');
    const tts = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      { model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, format: 'pcm' },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 25000 }
    );
    const pcm24k = Buffer.from(tts.data);                // PCM16LE @ 24k
    const ulaw = pcm16ToUlaw(downsamplePCM16LE(pcm24k, 24000, 8000));
    // Diagnostics: confirm it's raw μ-law (no RIFF)
    log('info', 'TTS_DIAG', { first8hex: ulaw.subarray(0,8).toString('hex'), bytes: ulaw.length });
    return ulaw;
  } catch (err) {
    log('error', 'OPENAI_TTS_FAIL', { err: err?.response?.data || err?.message });
    return Buffer.alloc(0);
  }
};

// ---------------- Sender to Twilio (strict schema Twilio expects)
const startAudioSender = (ws, streamSid) => {
  let q = []; let sending = false; let primed = false;

  const tick = () => {
    if (!q.length || ws.readyState !== WebSocket.OPEN) { sending = false; return; }
    const frame = q.shift();
    ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: frame.toString('base64') } }));
    setTimeout(tick, 20);
  };

  return {
    enqueue: (buf) => {
      if (!primed) { primed = true; q.push(...toFrames(buildSilence(3))); }
      const frames = toFrames(buf);
      q.push(...frames);
      log('info', 'FRAME_COUNT', { frames: frames.length, bytes: buf.length });
      if (!sending) { sending = true; tick(); }
    },
    clear: () => { q = []; primed = false; }
  };
};

// ---------------- LLM
const generateReply = async (userText) => {
  if (!OPENAI_API_KEY) return "I'm here. How can I help?";
  try {
    const system = `You are a friendly, concise voice receptionist for ${BUSINESS_NAME}.
- Be brief (1–2 sentences).
- Confirm intent.
- Offer to take a message or book an appointment.`;
    const payload = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText || 'Hello' }
      ],
      temperature: 0.3,
      max_tokens: 120
    };
    const resp = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
    });
    return resp.data?.choices?.[0]?.message?.content?.trim() || "Okay. How can I help?";
  } catch (err) {
    log('warn', 'LLM_FALLBACK', { err: err?.response?.data || err?.message });
    return "Okay. How can I help?";
  }
};

// ---------------- WS lifecycle
wss.on('connection', (ws, request) => {
  const connId = uuidv4().slice(0, 8);
  log('info', 'WS_CONNECTED', { connId, ip: request.socket.remoteAddress });

  let streamSid = null;
  let dg = null;
  let sender = null;

  const ensureDG = () => {
    if (dg) return;
    if (!DEEPGRAM_API_KEY) { log('warn', 'DG_SKIP (no key)'); return; }
    dg = connectDeepgram();
    log('info', 'DG_CONNECT', { connId });
    dg.on('open', () => log('info', 'DG_OPEN', { connId }));
    dg.on('close', () => log('info', 'DG_CLOSE', { connId }));
    dg.on('error', (err) => log('error', 'DG_ERROR', { err: err?.message }));
    dg.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const alt = msg?.channel?.alternatives?.[0];
        const isFinal = msg?.is_final || msg?.speech_final;
        const transcript = (alt?.transcript || '').trim();
        if (isFinal && transcript) {
          log('info', 'DG_FINAL', { transcript });
          const reply = await generateReply(transcript);
          const ulaw = await synthesizeUlaw8000(reply);
          log('info', 'TTS_OK', { bytes: ulaw.length, text: reply });
          if (sender && streamSid && ulaw?.length) sender.enqueue(ulaw);
        }
      } catch { /* ignore parse issues */ }
    });
  };

  ws.on('message', (frame) => {
    let msg; try { msg = JSON.parse(frame.toString()); } catch { return; }
    const event = msg?.event;

    if (event === 'start') {
      streamSid = msg?.start?.streamSid;
      log('info', 'WS_START', {
        connId, streamSid, callSid: msg?.start?.callSid, tracks: msg?.start?.tracks
      });
      sender = startAudioSender(ws, streamSid);
    } else if (event === 'media') {
      ensureDG();
      if (dg && dg.readyState === WebSocket.OPEN) {
        const b = Buffer.from(msg.media.payload, 'base64');
        dg.send(b);
      }
    } else if (event === 'stop') {
      log('info', 'WS_STOP', { connId, streamSid });
      try { dg?.close(); } catch {}
      try { ws?.close(); } catch {}
    }
  });

  ws.on('close', () => { log('info', 'WS_CLOSE', { connId, streamSid }); try { dg?.close(); } catch {} });
  ws.on('error', (err) => { log('error', 'WS_ERROR', { connId, err: err?.message }); try { dg?.close(); } catch {} });
});

// ---------------- Start
server.listen(PORT, () => {
  log('info', 'Server listening', {
    PORT, PUBLIC_BASE_URL,
    HAVE_DG: !!DEEPGRAM_API_KEY, HAVE_OAI: !!OPENAI_API_KEY,
    HAVE_XI: !!ELEVENLABS_API_KEY, VOICE: ELEVENLABS_VOICE_ID
  });
});
