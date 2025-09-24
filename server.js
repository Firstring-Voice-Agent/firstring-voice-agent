import 'dotenv/config';
import http from 'http';
import express from 'express';
import { XMLBuilder } from 'fast-xml-parser';
import { WebSocketServer, WebSocket } from 'ws';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

// IMPORTANT: use WHATWG URL API (avoids the deprecation warning)
const parsePathname = (req) => {
  try {
    const u = new URL(req.url, 'https://placeholder.local');
    return u.pathname;
  } catch {
    return '/';
  }
}

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

// Health
app.get('/healthz', (_, res) => res.status(200).send('ok'));

// Twilio Voice Webhook -> returns TwiML with <Connect><Stream>
app.post('/twilio/voice', (req, res) => {
  log('info', 'HTTP_POST /twilio/voice', { from: req.body?.From, to: req.body?.To });

  if (!PUBLIC_BASE_URL) {
    log('error', 'PUBLIC_BASE_URL missing');
    return res.status(500).send('Server config error');
  }

  // Force wss:// for Twilio Media Streams (CRITICAL)
  const root = PUBLIC_BASE_URL.replace(/\/+$/, ''); // no trailing slash
  const wssRoot = root.replace(/^http/i, 'ws');     // https:// -> wss://
  const streamUrl = `${wssRoot}/stream`;

  const twimlObj = {
    Response: {
      Connect: {
        Stream: {
          '@_url': streamUrl,
          '@_track': 'inbound_track' // valid value for <Connect><Stream>
        }
      }
    }
  };

  const twiml = xml(twimlObj);
  log('info', 'Responding with <Stream>', { url: streamUrl });
  res.set('Content-Type', 'application/xml').status(200).send(twiml);
});

// --- HTTP server + single WS server ---
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = parsePathname(request);
  if (pathname === '/stream') {
    log('info', 'WS_UPGRADE /stream');
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// --- Helpers for outbound audio framing ---
const ULawSilence = 0xFF; // μ-law silence byte
const FRAME_BYTES = 160;   // 20ms @ 8000 Hz μ-law mono

// Pad buffer to a multiple of 160 bytes (pad with μ-law silence)
const padToFrame = (buf) => {
  const rem = buf.length % FRAME_BYTES;
  if (rem === 0) return buf;
  const pad = Buffer.alloc(FRAME_BYTES - rem, ULawSilence);
  return Buffer.concat([buf, pad]);
};

// Build a few priming frames of silence to avoid “static burst”
const buildSilence = (frames = 3) => Buffer.alloc(FRAME_BYTES * frames, ULawSilence);

// --- Outbound audio sender (to Twilio) ---
const startAudioSender = (ws, streamSid) => {
  let queue = [];
  let sending = false;

  // Twilio is strict about timing/length. We:
  // - send 3 silent frames first,
  // - then 20ms per 160-byte frame,
  // - explicitly mark outbound track and contentType.
  const primeIfNeeded = () => {
    if (queue._primed) return;
    queue.unshift(...chunkToFrames(buildSilence(3)));
    queue._primed = true;
  };

  const chunkToFrames = (buf) => {
    const frames = [];
    const padded = padToFrame(buf);
    for (let i = 0; i < padded.length; i += FRAME_BYTES) {
      frames.push(padded.subarray(i, i + FRAME_BYTES));
    }
    return frames;
  };

  const sendChunk = () => {
    if (!queue.length || ws.readyState !== WebSocket.OPEN) {
      sending = false;
      return;
    }
    const frame = queue.shift();
    const payload = frame.toString('base64');

    const msg = {
      event: 'media',
      streamSid,
      // Some implementations require declaring outbound explicitly:
      track: 'outbound',
      media: {
        // Twilio expects μ-law 8k; contentType is helpful/harmless on WS.
        contentType: 'audio/x-mulaw;rate=8000',
        payload
      }
    };

    ws.send(JSON.stringify(msg));
    setTimeout(sendChunk, 20);
  };

  return {
    enqueue: (buf) => {
      primeIfNeeded();
      const frames = chunkToFrames(buf);
      queue.push(...frames);
      if (!sending) { sending = true; sendChunk(); }
    },
    clear: () => { queue = []; queue._primed = false; }
  };
};

// --- LLM reply (unchanged) ---
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
    console.warn('LLM_FALLBACK', err?.response?.data || err?.message);
    return "Okay. How can I help?";
  }
};

// --- TTS (ElevenLabs ulaw_8000, fallback to OpenAI -> μ-law) ---
const synthesizeUlaw8000 = async (text) => {
  // Try ElevenLabs (already μ-law 8k)
  if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) {
    try {
      const el = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
        { text, model_id: 'eleven_turbo_v2_5', output_format: 'ulaw_8000' },
        { headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 20000 }
      );
      if (el.status === 200 && el.data?.byteLength) return Buffer.from(el.data);
    } catch (err) {
      console.warn('ELEVENLABS_TTS_FAIL', err?.response?.data || err?.message);
    }
  }
  // Fallback: OpenAI TTS -> PCM -> downsample -> μ-law
  try {
    if (!OPENAI_API_KEY) throw new Error('No OPENAI_API_KEY');
    const tts = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      { model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, format: 'pcm' },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 25000 }
    );
    const pcm = Buffer.from(tts.data); // 24k PCM16LE
    const down = downsamplePCM16LE(pcm, 24000, 8000);
    return pcm16ToUlaw(down);
  } catch (err) {
    console.error('OPENAI_TTS_FAIL', err?.response?.data || err?.message);
    return Buffer.alloc(0);
  }
};

// --- DSP helpers (unchanged) ---
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
    out.writeInt16LE(sample, o);
    o += 2;
  }
  return out.subarray(0, o);
};

// --- Deepgram connection (unchanged) ---
import { WebSocket as WSClient } from 'ws';
const connectDeepgram = () => {
  const u = 'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2-general&punctuate=true&smart_format=true';
  const headers = { Authorization: `Token ${DEEPGRAM_API_KEY}` };
  return new WSClient(u, { headers });
};

// --- WS lifecycle (single instance) ---
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
      log('info', 'WS_START', { connId, streamSid, callSid: msg?.start?.callSid });
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

// Start server
server.listen(PORT, () => {
  log('info', 'Server listening', {
    PORT,
    PUBLIC_BASE_URL,
    HAVE_DG: !!DEEPGRAM_API_KEY,
    HAVE_OAI: !!OPENAI_API_KEY,
    HAVE_XI: !!ELEVENLABS_API_KEY,
    VOICE: ELEVENLABS_VOICE_ID
  });
});
