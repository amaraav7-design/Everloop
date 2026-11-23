import { NextResponse, after } from 'next/server'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { verifyMetaWebhookSignature, verifyTokenMatches } from '@/lib/whatsapp/webhook-signature'
import { readCappedBody } from '@/lib/whatsapp/webhook-body'
import { processWebhook, whatsappWebhookDb, type WhatsAppWebhookPayload } from '@/lib/whatsapp/webhook-processor'
import { enqueueWebhookReceipt, processWebhookReceipt } from '@/lib/whatsapp/webhook-queue'

export const maxDuration = 60

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    // Fetch all whatsapp configs to check verify tokens
    const { data: configs, error: configError } = await whatsappWebhookDb()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (verifyTokenMatches(decrypt(config.verify_token), verifyToken)) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void whatsappWebhookDb()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  const rawBody = await readCappedBody(request)
  if (rawBody === null) return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  if (!verifyMetaWebhookSignature(rawBody, request.headers.get('x-hub-signature-256'))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: WhatsAppWebhookPayload
  try {
    body = JSON.parse(rawBody)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const db = whatsappWebhookDb()
  try {
    const key = await enqueueWebhookReceipt(db, rawBody, body)
    after(async () => {
      try {
        await processWebhookReceipt(db, processWebhook, key)
      } catch {
        console.error('[whatsapp webhook] immediate processing failed', key)
      }
    })
    return NextResponse.json({ status: 'received' }, { status: 200 })
  } catch {
    // Meta can retry this delivery because acceptance was never committed.
    return NextResponse.json({ error: 'Could not store delivery' }, { status: 503 })
  }
}
