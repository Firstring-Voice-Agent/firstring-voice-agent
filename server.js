import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer, WebSocket } from 'ws';
import axios from 'axios';
import { XMLBuilder } from 'fast-xml-parser';
import http from 'http';

/* ===== ENV ===== */
const {
  PORT = 8080,
  PUBLIC_BASE_URL,
  // Brain
  OPENAI_API_KEY,
  // ASR
  DEEPGRAM_API_KEY,
  // TTS primary
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  // optional sinks
  N8N_BASE,
  // caller-facing branding
  BUSINESS_ID = 'plumber_joes',
  BUSINESS_NAME = "Plumber Joe's",
  CAL_SUMMARY_PREFIX = 'Job',
  // optional Twilio signature check
  TWILIO_AUTH_TOKEN
} = process.env;

/* ===== APP & UTILS ===== */
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.get('/healthz', (_, res) => res.send('ok'));

/* ===== Twilio signature (optional) ===== */
function verifyTwilio(req) {
  if (!TWILIO_AUTH_TOKEN) return true;
  const url = `${PUBLIC_BASE_URL}/twilio/voice`;
  const params = Object.keys(req.body).sort().map(k => k + req.body[k]).join('');
  const expected = crypto.createHmac('sha1', TWILIO_AUTH_TOKEN).update(url + params, 'utf8').digest('base64');
  const sig = req.headers['x-twilio-signature'];
  return sig === expected;
}

/* ===== Live TwiML with bidirectional stream ===== */
app.post('/twilio/voice', (req, res) => {
  if (!verifyTwilio(req)) return res.status(403).send('Bad signature');

  // Twilio must get wss:// for Media Streams
  const streamUrl = `${PUBLIC_BASE_URL.replace(/^http/, 'ws').replace(/\/$/, '')}/stream`;

  const xmlObj = {
    Response: {
      Connect: {
        Stream: {
          '@_url': streamUrl,
          '@_bidirectional': 'true', // ← critical for sending audio back
          Parameter: [{ '@_name': 'caller', '@_value': req.body.From || '' }]
        }
      }
    }
  };

  const builder = new XMLBuilder({ ignoreAttributes: false });
  res.type('text/xml').send(builder.build(xmlObj));
});

/* ===== TTS: OpenAI fallback (μ-law helper) ===== */
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
    const r = await axios.post('https://api.openai.com/v1/audio/speech', {
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: text
    }, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});

    // naive 24k -> ~8k downsample (skip)
    const pcm16 = new Int16Array(new Uint8Array(r.data).buffer);
    const step = 3;
    const mulaw = new Uint8Array(Math.floor(pcm16.length / step));
    for (let i = 0, j = 0; i < pcm16.length; i += step, j++) {
      const s = Math.max(-32768, Math.min(32767, pcm16[i]));
      mulaw[j] = encodeLinearToMuLaw(s);
    }
    return mulaw;
  } catch (e) {
    console.error('OpenAI TTS error', e?.response?.status, e?.response?.data || e.message);
    return new Uint8Array(0);
  }
}

