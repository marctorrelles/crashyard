// Email through Cloudflare Email Routing: the worker's send_email binding, to addresses verified in Email Routing.
import { EmailMessage } from 'cloudflare:email'
import type { Mailer } from './channels'

const header = (s: string) => s.replace(/[\r\n]+/g, ' ')
// Subjects can hold any character: RFC 2047's base64 form keeps them intact
const encodedWord = (s: string) => `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`

export function mime(from: string, to: string, subject: string, text: string, id = crypto.randomUUID()): string {
  const domain = from.split('@')[1] ?? 'crashyard'
  return [
    `From: crashyard <${header(from)}>`,
    `To: ${header(to)}`,
    `Subject: ${encodedWord(header(subject))}`,
    `Message-ID: <${id}@${domain}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text.replace(/\r?\n/g, '\r\n'),
  ].join('\r\n')
}

export function mailerOf(binding: SendEmail | undefined): Mailer | undefined {
  if (!binding) return undefined
  return {
    send: async (from, to, subject, text) => {
      await binding.send(new EmailMessage(from, to, mime(from, to, subject, text)))
    },
  }
}
