import 'dotenv/config';
import http from 'http';
import express from 'express';
import { XMLBuilder } from 'fast-xml-parser';
import { WebSocketServer, WebSocket, WebSocket as WSClient } from 'ws';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

// URL pathname helper (WHATWG, avoids deprecation)
const pathOf = (req) => {
  try { return new URL(req.url, 'https://placeholder.local').pathname; }
  catch { return '/'; }
};

const {
  PORT = 10000,
  PUBLIC_BASE_URL,
  OPENAI_API_KEY,
  DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  BUSINESS_NAME = 'Your Business',
  LOG_LEVEL = 'debug'
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

// -------- Health
app.get('/healthz', (_, res) => res.status(200).send('ok'));

// -------- Twilio Voice webhook → return TwiML <Connect><Stream>
app.post('/twilio/voice', (req, res) => {
  log('info', 'HTTP_POST /twilio/voice', { from: req.body?.From, to: req.body?.To });

  if (!PUBLIC_BASE_URL) return res.status(500).send('Missing PUBLIC_BASE_URL');

  const root = PUBLIC_BASE_URL.replace(/\/+$/, '');
  const wssRoot = root.replace(/^http/i, 'ws');
  const streamUrl = `${wssRoot}/stream`;

  // For bidirectional Streams (<Connect><Stream>), Twilio only allows inbound_track. (Docs)
  // https://www.twilio.com/docs/voice/twiml/stream
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

// -------- HTTP server + single WS server
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

// -------- μ-law framing helpers
const ULawSilence = 0xFF;          // μ-law silence byte
const FRAME_BYTES = 160;            // 20ms @ 8000 Hz μ-law mono
const buildSilence = (frames=3) => Buffer.alloc(FRAME_BYTES * frames, ULawSilence);
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

// -------- Strip WAV/RIFF header if present (Twilio requires raw μ-law, no headers)
// Docs: payload must be raw audio/x-mulaw;rate=8000, base64 (no headers).
// https://www.twilio.com/docs/voice/media-streams/websocket-messages
const stripContainerIfAny = (buf) => {
  if (!buf || buf.length < 12) return buf;
  // 'RIFF'....'WAVE'    (Classic WAV)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45) {
    // Walk RIFF chunks until 'data'
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.slice(off, off + 4).toString('ascii');
      const size = buf.readUInt32LE(off + 4);
      off += 8;
      if (id === 'data') {
        // Return exactly the data chunk (avoid trailing container bytes)
        return buf.subarray(off, Math.min(off + size, buf.length));
      }
      off += size + (size % 2); // chunks are word aligned
    }
    // Fallback: if no 'data' found, return original
    return buf;
  }
  // If other container signatures (Ogg/ID3), just return original (we don't expect these for ulaw_8000)
  return buf;
};

// -------- Convert PCM16LE → μ-law (fallback path)
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

const downsamplePCM16LE = (pcmBuf, srcRate, dstRate) => {
  if (srcRate === dstRate) return pcmBuf;
  const ratio = srcRate / dstRate;
  const out = Buffer.alloc(Math.floor(pcmBuf.length / 2 / ratio) * 2);
  let o = 0;
  for (let i = 0; i + 2 <= pcmBuf.length; i += 2 * ratio) {
    const sample = pcmBuf.readInt16LE(Math.floor(i));
    out.writeInt16LE(sample, o); o += 2;
  }
  return out.subarray(0, o);
};

// -------- Deepgram (inbound μ-law@8k)
const connectDeepgram = () => {
  const u = 'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2-general&punctuate=true&smart_format=true';
  return new WSClient(u, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
};

// -------- TTS: ElevenLabs μ-law 8k (strip container) → fallback OpenAI (PCM24k→μ-law)
const synthesizeUlaw8000 = async (text) => {
  // Primary: ElevenLabs ulaw_8000 (may be raw or WAV-wrapped)
  if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) {
    try {
      const el = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
        { text, model_id: 'eleven_turbo_v2_5', output_format: 'ulaw_8000' },
        { headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 20000 }
      );
      let raw = Buffer.from(el.data);
      raw = stripContainerIfAny(raw);  // <— critical: remove RIFF/WAVE if present
      return raw;
    } catch (err) {
      log('warn', 'ELEVENLABS_TTS_FAIL', { err: err?.response?.data || err?.message });
    }
  }

  // Fallback: OpenAI TTS -> PCM 24k -> downsample -> μ-law
  try {
    if (!OPENAI_API_KEY) throw new Error('No OPENAI_API_KEY');
    const tts = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      { model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, format: 'pcm' },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 25000 }
    );
    const pcm = Buffer.from(tts.data);        // PCM16LE @ 24k
    const down = downsamplePCM16LE(pcm, 24000, 8000);
    return pcm16ToUlaw(down);
  } catch (err) {
    log('error', 'OPENAI_TTS_FAIL', { err: err?.response?.data || err?.message });
    return Buffer.alloc(0);
  }
};

// -------- Outbound sender (to Twilio) — strict Twilio format
const startAudioSender = (ws, streamSid) => {
  let q = []; let sending = false; let primed = false;

  const tick = () => {
    if (!q.length || ws.readyState !== WebSocket.OPEN) { sending = false; return; }
    const frame = q.shift();
    const payload = frame.toString('base64');

    // Twilio expects: event, streamSid, media.payload (raw μ-law/8000, base64)
    // https://www.twilio.com/docs/voice/media-streams/websocket-messages
    ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
    setTimeout(tick, 20);
  };

  return {
    enqueue: (buf) => {
      if (!primed) { primed = true; q.push(...toFrames(buildSilence(3))); }
      q.push(...toFrames(buf));
      if (!sending) { sending = true; tick(); }
    },
    clear: () => { q = []; primed = false; }
  };
};

// -------- LLM reply
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

// -------- WS lifecycle
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
      } catch { /* ignore */ }
    });
  };

  ws.on('message', (frame) => {
    let msg; try { msg = JSON.parse(frame.toString()); } catch { return; }
    const event = msg?.event;

    if (event === 'start') {
      streamSid = msg?.start?.streamSid;
      log('info', 'WS_START', { connId, streamSid, callSid: msg?.start?.callSid, tracks: msg?.start?.tracks });
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

// -------- Start server
server.listen(PORT, () => {
  log('info', 'Server listening', {
    PORT, PUBLIC_BASE_URL,
    HAVE_DG: !!DEEPGRAM_API_KEY, HAVE_OAI: !!OPENAI_API_KEY,
    HAVE_XI: !!ELEVENLABS_API_KEY, VOICE: ELEVENLABS_VOICE_ID
  });
});
