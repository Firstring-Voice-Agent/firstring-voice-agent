import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer, WebSocket } from 'ws';
import axios from 'axios';
import { XMLBuilder } from 'fast-xml-parser';
import http from 'http';

/* ========= ENV ========= */
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

/* ========= APP ========= */
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.get('/healthz', (_, res) => res.send('ok'));

/* --- optional Twilio signature check --- */
function verifyTwilio(req) {
  if (!TWILIO_AUTH_TOKEN) return true;
  const url = `${PUBLIC_BASE_URL}/twilio/voice`;
  const params = Object.keys(req.body).sort().map(k => k + req.body[k]).join('');
  const expected = crypto.createHmac('sha1', TWILIO_AUTH_TOKEN).update(url + params, 'utf8').digest('base64');
  const sig = req.headers['x-twilio-signature'];
  return sig === expected;
}

/* --- live TwiML: bidirectional stream --- */
app.post('/twilio/voice', (req, res) => {
  if (!verifyTwilio(req)) return res.status(403).send('Bad signature');

  const streamUrl = `${PUBLIC_BASE_URL.replace(/^http/, 'ws').replace(/\/$/, '')}/stream`;
  const xmlObj = {
    Response: {
      Connect: {
        Stream: {
          '@_url': streamUrl,
          '@_bidirectional': 'true',
          Parameter: [{ '@_name': 'caller', '@_value': req.body.From || '' }]
        }
      }
    }
  };
  const builder = new XMLBuilder({ ignoreAttributes: false });
  const xml = builder.build(xmlObj);
  res.set('Cache-Control', 'no-cache');
  res.type('text/xml').send(xml);
});

/* ========= TTS ========= */
// µ-law helper
function encodeLinearToMuLaw(sample) {
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// OpenAI fallback TTS (returns µ-law 8k)
async function ttsOpenAI(text) {
  if (!OPENAI_API_KEY) return new Uint8Array(0);
  try {
    const r = await axios.post('https://api.openai.com/v1/audio/speech', {
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: text
    }, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
    const pcm16 = new Int16Array(new Uint8Array(r.data).buffer);
    const step = 3; // ~24k -> ~8k
    const out = new Uint8Array(Math.floor(pcm16.length / step));
    for (let i = 0, j = 0; i < pcm16.length; i += step, j++) {
      const s = Math.max(-32768, Math.min(32767, pcm16[i]));
      out[j] = encodeLinearToMuLaw(s);
    }
    return out;
  } catch (e) {
    console.error('TTS_OPENAI_ERR', e?.response?.status, e?.response?.data || e.message);
    return new Uint8Array(0);
  }
}

// ElevenLabs primary -> OpenAI fallback (returns µ-law 8k)
async function ttsSynthesize(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return await ttsOpenAI(text);
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=4&output_format=ulaw_8000`;
  try {
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
    return new Uint8Array(r.data);
  } catch (e) {
    let body = '';
    try { body = Buffer.from(e?.response?.data || []).toString('utf8'); } catch {}
    console.error('TTS_11LABS_ERR', e?.response?.status, body || e.message);
    return await ttsOpenAI(text);
  }
}

/* ========= SEND AUDIO BACK (with streamSid, paced) ========= */
async function wsSendMedia(ws, mulawBytes, streamSid) {
  if (!streamSid) { console.error('TWILIO_NO_STREAMSID'); return; }
  const chunkSize = 160; // 20ms @ 8kHz
  for (let i = 0; i < mulawBytes.length; i += chunkSize) {
    const chunk = mulawBytes.slice(i, i + chunkSize);
    const msg = {
      event: 'media',
      streamSid,                   // REQUIRED
      media: { payload: Buffer.from(chunk).toString('base64') }
      // track not required for outbound; Twilio infers from streamSid
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    await sleep(20);
  }
}

/* ========= n8n (disabled unless set) ========= */
async function postLeadToN8N(lead) {
  if (!N8N_BASE || N8N_BASE.startsWith('https://<')) return;
  try {
    await axios.post(`${N8N_BASE.replace(/\/$/,'')}/webhook/receptionist/lead_finalized`, lead, { timeout: 8000 });
  } catch (e) {
    console.error('N8N_POST_ERR', e?.response?.data || e.message);
  }
}

/* ========= Brain (OpenAI) ========= */
async function llmReply(prompt, system = 'Stay concise. Ask only what you need to book a job.') {
  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
    return r.data.choices?.[0]?.message?.content?.trim() || 'Got it.';
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
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [{ role: 'system', content: 'You output only strict JSON.' }, { role: 'user', content: prompt }]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
    const raw = r.data.choices?.[0]?.message?.content?.trim() || '{}';
    return parseJsonLoose(raw) || { caller_name: '', suburb: '', job_type: '', urgency: 'this_week', preferred_time: '', call_summary: text.slice(0,800) };
  } catch (e) {
    console.error('LLM_EXTRACT_ERR', e?.response?.status, e?.response?.data || e.message);
    return { caller_name: '', suburb: '', job_type: '', urgency: 'this_week', preferred_time: '', call_summary: text.slice(0,800) };
  }
}

/* ========= WS BRIDGE (Twilio <-> Deepgram) ========= */
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', async (ws, req) => {
  console.log('WS_CONNECTED', req.url);
  const sessionId = uuidv4();
  const state = { id: sessionId, caller: '', streamSid: '', fullTranscript: [] };
  let mediaCount = 0;

  // Deepgram
  const dgUrl = 'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&punctuate=true&model=enhanced';
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
    } catch { /* ignore */ }
  });

  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'start') {
        state.caller = msg.start?.customParameters?.caller || '';
        state.streamSid = msg.start?.streamSid || '';
        console.log('TWILIO_START', { streamSid: state.streamSid, caller: state.caller });
        // greet only after we have streamSid
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
      console.error('WS_MSG_ERR', e.message);
    }
  });

  ws.on('close', () => console.log('WS_CLOSED'));
  ws.on('error', (e) => console.error('WS_ERR', e.message));
});

/* ========= HTTP -> WS upgrade ========= */
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/stream') {
    console.log('WS_UPGRADE', req.url);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else socket.destroy();
});

server.listen(PORT, () => console.log('FirstRing (Deepgram+11Labs/OpenAI fallback) on', PORT));