/* ===== TTS: ElevenLabs primary → OpenAI fallback ===== */
async function ttsSynthesize(text) {
  // If ElevenLabs not configured, skip to OpenAI
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return await ttsOpenAI(text);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=4&output_format=ulaw_8000`;
  try {
    const r = await axios.post(
      url,
      {
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.65,
          similarity_boost: 0.78,
          style: 0.28,
          use_speaker_boost: true
        }
      },
      { responseType: 'arraybuffer', headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'content-type': 'application/json' } }
    );

    const ct = (r.headers?.['content-type'] || '').toLowerCase();
    if (ct.includes('application/json')) {
      const txt = Buffer.from(r.data).toString('utf8');
      console.error('ElevenLabs TTS JSON (error):', txt);
      return await ttsOpenAI(text);
    }
    return new Uint8Array(r.data);
  } catch (e) {
    let status = e?.response?.status;
    let body = '';
    try { body = Buffer.from(e?.response?.data || []).toString('utf8'); } catch {}
    console.error('ElevenLabs TTS error', status, body || e.message);
    return await ttsOpenAI(text);
  }
}

/* ===== Send audio back to Twilio (paced, with streamSid) ===== */
async function wsSendMedia(ws, mulawBytes, streamSid) {
  if (!streamSid) { console.error('No streamSid; cannot send audio'); return; }
  const chunkSize = 160; // 20ms @ 8kHz
  for (let i = 0; i < mulawBytes.length; i += chunkSize) {
    const chunk = mulawBytes.slice(i, i + chunkSize);
    const msg = {
      event: 'media',
      streamSid, // REQUIRED for bidirectional streams
      media: { payload: Buffer.from(chunk).toString('base64') }
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    await sleep(20); // pace frames
  }
}

/* ===== n8n sink (optional) ===== */
async function postLeadToN8N(lead) {
  if (!N8N_BASE || N8N_BASE.startsWith('https://<')) return; // ignore placeholder
  try {
    await axios.post(`${N8N_BASE.replace(/\/$/,'')}/webhook/receptionist/lead_finalized`, lead, { timeout: 8000 });
  } catch (e) { console.error('n8n post error', e?.response?.data || e.message); }
}

/* ===== Brain (OpenAI) ===== */
async function llmReply(prompt, system = 'Stay concise. Ask only what you need to book a job.') {
  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
    return r.data.choices?.[0]?.message?.content?.trim() || 'Got it.';
  } catch (e) {
    console.error('LLM reply error', e?.response?.status, e?.response?.data || e.message);
    return 'Okay.';
  }
}

function parseJsonLoose(text) {
  if (!text) return null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

async function llmExtract(text) {
  const prompt = `Extract strict JSON with fields:
  caller_name, suburb, job_type, urgency(one of: now,today,this_week,no_rush), preferred_time, call_summary.
  Only return JSON. Message:\n${text}`;
  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: 'You output only strict JSON.' },
        { role: 'user', content: prompt }
      ]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
    const raw = r.data.choices?.[0]?.message?.content?.trim() || '{}';
    return parseJsonLoose(raw) || { caller_name: '', suburb: '', job_type: '', urgency: 'this_week', preferred_time: '', call_summary: text.slice(0, 800) };
  } catch (e) {
    console.error('llmExtract error', e?.response?.status, e?.response?.data || e.message);
    return { caller_name: '', suburb: '', job_type: '', urgency: 'this_week', preferred_time: '', call_summary: text.slice(0, 800) };
  }
}

/* ===== WebSocket bridge (Twilio <-> Deepgram) ===== */
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', async (ws, req) => {
  const sessionId = uuidv4();
  const state = { id: sessionId, caller: '', streamSid: '', fullTranscript: [] };

  // Deepgram streaming ASR (μ-law 8kHz)
  const dgUrl = 'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&punctuate=true&model=enhanced';
  const dg = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }});

  async function speak(text) {
    const bytes = await ttsSynthesize(text);
    if (bytes?.length) await wsSendMedia(ws, bytes, state.streamSid);
  }

  dg.on('message', async (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      const transcript = alt.transcript || '';
      if (msg.is_final && transcript) {
        state.fullTranscript.push(transcript);
        const reply = await llmReply(
          `Caller said: "${transcript}". Reply in one sentence as a helpful trades receptionist. Confirm details when you have enough info.`
        );
        await speak(reply);
      }
    } catch { /* ignore non-JSON frames */ }
  });

  dg.on('error', (e) => console.error('Deepgram WS error', e.message));

  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'start') {
        state.caller = msg.start?.customParameters?.caller || '';
        state.streamSid = msg.start?.streamSid || '';
        // greet only when we have streamSid so audio can go out
        await speak(`Hi, this is FirstRing AI for ${BUSINESS_NAME}. How can I help you today?`);
      }
      if (msg.event === 'media') {
        const b64 = msg.media?.payload;
        if (b64 && dg.readyState === WebSocket.OPEN) {
          dg.send(Buffer.from(b64, 'base64')); // raw μ-law bytes to Deepgram
        }
      }
      if (msg.event === 'stop') {
        const text = state.fullTranscript.join(' ');
        const fields = await llmExtract(text || 'Caller hung up quickly.');
        const lead = {
          ...fields,
          caller_number: state.caller,
          channel: 'voice',
          business_id: BUSINESS_ID,
          business_name: BUSINESS_NAME,
          calendar_summary_prefix: CAL_SUMMARY_PREFIX,
          transcript_url: '',
          booking_link: '',
          agent_session_id: sessionId
        };
        await postLeadToN8N(lead);
        try { dg.close(); } catch {}
      }
    } catch (e) {
      console.error('WS message error', e.message);
    }
  });

  ws.on('close', () => { try { dg.close(); } catch {} });
});

/* ===== Upgrade HTTP -> WebSocket at /stream ===== */
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/stream') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else socket.destroy();
});

server.listen(PORT, () => console.log('FirstRing (Deepgram+11Labs/OpenAI fallback) on', PORT));
