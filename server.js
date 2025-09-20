import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer, WebSocket } from 'ws';
import axios from 'axios';
import { XMLBuilder } from 'fast-xml-parser';
import http from 'http';

const {
  PORT = 8080,
  PUBLIC_BASE_URL,
  OPENAI_API_KEY,
  DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  N8N_BASE,
  BUSINESS_ID = 'plumber_joes',
  BUSINESS_NAME = "Plumber Joe's",
  CAL_SUMMARY_PREFIX = 'Job',
  TWILIO_AUTH_TOKEN
} = process.env;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Noisy health endpoints
app.get('/', (_, res) => { console.log('HTTP_GET /'); res.send('ok'); });
app.get('/healthz', (_, res) => { console.log('HTTP_GET /healthz'); res.send('ok'); });

// ---- Twilio signature verification (POST only)
function verifyTwilio(req) {
  if (!TWILIO_AUTH_TOKEN) return true;
  try {
    const url = `${PUBLIC_BASE_URL}/twilio/voice`;
    const paramsConcat = Object.keys(req.body)
      .sort()
      .map(k => k + (req.body[k] ?? ''))
      .join('');
    const expected = crypto
      .createHmac('sha1', TWILIO_AUTH_TOKEN)
      .update(url + paramsConcat, 'utf8')
      .digest('base64');
    const sig = req.headers['x-twilio-signature'];
    const ok = sig === expected;
    if (!ok) console.error('TWILIO_SIGNATURE_FAIL', { sig, expected });
    return ok;
  } catch (e) {
    console.error('TWILIO_SIGNATURE_ERR', e.message);
    return false;
  }
}

// Helper to build the Stream TwiML
function buildStreamTwiml(fromNumber = '') {
  const streamUrl = `${PUBLIC_BASE_URL.replace(/^http/, 'ws').replace(/\/$/, '')}/stream`;
  console.log('Responding with <Stream> url=', streamUrl);

  const xmlObj = {
    Response: {
      Connect: {
        Stream: {
          '@_url': streamUrl,
          '@_bidirectional': 'true',
          Parameter: [{ '@_name': 'caller', '@_value': fromNumber || '' }]
        }
      }
    }
  };
  const builder = new XMLBuilder({ ignoreAttributes: false });
  return builder.build(xmlObj);
}

// === NEW: GET handler so you (and Twilio, temporarily) can hit it via GET
app.get('/twilio/voice', (req, res) => {
  console.log('HTTP_GET /twilio/voice: received, From=', req.query?.From, 'PUBLIC_BASE_URL=', PUBLIC_BASE_URL);
  const xml = buildStreamTwiml(req.query?.From || '');
  res.type('text/xml').send(xml);
});

// POST handler (normal Twilio flow)
app.post('/twilio/voice', (req, res) => {
  console.log('HTTP_POST /twilio/voice: received, From=', req.body?.From, 'PUBLIC_BASE_URL=', PUBLIC_BASE_URL);
  if (!verifyTwilio(req)) return res.status(403).send('Bad signature');
  const xml = buildStreamTwiml(req.body?.From || '');
  res.type('text/xml').send(xml);
});

