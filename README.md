# FirstRing AI — Realtime Voice Agent (Deepgram ASR)

This build includes **Deepgram streaming ASR** + OpenAI TTS, Twilio Media Streams (bidirectional), and n8n lead posting.

## Quick Deploy
1) `cp .env.example .env` and fill values.
2) `npm i`
3) `npm run start`
4) Twilio → Number → Voice → Webhook (POST): `https://YOUR-DOMAIN/twilio/voice`
5) n8n lead sink: `POST https://YOUR-N8N/webhook/receptionist/lead_finalized`

## Env
- `OPENAI_API_KEY` — OpenAI for replies & TTS
- `DEEPGRAM_API_KEY` — Deepgram live ASR
- `N8N_BASE` — your n8n base URL
- `PUBLIC_BASE_URL` — this service public URL
- `TWILIO_AUTH_TOKEN` — optional signature verify
- `BUSINESS_ID`, `BUSINESS_NAME`, `CAL_SUMMARY_PREFIX` — defaults for n8n payload
