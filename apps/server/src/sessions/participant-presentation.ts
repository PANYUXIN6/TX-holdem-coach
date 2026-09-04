export const USER_DISPLAY_NAME = '玩家'
export const USER_AVATAR_COLOR = '#0F766E'

export interface ParticipantPresentation {
  readonly displayName: string
  readonly avatarColor: string
}

export function projectParticipantPresentation(input: {
  readonly isUser: boolean
  readonly displayName?: string
  readonly avatarColor?: string
}): ParticipantPresentation {
  if (input.isUser) {
    return Object.freeze({
      displayName: USER_DISPLAY_NAME,
      avatarColor: USER_AVATAR_COLOR,
    })
  }
  if (
    typeof input.displayName !== 'string' ||
    input.displayName.trim().length === 0 ||
    typeof input.avatarColor !== 'string' ||
    input.avatarColor.trim().length === 0
  ) {
    throw new RangeError('Agent 展示身份无效。')
  }
  return Object.freeze({
    displayName: input.displayName,
    avatarColor: input.avatarColor,
  })
}
