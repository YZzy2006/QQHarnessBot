export class AuthError extends Error {}

/** Preserve the old JSON format; reject header injection before any network request. */
export function parseManualCookie(input = {}) {
  const pick = (raw, key) => {
    const value = String(raw ?? '').trim()
    const match = value.match(new RegExp('(?:^|;)\\s*' + key + '=([^;]+)', 'i'))
    return (match ? match[1] : value.replace(new RegExp('^' + key + '\\s*=', 'i'), ''))
      .replace(/^["'\s]+|["';\s]+$/g, '').trim()
  }
  const credentials = {
    sessdata: pick(input.sessdata, 'SESSDATA'),
    bili_jct: pick(input.bili_jct, 'bili_jct'),
    buvid3: pick(input.buvid3, 'buvid3'),
  }
  if (credentials.sessdata.length < 20 || credentials.sessdata.length > 8192
    || !/^[0-9a-fA-F]{32}$/.test(credentials.bili_jct)
    || Object.values(credentials).some(value => /[\r\n;\x00-\x1f\x7f]/.test(value) || value.length > 8192))
    throw new AuthError('凭据不完整或格式无效，请重新扫码，或检查 SESSDATA 与 bili_jct。')
  return credentials
}

