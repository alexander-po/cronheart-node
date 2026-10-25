const HEX_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

const HEX_COMPACT = '[0-9a-f]{32}'

export const UUID_WHOLE = /*#__PURE__*/ new RegExp(`^${HEX_UUID}$`, 'i')

const UUID_SEGMENT = /*#__PURE__*/ new RegExp(`/${HEX_UUID}(?=/|$)`, 'gi')

export function hideIdentifierSegments(path: string): string {
  return path.replace(UUID_SEGMENT, '/{uuid}')
}

const HEX_UUID_DASH_LIKE = ['{8}', '{4}', '{4}', '{4}', '{12}'].map((count) => `[0-9a-f]${count}`).join('[-\\u2011\\u2013]')

export const IDENTIFIER_SHAPED = /*#__PURE__*/ new RegExp(
  `${HEX_UUID_DASH_LIKE}|(?<![0-9a-f])${HEX_COMPACT}(?![0-9a-f])`,
  'i',
)