// ======= audio + TTS helpers (unchanged)
function encodeLinearToMuLaw(sample) {
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

async function ttsOpenAI(text) {
  if (!OPENAI_API_KEY) return new Uint8Array(0);
  try {
    console.log('TTS_OPENAI start, len=', text?.length);
    const r = await axios.post('https://api.openai.com/v1/audio/speech', {
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: text
    }, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
    const pcm16 = new Int16Array(new Uint8Array(r.data).buffer);
    const step = 3; // crude downsample
    const out = new Uint8Array(Math.floor(pcm16.length / step));
    for (let i = 0, j = 0; i < pcm16.length; i += step, j++) {
      const s = Math.max(-32768, Math.min(32767, pcm16[i]));
      out[j] = encodeLinearToMuLaw(s);
    }
    console.log('TTS_OPENAI ok bytes=', out.length);
    return out;
  } catch (e) {
    console.error('TTS_OPENAI_ERR', e?.response?.status, e?.response?.data || e.message);
    return new Uint8Array(0);
  }
}

async function ttsSynthesize(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.warn('TTS_11LABS missing key/voice, using OpenAI fallback');
    return await ttsOpenAI(text);
  }
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=4&output_format=ulaw_8000`;
  try {
    console.log('TTS_11LABS start, len=', text?.length);
    const r = await axios.post(
      url,
      {
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.65, similarity_boost: 0.78, style: 0.28, use_speaker_boost: true }
      },
      { responseType: 'arraybuffer', headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'content-type': 'application/json' } }
    );
    const ct = (r.headers?.['content-type'] || '').toLowerCase();
    if (ct.includes('application/json')) {
      console.error('TTS_11LABS_JSON', Buffer.from(r.data).toString('utf8'));
      return await ttsOpenAI(text);
    }
    const out = new Uint8Array(r.data);
    console.log('TTS_11LABS ok bytes=', out.length);
    return out;
  } catch (e) {
    let body = '';
    try { body = Buffer.from(e?.response?.data || []).toString('utf8'); } catch {}
    console.error('TTS_11LABS_ERR', e?.response?.status, body || e.message);
    return await ttsOpenAI(text);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wsSendMedia(ws, mulawBytes, streamSid) {
  if (!streamSid) { console.error('TWILIO_NO_STREAMSID'); return; }
  const chunkSize = 160; // 20ms @ 8kHz μ-law
  for (let i = 0; i < mulawBytes.length; i += chunkSize) {
    const chunk = mulawBytes.slice(i, i + chunkSize);
    const msg = { event: 'media', streamSid, media: { payload: Buffer.from(chunk).toString('base64') } };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    await sleep(20);
  }
}

async function llmReply(prompt, system = 'Stay concise. Ask only what you need to book a job.') {
  try {
    console.log('LLM_REPLY send');
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
    const out = r.data.choices?.[0]?.message?.content?.trim() || 'Got it.';
    console.log('LLM_REPLY ok');
    return out;
  } catch (e) {
    console.error('LLM_REPLY_ERR', e?.response?.status, e?.response?.data || e.message);
    return 'Okay.';
  }
}

function parseJsonLoose(text) {
  if (!text) return null;
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

async function llmExtract(text) {
  const prompt = `Extract strict JSON with fields:
  caller_name, suburb, job_type, urgency(one of: now,today,this_week,no_rush), preferred_time, call_summary.
  Only return JSON. Message:\n${text}`;
  try {
    console.log('LLM_EXTRACT send');
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [{ role: 'system', content: 'You output only strict JSON.' }, { role: 'user', content: prompt }]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
    const raw = r.data.choices?.[0]?.message?.content?.trim() || '{}';
    const parsed = parseJsonLoose(raw);
    console.log('LLM_EXTRACT ok');
    return parsed || { caller_name: '', suburb: '', job_type: '', urgency: 'this_week', preferred_time: '', call_summary: text.slice(0,800) };
  } catch (e) {
    console.error('LLM_EXTRACT_ERR', e?.response?.status, e?.response?.data || e.message);
    return { caller_name: '', suburb: '', job_type: '', urgency: 'this_week', preferred_time: '', call_summary: text.slice(0,800) };
  }
}

/* =========================
   WebSocket server (Twilio Media Streams)
   ========================= */
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => {
    // protocols may be Set, Array, or comma string depending on ws version
    let hasAudioStream = false;
    if (protocols && typeof protocols.has === 'function') {
      hasAudioStream = protocols.has('audio-stream');        // Set
    } else if (Array.isArray(protocols)) {
      hasAudioStream = protocols.includes('audio-stream');   // Array
    } else if (typeof protocols === 'string') {
      hasAudioStream = protocols.split(',').map(s => s.trim()).includes('audio-stream'); // string
    }
    console.log('WS_HANDLE_PROTOCOLS got=', protocols, '->', hasAudioStream ? 'audio-stream' : 'rejected');
    return hasAudioStream ? 'audio-stream' : false;
  }
});

wss.on('connection', async (ws, req) => {
  console.log('WS_CONNECTED', req.url);
  const sessionId = uuidv4();
  const state = { id: sessionId, caller: '', streamSid: '', fullTranscript: [] };
  let mediaCount = 0;

  const dgUrl = 'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&punctuate=true&model=enhanced';
  console.log('DG_CONNECT', dgUrl);
  const dg = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }});

  dg.on('open', () => console.log('DG_OPEN'));
  dg.on('error', (e) => console.error('DG_ERR', e.message));
  dg.on('message', async (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      const transcript = alt.transcript || '';
      if (msg.is_final && transcript) {
        state.fullTranscript.push(transcript);
        const reply = await llmReply(`Caller said: "${transcript}". Reply in one sentence as a helpful trades receptionist. Confirm details when you have enough info.`);
        const bytes = await ttsSynthesize(reply);
        console.log('TTS_REPLY_LEN', bytes.length);
        await wsSendMedia(ws, bytes, state.streamSid);
      }
    } catch {}
  });

  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'start') {
        state.caller = msg.start?.customParameters?.caller || '';
        state.streamSid = msg.start?.streamSid || '';
        console.log('TWILIO_START', state);
        const greet = await ttsSynthesize(`Hi, this is FirstRing A I for ${BUSINESS_NAME}. How can I help you today?`);
        console.log('TTS_GREETING_LEN', greet.length);
        await wsSendMedia(ws, greet, state.streamSid);
      }
      if (msg.event === 'media') {
        mediaCount++;
        if (dg.readyState === WebSocket.OPEN) dg.send(Buffer.from(msg.media?.payload || '', 'base64'));
        if (mediaCount % 50 === 0) console.log('TWILIO_MEDIA_IN', mediaCount);
      }
      if (msg.event === 'stop') {
        console.log('TWILIO_STOP');
        try { dg.close(); } catch {}
        const text = state.fullTranscript.join(' ');
        const fields = await llmExtract(text || 'Caller hung up quickly.');
        console.log('POST_LEAD', fields);
        if (N8N_BASE) {
          try {
            await axios.post(`${N8N_BASE.replace(/\/$/,'')}/webhook/receptionist/lead_finalized`, {
              ...fields,
              caller_number: state.caller,
              channel: 'voice',
              business_id: BUSINESS_ID,
              business_name: BUSINESS_NAME,
              calendar_summary_prefix: CAL_SUMMARY_PREFIX,
              transcript_url: '',
              booking_link: '',
              agent_session_id: sessionId
            }, { timeout: 8000 });
            console.log('N8N_POST_OK');
          } catch (e) {
            console.error('N8N_POST_ERR', e?.response?.status, e?.response?.data || e.message);
          }
        }
      }
    } catch (e) {
      console.error('WS_MSG_ERR', e.message);
    }
  });

  ws.on('close', () => console.log('WS_CLOSED'));
  ws.on('error', (e) => console.error('WS_ERR', e.message));
});

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  console.log('WS_UPGRADE', req.url, 'headers.protocol=', req.headers['sec-websocket-protocol']);
  if (req.url === '/stream') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log('FirstRing (Deepgram+11Labs/OpenAI fallback) on', PORT);
  console.log('ENV_CHECK', {
    PUBLIC_BASE_URL,
    HAVE_DG: !!DEEPGRAM_API_KEY,
    HAVE_OAI: !!OPENAI_API_KEY,
    HAVE_XI: !!ELEVENLABS_API_KEY,
    VOICE: ELEVENLABS_VOICE_ID
  });
});
