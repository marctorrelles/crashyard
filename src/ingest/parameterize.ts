// A message or exception value as grouping v2 compares it, ported from Sentry 24.10.0
// (`src/sentry/grouping/strategies/message.py` and `parameterization.py`, getsentry/sentry, Apache-2.0 since 2026-10-15
// under its FSL-1.1-Apache-2.0 license): at most its first two non-empty lines, and what changes from one event to
// the next replaced by its kind, `<email>`, `<url>`, `<int>`… Sentry's unique-id experiment, on only for its own
// projects, isn't ported. Grouping v1 keeps `mask` (grouping.ts).

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
const DAY = '(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)'
const ZONE = '(?:UT|GMT|(?:E|C|M|P)(?:ST|DT)|[A-IK-Z])'
const IP4 = '(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])'
const H = '[0-9a-fA-F]{1,4}'

// In Sentry's order, as one regular expression: the first that matches at a place names it
const PATTERNS: [string, string][] = [
  ['email', "[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*"],
  ['url', '\\b(?:wss?|https?|ftp)://[^\\s/$.?#].[^\\s]*'],
  [
    'hostname',
    '\\b(?:[a-zA-Z0-9\\-]{1,63}\\.)+?(?:(?:COM|NET|ORG|JP|DE|UK|FR|BR|IT|RU|ES|ME|GOV|PL|CA|AU|CN|CO|IN|NL|EDU|INFO|EU|CH|ID|AT|KR|CZ|MX|BE|TV|SE|TR|TW|AL|UA|IR|VN|CL|SK|LY|CC|TO|NO|FI|US|PT|DK|AR|HU|TK|GR|IL|NEWS|RO|MY|BIZ|IE|ZA|NZ|SG|EE|TH|IO|XYZ|PE|BG|HK|RS|LT|LINK|PH|CLUB|SI|SITE|MOBI|BY|CAT|WIKI|LA|GA|XXX|CF|HR|NG|JOBS|ONLINE|KZ|UG|GQ|AE|IS|LV|PRO|FM|TIPS|MS|SA|APP)|(?:com|net|org|jp|de|uk|fr|br|it|ru|es|me|gov|pl|ca|au|cn|co|in|nl|edu|info|eu|ch|id|at|kr|cz|mx|be|tv|se|tr|tw|al|ua|ir|vn|cl|sk|ly|cc|to|no|fi|us|pt|dk|ar|hu|tk|gr|il|news|ro|my|biz|ie|za|nz|sg|ee|th|io|xyz|pe|bg|hk|rs|lt|link|ph|club|si|site|mobi|by|cat|wiki|la|ga|xxx|cf|hr|ng|jobs|online|kz|ug|gq|ae|is|lv|pro|fm|tips|ms|sa|app))\\b',
  ],
  [
    'ip',
    `(?:(?:${H}:){7,7}${H}|(?:${H}:){1,7}:|(?:${H}:){1,6}:${H}|(?:${H}:){1,5}(?::${H}){1,2}|(?:${H}:){1,4}(?::${H}){1,3}|(?:${H}:){1,3}(?::${H}){1,4}|(?:${H}:){1,2}(?::${H}){1,5}|${H}:(?:(?::${H}){1,6})|:(?:(?::${H}){1,7}|:)|fe80:(?::[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(?:ffff(?::0{1,4}){0,1}:){0,1}(?:${IP4}\\.){3,3}${IP4}|(?:${H}:){1,4}:(?:${IP4}\\.){3,3}${IP4}\\b)|(?:\\b(?:${IP4}\\.){3,3}${IP4}\\b)`,
  ],
  ['uuid', '\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b'],
  ['sha1', '\\b[0-9a-fA-F]{40}\\b'],
  ['md5', '\\b[0-9a-fA-F]{32}\\b'],
  [
    'date',
    [
      // RFC822, RFC1123, RFC1123Z
      `(?:${DAY},\\s\\d{1,2}\\s${MONTH}\\s\\d{2,4}\\s\\d{1,2}:\\d{1,2}(?::\\d{1,2})?\\s(?:[-+][\\d]{2}[0-5][\\d]|${ZONE}))`,
      // "Mon Jan 02, 1999", "Jan 02, 1999"
      `(?:(?:${DAY}\\s)?${MONTH}\\s[0-3]\\d,\\s\\d{2,4})`,
      // RFC850
      `(?:(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),\\s\\d{2}-${MONTH}-\\d{2}\\s\\d{2}:\\d{2}:\\d{2}\\s${ZONE})`,
      // RFC3339, RFC3339Nano
      '(?:\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z?(?:[+-]?\\d{2}:\\d{2})?)',
      // Datetime
      '(?:\\d{4}-?[01]\\d-?[0-3]\\d\\s[0-2]\\d:[0-5]\\d:[0-5]\\d)(?:\\.\\d+)?',
      // Kitchen
      '(?:\\d{1,2}:\\d{2}(?::\\d{2})?(?: [aApP][Mm])?)',
      // Date
      '(?:\\d{4}-[01]\\d-[0-3]\\d)',
      // Time
      '(?:[0-2]\\d:[0-5]\\d:[0-5]\\d)',
      '(?:(?:\\d{4}-[01]\\d-[0-3]\\dT[0-2]\\d:[0-5]\\d:[0-5]\\d\\.\\d+(?:[+-][0-2]\\d:[0-5]\\d|Z))|(?:\\d{4}-[01]\\d-[0-3]\\dT[0-2]\\d:[0-5]\\d:[0-5]\\d(?:[+-][0-2]\\d:[0-5]\\d|Z))|(?:\\d{4}-[01]\\d-[0-3]\\dT[0-2]\\d:[0-5]\\d(?:[+-][0-2]\\d:[0-5]\\d|Z)))',
      `(?:\\b(?:${DAY}\\s+)?${MONTH}\\s+(?:[\\d]{1,2})\\s+(?:[\\d]{2}:[\\d]{2}:[\\d]{2})\\s+[\\d]{4})`,
      `(?:\\b(?:${DAY},\\s+)?(?:0[1-9]|[1-2]?[\\d]|3[01])\\s+${MONTH}\\s+(?:19[\\d]{2}|[2-9][\\d]{3})\\s+(?:2[0-3]|[0-1][\\d]):(?:[0-5][\\d])(?::(?:60|[0-5][\\d]))?\\s+(?:[-+][\\d]{2}[0-5][\\d]|${ZONE}))`,
      '(?:datetime\\.datetime\\(.*?\\))',
    ].join('|'),
  ],
  ['duration', '\\b(?:\\d+ms)|(?:\\d+(?:\\.\\d+)?s)\\b'],
  ['hex', '\\b0[xX][0-9a-fA-F]+\\b'],
  ['float', '-\\d+\\.\\d+\\b|\\b\\d+\\.\\d+\\b'],
  ['int', '-\\d+\\b|\\b\\d+\\b'],
  // Only the value of a key=value pair
  ['quoted_str', `(?<==)(?:'(?:[^']+)'|"(?:[^"]+)")`],
  ['bool', '(?<==)(?:True|true|False|false)'],
]
const NAMES = PATTERNS.map(([name]) => name)
const ALL = new RegExp(PATTERNS.map(([name, p]) => `(?<${name}>${p})`).join('|'), 'g')

/** `text` as grouping compares it: two lines at most, its variable parts replaced (`normalize_message_for_grouping`) */
export function parameterize(text: string): string {
  const lines = text.split(/\r\n|\r|\n/, 1000).filter((l) => l.trim())
  // crashyard: 1,000 characters at most. Some of Sentry's patterns rescan a long run from every place in it, so a
  // value of 100 KB would cost seconds
  let trimmed = lines.slice(0, 2).join('\n').slice(0, 1000)
  if (trimmed !== text) trimmed += '...'
  return trimmed.replace(ALL, (...args) => {
    const groups = args.at(-1) as Record<string, string | undefined>
    return `<${NAMES.find((n) => groups[n] !== undefined)}>`
  })
}
